/*!
Mock USDC: a NEP-141 fungible token with NEP-145 storage management and 6 decimals.

It exists so the Payables demo can run on testnet (and in the sandbox) without depending on a
third-party faucet. The only addition to the standard token is an owner-only `mint`.

NOTES:
  - Amounts are base units as base-10 strings: `"1500000000"` is 1,500 USDC.
  - `mint` registers the receiver for storage if needed, paid from this contract's balance.
    That is a convenience for a test token; a production token would charge the caller.
*/
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::store::LazyOption;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, log, near, require,
};

pub const DECIMALS: u8 = 6;

const USDC_ICON: &str = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%232775CA'/%3E%3Ctext x='16' y='21' font-size='14' text-anchor='middle' fill='white' font-family='Arial'%3E$%3C/text%3E%3C/svg%3E";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    FungibleToken,
    Metadata,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    owner_id: AccountId,
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl Contract {
    /// Initializes the token with zero supply. Only `owner_id` can mint.
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "USD Coin (Payables mock)".to_string(),
            symbol: "USDC".to_string(),
            icon: Some(USDC_ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        };
        metadata.assert_valid();

        Self {
            owner_id,
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(metadata)),
        }
    }

    /// Mints `amount` base units to `account_id`, registering it for storage if needed.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can mint"
        );
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);

        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("mock USDC mint"),
        }
        .emit();
    }

    pub fn get_owner(&self) -> &AccountId {
        &self.owner_id
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            log!("Closed @{} with {}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata
            .get()
            .clone()
            .expect("metadata is set at init")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    fn context(predecessor: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(predecessor);
        builder
    }

    #[test]
    fn owner_mints_to_unregistered_account() {
        testing_env!(context(accounts(0)).build());
        let mut contract = Contract::new(accounts(0));
        contract.mint(accounts(1), U128(1_500_000_000));
        assert_eq!(contract.ft_balance_of(accounts(1)).0, 1_500_000_000);
        assert_eq!(contract.ft_total_supply().0, 1_500_000_000);
        assert_eq!(contract.ft_metadata().decimals, 6);
    }

    #[test]
    #[should_panic(expected = "Only the owner can mint")]
    fn non_owner_cannot_mint() {
        testing_env!(context(accounts(0)).build());
        let mut contract = Contract::new(accounts(0));
        testing_env!(context(accounts(1)).build());
        contract.mint(accounts(1), U128(1));
    }
}
