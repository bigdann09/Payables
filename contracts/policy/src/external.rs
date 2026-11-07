//! Interfaces of the contracts the policy contract calls.
use near_sdk::json_types::{Base64VecU8, U64, U128};
use near_sdk::{AccountId, ext_contract, near};

/// The part of a Sputnik DAO v2 `get_policy` response we need. Other fields are ignored.
#[near(serializers = [json])]
pub struct DaoPolicy {
    /// Exact deposit `add_proposal` requires (Sputnik v2 asserts equality).
    pub proposal_bond: U128,
}

/// Sputnik DAO v2 `ProposalInput`.
#[near(serializers = [json])]
pub struct ProposalInput {
    pub description: String,
    pub kind: ProposalKind,
}

/// The only Sputnik proposal kind this contract creates.
#[near(serializers = [json])]
pub enum ProposalKind {
    FunctionCall {
        receiver_id: AccountId,
        actions: Vec<ActionCall>,
    },
}

/// Sputnik DAO v2 `ActionCall`: one function call executed by the DAO once approved.
#[near(serializers = [json])]
pub struct ActionCall {
    pub method_name: String,
    pub args: Base64VecU8,
    pub deposit: U128,
    pub gas: U64,
}

#[allow(dead_code)]
#[ext_contract(ext_dao)]
pub trait SputnikDao {
    fn get_policy(&self) -> DaoPolicy;
    fn add_proposal(&mut self, proposal: ProposalInput) -> u64;
}
