//! Sandbox setup shared by the integration tests: mock USDC, the policy contract and a
//! Sputnik DAO v2 instance, wired together the way `scripts/deploy-testnet.sh` does it.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde::Deserialize;
use serde_json::{Value, json};

pub const USDC: u128 = 1_000_000;
pub const AUTO_PAY_LIMIT: u128 = 5 * USDC; // same as the testnet deployment
pub const DAILY_CAP: u128 = 15 * USDC;
pub const TREASURY: u128 = 100 * USDC;
/// Deliberately not the Sputnik default (1 NEAR) so the test proves the bond is read from the DAO.
pub const PROPOSAL_BOND: NearToken = NearToken::from_millinear(100);

/// Sputnik DAO v2 builds vendored in `res/` (see the README for their sources).
pub const SPUTNIK_GITHUB: &str = "sputnikdao2.wasm";
pub const SPUTNIK_TESTNET: &str = "sputnikdao2_testnet.wasm";

#[derive(Debug, Deserialize)]
pub struct Invoice {
    pub invoice_id: String,
    pub payee: String,
    pub amount: String,
    pub invoice_hash: String,
    pub status: String,
    pub proposal_id: Option<u64>,
    pub failure_reason: Option<String>,
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub agent: Account,
    pub council: Account,
    pub payee: Account,
    pub policy: Contract,
    pub usdc: Contract,
    pub dao: Contract,
    // Keeps tests from running concurrently: each one boots its own sandbox node.
    _serial: MutexGuard<'static, ()>,
}

static SERIAL: Mutex<()> = Mutex::new(());
static WASMS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();

fn res(file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../res")
        .join(file)
}

/// Builds the policy and mock USDC contracts once per test binary.
async fn contract_wasms() -> anyhow::Result<&'static (Vec<u8>, Vec<u8>)> {
    if let Some(wasms) = WASMS.get() {
        return Ok(wasms);
    }
    let policy = near_workspaces::compile_project("../policy").await?;
    let usdc = near_workspaces::compile_project("../mock_usdc").await?;
    Ok(WASMS.get_or_init(|| (policy, usdc)))
}

/// A fake sha256 hex digest; any 64-char hex string is a valid invoice hash for the contract.
pub fn invoice_hash(seed: &str) -> String {
    let hex: String = seed.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{hex:0<64}")[..64].to_string()
}

