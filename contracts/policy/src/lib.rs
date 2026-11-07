/*!
Payables policy contract.

Holds a company's USDC treasury and decides what the AI agent may pay:
  - only the agent can request payments, and only to allowlisted payees;
  - an invoice hash (sha256 of the PDF) or invoice id can only be used once;
  - invoices at or below `auto_pay_limit` are paid immediately while the UTC day's auto-paid
    total stays within `daily_cap`;
  - everything else becomes a Sputnik DAO v2 proposal that calls `release_payment` when approved.

Payments are `ft_transfer`s on the USDC contract followed by `on_transfer_complete`, which marks
the invoice `paid` or `failed` (rolling back the daily spend and freeing the invoice hash).
*/
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::storage_management::ext_storage_management;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, log, near, require,
};

mod events;
mod external;

use events::PayablesEvent;
use external::{ActionCall, DaoPolicy, ProposalInput, ProposalKind, ext_dao};

const NANOS_PER_DAY: u64 = 86_400 * 1_000_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Attached to `storage_deposit` with `registration_only`; the USDC contract refunds the excess.
const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FOR_GET_POLICY: Gas = Gas::from_tgas(10);
const GAS_FOR_ADD_PROPOSAL: Gas = Gas::from_tgas(30);
const GAS_FOR_ON_PROPOSAL_ADDED: Gas = Gas::from_tgas(10);
/// Covers the callback itself plus the `add_proposal` call and its callback.
const GAS_FOR_ON_DAO_POLICY: Gas = Gas::from_tgas(55);
/// Gas the DAO attaches when it executes an approved `release_payment` proposal.
const GAS_FOR_RELEASE_PAYMENT: Gas = Gas::from_tgas(50);
/// Gas the DAO attaches when it executes an approved `approve_payee_change` proposal.
const GAS_FOR_APPROVE_PAYEE_CHANGE: Gas = Gas::from_tgas(30);

const MAX_ID_LEN: usize = 128;
const MAX_NAME_LEN: usize = 128;
const MAX_DUE_DATE_LEN: usize = 64;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Payees,
    PendingPayeeChanges,
    Invoices,
    PaidHashes,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvoiceStatus {
    PendingApproval,
    Paying,
    Paid,
    Failed,
    Rejected,
}

