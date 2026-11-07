//! NEP-297 events, logged as `EVENT_JSON:{"standard":"payables","version":"1.0.0","event":...,"data":{...}}`.
use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

use crate::EscalationReason;

#[near(event_json(standard = "payables"))]
pub enum PayablesEvent<'a> {
    /// The agent submitted an invoice. `auto_pay` tells whether it is being paid right away
    /// or escalated to the DAO.
    #[event_version("1.0.0")]
    PaymentRequested {
        invoice_id: &'a str,
        payee: &'a AccountId,
        amount: U128,
        invoice_hash: &'a str,
        auto_pay: bool,
    },
    /// A DAO proposal to release the payment was created.
    #[event_version("1.0.0")]
    PaymentEscalated {
        invoice_id: &'a str,
        payee: &'a AccountId,
        amount: U128,
        dao_id: &'a AccountId,
        proposal_id: u64,
        reason: EscalationReason,
    },
    #[event_version("1.0.0")]
    PaymentPaid {
        invoice_id: &'a str,
        payee: &'a AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    PaymentFailed {
        invoice_id: &'a str,
        payee: &'a AccountId,
        amount: U128,
        reason: &'a str,
    },
    #[event_version("1.0.0")]
    PaymentRejected {
        invoice_id: &'a str,
        payee: &'a AccountId,
        amount: U128,
        rejected_by: &'a AccountId,
    },
    #[event_version("1.0.0")]
    PayeeRegistered {
        account_id: &'a AccountId,
        name: &'a str,
    },
    /// A payee account change was proposed to the DAO.
    #[event_version("1.0.0")]
    PayeeChangeRequested {
        old: &'a AccountId,
        new: &'a AccountId,
        proposal_id: u64,
    },
    /// The DAO approved a payee account change; `old` is no longer allowlisted.
    #[event_version("1.0.0")]
    PayeeChanged {
        old: &'a AccountId,
        new: &'a AccountId,
    },
    #[event_version("1.0.0")]
    LimitsUpdated {
        auto_pay_limit: U128,
        daily_cap: U128,
    },
}