async fn subaccount(root: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

/// Deploys everything with the Sputnik build from the official GitHub repo.
pub async fn setup() -> anyhow::Result<Env> {
    setup_with_dao(SPUTNIK_GITHUB).await
}

pub async fn setup_with_dao(dao_wasm_file: &str) -> anyhow::Result<Env> {
    // Recover from poisoning so one failing test doesn't fail the rest.
    // The guard is held across awaits on purpose; each test has its own runtime thread.
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());

    let (policy_wasm, usdc_wasm) = contract_wasms().await?;
    let dao_wasm = std::fs::read(res(dao_wasm_file))?;

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = subaccount(&root, "owner", 50).await?;
    let agent = subaccount(&root, "agent", 10).await?;
    let council = subaccount(&root, "council", 10).await?;
    let payee = subaccount(&root, "bob", 5).await?;

    let usdc = subaccount(&root, "usdc", 20)
        .await?
        .deploy(usdc_wasm)
        .await?
        .into_result()?;
    let dao = subaccount(&root, "dao", 30)
        .await?
        .deploy(&dao_wasm)
        .await?
        .into_result()?;
    let policy = subaccount(&root, "acme", 50)
        .await?
        .deploy(policy_wasm)
        .await?
        .into_result()?;

    usdc.call("new")
        .args_json(json!({ "owner_id": owner.id() }))
        .transact()
        .await?
        .into_result()?;

    dao.call("new")
        .args_json(json!({
            "config": { "name": "acme-dao", "purpose": "Approve large Payables invoices", "metadata": "" },
            "policy": dao_policy(council.id().as_str(), policy.id().as_str()),
        }))
        .transact()
        .await?
        .into_result()?;

    policy
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "agent_id": agent.id(),
            "dao_id": dao.id(),
            "usdc_id": usdc.id(),
            "auto_pay_limit": AUTO_PAY_LIMIT.to_string(),
            "daily_cap": DAILY_CAP.to_string(),
        }))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(usdc.id(), "mint")
        .args_json(json!({ "account_id": policy.id(), "amount": TREASURY.to_string() }))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(policy.id(), "register_payee")
        .args_json(json!({ "account_id": payee.id(), "name": "Bob's Bakery" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    Ok(Env {
        worker,
        owner,
        agent,
        council,
        payee,
        policy,
        usdc,
        dao,
        _serial: serial,
    })
}

/// A council of one approves anything; only the policy contract may open FunctionCall proposals.
pub fn dao_policy(council: &str, proposer: &str) -> Value {
    json!({
        "roles": [
            {
                "name": "council",
                "kind": { "Group": [council] },
                "permissions": ["*:*"],
                "vote_policy": {}
            },
            {
                "name": "payables",
                "kind": { "Group": [proposer] },
                "permissions": ["call:AddProposal"],
                "vote_policy": {}
            }
        ],
        "default_vote_policy": { "weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2] },
        "proposal_bond": PROPOSAL_BOND.as_yoctonear().to_string(),
        "proposal_period": "604800000000000",
        "bounty_bond": PROPOSAL_BOND.as_yoctonear().to_string(),
        "bounty_forgiveness_period": "86400000000000"
    })
}

impl Env {
    /// Calls `request_payment` as the agent.
    pub async fn request_payment(
        &self,
        invoice_id: &str,
        payee: &str,
        amount: u128,
        invoice_hash: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        request_payment_as(&self.agent, self, invoice_id, payee, amount, invoice_hash).await
    }

    pub async fn invoice(&self, invoice_id: &str) -> anyhow::Result<Option<Invoice>> {
        Ok(self
            .policy
            .view("get_invoice")
            .args_json(json!({ "invoice_id": invoice_id }))
            .await?
            .json()?)
    }

    pub async fn usdc_balance(&self, account: &str) -> anyhow::Result<u128> {
        let balance: String = self
            .usdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": account }))
            .await?
            .json()?;
        Ok(balance.parse()?)
    }

    pub async fn daily_spent(&self) -> anyhow::Result<u128> {
        let spent: String = self.policy.view("get_daily_spent").await?.json()?;
        Ok(spent.parse()?)
    }

    pub async fn proposal(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self
            .dao
            .view("get_proposal")
            .args_json(json!({ "id": id }))
            .await?
            .json()?)
    }

    /// Council votes to approve a proposal. Newer Sputnik builds require the proposal kind to be
    /// echoed back; older ones ignore the extra argument.
    pub async fn approve_proposal(&self, id: u64) -> anyhow::Result<ExecutionFinalResult> {
        let proposal = self.proposal(id).await?;
        Ok(self
            .council
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({ "id": id, "action": "VoteApprove", "proposal": proposal["kind"] }))
            .max_gas()
            .transact()
            .await?)
    }
}

pub async fn request_payment_as(
    signer: &Account,
    env: &Env,
    invoice_id: &str,
    payee: &str,
    amount: u128,
    invoice_hash: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(signer
        .call(env.policy.id(), "request_payment")
        .args_json(json!({
            "invoice_id": invoice_id,
            "payee": payee,
            "amount": amount.to_string(),
            "invoice_hash": invoice_hash,
            "due_date": "2026-11-30",
        }))
        // What the API should attach; enough for the escalation path too.
        .gas(Gas::from_tgas(150))
        .transact()
        .await?)
}

/// Asserts the transaction failed and that its error mentions `message`.
pub fn assert_failure(result: ExecutionFinalResult, message: &str) {
    let error = format!(
        "{:?}",
        result.into_result().expect_err("expected the call to fail")
    );
    assert!(error.contains(message), "expected `{message}` in: {error}");
}

/// NEP-297 events with `standard: "payables"` emitted anywhere in the transaction.
pub fn payables_events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .filter_map(|json| serde_json::from_str::<Value>(json).ok())
        .filter(|event| event["standard"] == "payables")
        .collect()
}

pub fn event_names(result: &ExecutionFinalResult) -> Vec<String> {
    payables_events(result)
        .iter()
        .map(|event| event["event"].as_str().unwrap_or_default().to_string())
        .collect()
}