/// Why an invoice was sent to the DAO instead of being auto-paid.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscalationReason {
    OverAutoPayLimit,
    DailyCapExceeded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub invoice_id: String,
    pub payee: AccountId,
    pub amount: U128,
    /// Lowercase hex sha256 of the invoice PDF.
    pub invoice_hash: String,
    pub due_date: String,
    pub status: InvoiceStatus,
    /// Sputnik DAO proposal id, set once an escalated invoice has its proposal.
    pub proposal_id: Option<u64>,
    pub failure_reason: Option<String>,
    /// Block timestamps in nanoseconds.
    pub created_at: U64,
    pub updated_at: U64,
    /// UTC day whose daily spend this payment was charged to (auto-paid invoices only).
    #[serde(skip)]
    charged_day: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payee {
    pub name: String,
    pub registered_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingPayeeChange {
    pub new_account_id: AccountId,
    pub proposal_id: Option<u64>,
    pub requested_at: U64,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner_id: AccountId,
    pub agent_id: AccountId,
    pub dao_id: AccountId,
    pub usdc_id: AccountId,
    pub auto_pay_limit: U128,
    pub daily_cap: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    agent_id: AccountId,
    dao_id: AccountId,
    usdc_id: AccountId,
    auto_pay_limit: u128,
    daily_cap: u128,
    /// UTC day (days since the Unix epoch) that `daily_spent` refers to.
    spent_day: u64,
    daily_spent: u128,
    payees: LookupMap<AccountId, Payee>,
    /// Keyed by the current (old) payee account.
    pending_payee_changes: LookupMap<AccountId, PendingPayeeChange>,
    invoices: LookupMap<String, Invoice>,
    /// Hashes of invoices that are paid or in flight. Freed again if a payment fails.
    paid_hashes: LookupSet<String>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        agent_id: AccountId,
        dao_id: AccountId,
        usdc_id: AccountId,
        auto_pay_limit: U128,
        daily_cap: U128,
    ) -> Self {
        Self {
            owner_id,
            agent_id,
            dao_id,
            usdc_id,
            auto_pay_limit: auto_pay_limit.0,
            daily_cap: daily_cap.0,
            spent_day: 0,
            daily_spent: 0,
            payees: LookupMap::new(StorageKey::Payees),
            pending_payee_changes: LookupMap::new(StorageKey::PendingPayeeChanges),
            invoices: LookupMap::new(StorageKey::Invoices),
            paid_hashes: LookupSet::new(StorageKey::PaidHashes),
        }
    }

    // ---------------------------------------------------------------------------------------
    // Agent
    // ---------------------------------------------------------------------------------------

    /// Pays an invoice right away or escalates it to the DAO.
    ///
    /// Resolves to the resulting `Invoice`: `paid`/`failed` when auto-paid, `pending_approval`
    /// with `proposal_id` set when escalated. A failed invoice id may be requested again.
    pub fn request_payment(
        &mut self,
        invoice_id: String,
        payee: AccountId,
        amount: U128,
        invoice_hash: String,
        due_date: String,
    ) -> PromiseOrValue<Invoice> {
        require!(
            env::predecessor_account_id() == self.agent_id,
            "Only the agent can request payments"
        );
        require!(
            !invoice_id.is_empty() && invoice_id.len() <= MAX_ID_LEN,
            "Invalid invoice_id"
        );
        require!(due_date.len() <= MAX_DUE_DATE_LEN, "Invalid due_date");
        require!(amount.0 > 0, "Amount must be positive");
        require!(
            self.payees.contains_key(&payee),
            "Payee is not on the allowlist"
        );
        let invoice_hash = normalize_hash(&invoice_hash);
        require!(
            !self.paid_hashes.contains(&invoice_hash),
            "Invoice hash has already been used"
        );
        if let Some(existing) = self.invoices.get(&invoice_id) {
            require!(
                existing.status == InvoiceStatus::Failed,
                "Invoice id already exists"
            );
        }

        let now = env::block_timestamp();
        let today = now / NANOS_PER_DAY;
        let escalation = if amount.0 > self.auto_pay_limit {
            Some(EscalationReason::OverAutoPayLimit)
        } else if self
            .spent_on(today)
            .checked_add(amount.0)
            .is_none_or(|total| total > self.daily_cap)
        {
            Some(EscalationReason::DailyCapExceeded)
        } else {
            None
        };

        PayablesEvent::PaymentRequested {
            invoice_id: &invoice_id,
            payee: &payee,
            amount,
            invoice_hash: &invoice_hash,
            auto_pay: escalation.is_none(),
        }
        .emit();

        self.paid_hashes.insert(invoice_hash.clone());
        let mut invoice = Invoice {
            invoice_id: invoice_id.clone(),
            payee,
            amount,
            invoice_hash,
            due_date,
            status: InvoiceStatus::PendingApproval,
            proposal_id: None,
            failure_reason: None,
            created_at: U64(now),
            updated_at: U64(now),
            charged_day: None,
        };

        match escalation {
            None => {
                self.charge_daily_spend(today, amount.0);
                invoice.status = InvoiceStatus::Paying;
                invoice.charged_day = Some(today);
                let promise = self.transfer(&invoice);
                self.invoices.insert(invoice_id, invoice);
                promise.into()
            }
            Some(reason) => {
                self.invoices.insert(invoice_id.clone(), invoice);
                ext_dao::ext(self.dao_id.clone())
                    .with_static_gas(GAS_FOR_GET_POLICY)
                    .get_policy()
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_FOR_ON_DAO_POLICY)
                            .on_invoice_dao_policy(invoice_id, reason),
                    )
                    .into()
            }
        }
    }

    // ---------------------------------------------------------------------------------------
    // DAO
    // ---------------------------------------------------------------------------------------

    /// Pays an invoice that is waiting for approval. Called by the DAO when the proposal passes.
    pub fn release_payment(&mut self, invoice_id: String) -> Promise {
        require!(
            env::predecessor_account_id() == self.dao_id,
            "Only the DAO can release payments"
        );
        let invoice = self
            .invoices
            .get_mut(&invoice_id)
            .expect("Invoice not found");
        require!(
            invoice.status == InvoiceStatus::PendingApproval,
            "Invoice is not pending approval"
        );
        require!(
            self.payees.contains_key(&invoice.payee),
            "Payee is no longer on the allowlist"
        );
        invoice.status = InvoiceStatus::Paying;
        invoice.updated_at = U64(env::block_timestamp());
        let invoice = invoice.clone();
        self.transfer(&invoice)
    }

    /// Rejects an invoice that is waiting for approval. Its hash stays used.
    pub fn reject_payment(&mut self, invoice_id: String) -> Invoice {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.dao_id || caller == self.owner_id,
            "Only the DAO or the owner can reject payments"
        );
        let invoice = self
            .invoices
            .get_mut(&invoice_id)
            .expect("Invoice not found");
        require!(
            invoice.status == InvoiceStatus::PendingApproval,
            "Invoice is not pending approval"
        );
        invoice.status = InvoiceStatus::Rejected;
        invoice.updated_at = U64(env::block_timestamp());

        PayablesEvent::PaymentRejected {
            invoice_id: &invoice.invoice_id,
            payee: &invoice.payee,
            amount: invoice.amount,
            rejected_by: &caller,
        }
        .emit();
        invoice.clone()
    }

    /// Replaces payee `old` with `new`, keeping its name. Called by the DAO when the
    /// proposal opened by `request_payee_change` passes.
    pub fn approve_payee_change(&mut self, old: AccountId, new: AccountId) -> Promise {
        require!(
            env::predecessor_account_id() == self.dao_id,
            "Only the DAO can approve payee changes"
        );
        let pending = self
            .pending_payee_changes
            .remove(&old)
            .expect("No pending change for this payee");
        require!(
            pending.new_account_id == new,
            "New account does not match the pending change"
        );
        require!(
            !self.payees.contains_key(&new),
            "New account is already a payee"
        );
        let payee = self.payees.remove(&old).expect("Payee not found");
        self.payees.insert(
            new.clone(),
            Payee {
                name: payee.name,
                registered_at: U64(env::block_timestamp()),
            },
        );

        PayablesEvent::PayeeChanged {
            old: &old,
            new: &new,
        }
        .emit();
        self.register_storage(new)
    }

    /// Drops a pending payee change. The DAO proposal, if approved later, will fail.
    pub fn reject_payee_change(&mut self, old: AccountId) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.dao_id || caller == self.owner_id,
            "Only the DAO or the owner can reject payee changes"
        );
        require!(
            self.pending_payee_changes.remove(&old).is_some(),
            "No pending change for this payee"
        );
    }

    // ---------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------

    /// Allowlists a payee and registers it for storage on the USDC contract.
    /// The storage deposit is paid from this contract's NEAR balance.
    pub fn register_payee(&mut self, account_id: AccountId, name: String) -> Promise {
        self.assert_owner();
        require!(
            !name.is_empty() && name.len() <= MAX_NAME_LEN,
            "Invalid payee name"
        );
        require!(
            !self.payees.contains_key(&account_id),
            "Payee is already registered"
        );
        self.payees.insert(
            account_id.clone(),
            Payee {
                name: name.clone(),
                registered_at: U64(env::block_timestamp()),
            },
        );

        PayablesEvent::PayeeRegistered {
            account_id: &account_id,
            name: &name,
        }
        .emit();
        self.register_storage(account_id)
    }

    /// Opens a DAO proposal to replace payee `old` with `new`.
    /// Resolves to the `PendingPayeeChange`, or `null` if the proposal could not be created.
    pub fn request_payee_change(&mut self, old: AccountId, new: AccountId) -> Promise {
        self.assert_owner();
        require!(old != new, "Accounts must differ");
        require!(self.payees.contains_key(&old), "Payee not found");
        require!(
            !self.payees.contains_key(&new),
            "New account is already a payee"
        );
        require!(
            !self.pending_payee_changes.contains_key(&old),
            "A change for this payee is already pending"
        );
        self.pending_payee_changes.insert(
            old.clone(),
            PendingPayeeChange {
                new_account_id: new,
                proposal_id: None,
                requested_at: U64(env::block_timestamp()),
            },
        );

        ext_dao::ext(self.dao_id.clone())
            .with_static_gas(GAS_FOR_GET_POLICY)
            .get_policy()
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_DAO_POLICY)
                    .on_payee_change_dao_policy(old),
            )
    }

    pub fn set_limits(&mut self, auto_pay_limit: U128, daily_cap: U128) {
        self.assert_owner();
        self.auto_pay_limit = auto_pay_limit.0;
        self.daily_cap = daily_cap.0;
        PayablesEvent::LimitsUpdated {
            auto_pay_limit,
            daily_cap,
        }
        .emit();
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    pub fn get_invoice(&self, invoice_id: String) -> Option<Invoice> {
        self.invoices.get(&invoice_id).cloned()
    }

    pub fn get_payee(&self, account_id: AccountId) -> Option<Payee> {
        self.payees.get(&account_id).cloned()
    }

    pub fn get_pending_payee_change(&self, old: AccountId) -> Option<PendingPayeeChange> {
        self.pending_payee_changes.get(&old).cloned()
    }

    /// Whether an invoice hash is paid or in flight (i.e. `request_payment` would reject it).
    pub fn is_hash_used(&self, invoice_hash: String) -> bool {
        self.paid_hashes.contains(&normalize_hash(&invoice_hash))
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner_id: self.owner_id.clone(),
            agent_id: self.agent_id.clone(),
            dao_id: self.dao_id.clone(),
            usdc_id: self.usdc_id.clone(),
            auto_pay_limit: U128(self.auto_pay_limit),
            daily_cap: U128(self.daily_cap),
        }
    }

    /// Total auto-paid during the current UTC day.
    pub fn get_daily_spent(&self) -> U128 {
        U128(self.spent_on(env::block_timestamp() / NANOS_PER_DAY))
    }

    // ---------------------------------------------------------------------------------------
    // Callbacks
    // ---------------------------------------------------------------------------------------

    #[private]
    pub fn on_transfer_complete(
        &mut self,
        invoice_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Invoice {
        if result.is_err() {
            return self.fail_invoice(&invoice_id, "USDC transfer failed");
        }
        let invoice = self
            .invoices
            .get_mut(&invoice_id)
            .expect("Invoice not found");
        invoice.status = InvoiceStatus::Paid;
        invoice.updated_at = U64(env::block_timestamp());

        PayablesEvent::PaymentPaid {
            invoice_id: &invoice.invoice_id,
            payee: &invoice.payee,
            amount: invoice.amount,
        }
        .emit();
        invoice.clone()
    }

    #[private]
    pub fn on_invoice_dao_policy(
        &mut self,
        invoice_id: String,
        reason: EscalationReason,
        #[callback_result] policy: Result<DaoPolicy, PromiseError>,
    ) -> PromiseOrValue<Invoice> {
        let Ok(policy) = policy else {
            return PromiseOrValue::Value(
                self.fail_invoice(&invoice_id, "Could not read DAO policy"),
            );
        };
        let bond = NearToken::from_yoctonear(policy.proposal_bond.0);
        if !self.can_afford(bond) {
            return PromiseOrValue::Value(
                self.fail_invoice(&invoice_id, "Not enough NEAR to pay the DAO proposal bond"),
            );
        }
        let invoice = self.invoices.get(&invoice_id).expect("Invoice not found");
        let description = format!(
            "Payables: pay {} USDC to {} for invoice {} ({}). Invoice sha256: {}",
            format_usdc(invoice.amount.0),
            invoice.payee,
            invoice.invoice_id,
            match reason {
                EscalationReason::OverAutoPayLimit => "over the auto-pay limit",
                EscalationReason::DailyCapExceeded => "daily cap reached",
            },
            invoice.invoice_hash,
        );
        let args = json!({ "invoice_id": invoice_id });

        self.add_dao_proposal(
            bond,
            description,
            "release_payment",
            args,
            GAS_FOR_RELEASE_PAYMENT,
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PROPOSAL_ADDED)
                .on_invoice_proposal_added(invoice_id, reason),
        )
        .into()
    }

    #[private]
    pub fn on_invoice_proposal_added(
        &mut self,
        invoice_id: String,
        reason: EscalationReason,
        #[callback_result] proposal_id: Result<u64, PromiseError>,
    ) -> Invoice {
        let Ok(proposal_id) = proposal_id else {
            return self.fail_invoice(&invoice_id, "Could not create the DAO proposal");
        };
        let invoice = self
            .invoices
            .get_mut(&invoice_id)
            .expect("Invoice not found");
        invoice.proposal_id = Some(proposal_id);
        invoice.updated_at = U64(env::block_timestamp());

        PayablesEvent::PaymentEscalated {
            invoice_id: &invoice.invoice_id,
            payee: &invoice.payee,
            amount: invoice.amount,
            dao_id: &self.dao_id,
            proposal_id,
            reason,
        }
        .emit();
        invoice.clone()
    }

    #[private]
    pub fn on_payee_change_dao_policy(
        &mut self,
        old: AccountId,
        #[callback_result] policy: Result<DaoPolicy, PromiseError>,
    ) -> PromiseOrValue<Option<PendingPayeeChange>> {
        let bond = match policy {
            Ok(policy) => NearToken::from_yoctonear(policy.proposal_bond.0),
            Err(_) => {
                return PromiseOrValue::Value(
                    self.drop_payee_change(&old, "Could not read DAO policy"),
                );
            }
        };
        if !self.can_afford(bond) {
            return PromiseOrValue::Value(
                self.drop_payee_change(&old, "Not enough NEAR to pay the DAO proposal bond"),
            );
        }
        let Some(pending) = self.pending_payee_changes.get(&old) else {
            return PromiseOrValue::Value(None);
        };
        let new = pending.new_account_id.clone();
        let name = self
            .payees
            .get(&old)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        let description = format!("Payables: change payee \"{name}\" from {old} to {new}");
        let args = json!({ "old": old, "new": new });

        self.add_dao_proposal(
            bond,
            description,
            "approve_payee_change",
            args,
            GAS_FOR_APPROVE_PAYEE_CHANGE,
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PROPOSAL_ADDED)
                .on_payee_change_proposal_added(old),
        )
        .into()
    }

    #[private]
    pub fn on_payee_change_proposal_added(
        &mut self,
        old: AccountId,
        #[callback_result] proposal_id: Result<u64, PromiseError>,
    ) -> Option<PendingPayeeChange> {
        let Ok(proposal_id) = proposal_id else {
            return self.drop_payee_change(&old, "Could not create the DAO proposal");
        };
        let pending = self.pending_payee_changes.get_mut(&old)?;
        pending.proposal_id = Some(proposal_id);

        PayablesEvent::PayeeChangeRequested {
            old: &old,
            new: &pending.new_account_id,
            proposal_id,
        }
        .emit();
        Some(pending.clone())
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can call this method"
        );
    }

    fn spent_on(&self, day: u64) -> u128 {
        if self.spent_day == day {
            self.daily_spent
        } else {
            0
        }
    }

    fn charge_daily_spend(&mut self, day: u64, amount: u128) {
        if self.spent_day != day {
            self.spent_day = day;
            self.daily_spent = 0;
        }
        self.daily_spent += amount;
    }

    /// `ft_transfer` (exactly 1 yoctoNEAR attached) followed by `on_transfer_complete`.
    fn transfer(&self, invoice: &Invoice) -> Promise {
        ext_ft_core::ext(self.usdc_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(
                invoice.payee.clone(),
                invoice.amount,
                Some(format!("Payables invoice {}", invoice.invoice_id)),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_TRANSFER)
                    .on_transfer_complete(invoice.invoice_id.clone()),
            )
    }

    /// Marks an in-flight invoice as failed, refunds its daily spend and frees its hash.
    fn fail_invoice(&mut self, invoice_id: &str, reason: &str) -> Invoice {
        let invoice = self
            .invoices
            .get_mut(invoice_id)
            .expect("Invoice not found");
        invoice.status = InvoiceStatus::Failed;
        invoice.failure_reason = Some(reason.to_string());
        invoice.updated_at = U64(env::block_timestamp());
        let charged_day = invoice.charged_day.take();
        let invoice = invoice.clone();

        if let Some(day) = charged_day
            && self.spent_day == day
        {
            self.daily_spent = self.daily_spent.saturating_sub(invoice.amount.0);
        }
        self.paid_hashes.remove(&invoice.invoice_hash);

        PayablesEvent::PaymentFailed {
            invoice_id: &invoice.invoice_id,
            payee: &invoice.payee,
            amount: invoice.amount,
            reason,
        }
        .emit();
        invoice
    }

    fn drop_payee_change(&mut self, old: &AccountId, reason: &str) -> Option<PendingPayeeChange> {
        self.pending_payee_changes.remove(old);
        log!("Payee change for {} dropped: {}", old, reason);
        None
    }

    /// Whether the bond can be paid without dipping into the balance locked for storage.
    fn can_afford(&self, bond: NearToken) -> bool {
        let locked_for_storage =
            env::storage_byte_cost().saturating_mul(env::storage_usage().into());
        env::account_balance().saturating_sub(locked_for_storage) > bond
    }

    /// `add_proposal` on the DAO with a single FunctionCall action back to this contract.
    fn add_dao_proposal(
        &self,
        bond: NearToken,
        description: String,
        method_name: &str,
        args: near_sdk::serde_json::Value,
        gas: Gas,
    ) -> Promise {
        let proposal = ProposalInput {
            description,
            kind: ProposalKind::FunctionCall {
                receiver_id: env::current_account_id(),
                actions: vec![ActionCall {
                    method_name: method_name.to_string(),
                    args: args.to_string().into_bytes().into(),
                    deposit: U128(0),
                    gas: U64(gas.as_gas()),
                }],
            },
        };
        ext_dao::ext(self.dao_id.clone())
            .with_attached_deposit(bond)
            .with_static_gas(GAS_FOR_ADD_PROPOSAL)
            .add_proposal(proposal)
    }

    fn register_storage(&self, account_id: AccountId) -> Promise {
        ext_storage_management::ext(self.usdc_id.clone())
            .with_attached_deposit(STORAGE_DEPOSIT)
            .with_static_gas(GAS_FOR_STORAGE_DEPOSIT)
            .storage_deposit(Some(account_id), Some(true))
    }
}

/// Invoice hashes are hex sha256 digests; compare them case-insensitively.
fn normalize_hash(hash: &str) -> String {
    require!(
        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
        "invoice_hash must be a hex sha256 digest"
    );
    hash.to_ascii_lowercase()
}

/// `1500000000` -> `"1500"`, `1500250000` -> `"1500.25"`.
fn format_usdc(amount: u128) -> String {
    let whole = amount / 1_000_000;
    let frac = amount % 1_000_000;
    if frac == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{frac:06}")
            .trim_end_matches('0')
            .to_string()
    }
}

#[cfg(test)]
mod tests;
