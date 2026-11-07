//! End-to-end tests of the demo scenarios in SPEC.md against a local sandbox.
//!
//! Each test deploys mock USDC, the policy contract and Sputnik DAO v2, mints the treasury
//! and allowlists `bob` as a payee (auto-pay limit 1,000 USDC, daily cap 2,500 USDC).
mod common;

use common::*;
use serde_json::json;

/// Scenario 1: an invoice under the limit is paid immediately.
#[tokio::test]
async fn auto_pays_invoice_under_limit() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().as_str();

    let result = env
        .request_payment("inv-1", bob, 2 * USDC, &invoice_hash("inv-1"))
        .await?;
    assert_eq!(event_names(&result), ["payment_requested", "payment_paid"]);
    let invoice: Invoice = result.json()?;
    assert_eq!(invoice.status, "paid");

    assert_eq!(env.usdc_balance(bob).await?, 2 * USDC);
    assert_eq!(
        env.usdc_balance(env.policy.id().as_str()).await?,
        TREASURY - 2 * USDC
    );
    assert_eq!(env.daily_spent().await?, 2 * USDC);
    assert_eq!(env.invoice("inv-1").await?.unwrap().status, "paid");
    Ok(())
}

/// Scenarios 2 and 3: the contract refuses non-allowlisted payees and non-agent callers,
/// whatever the invoice says.
#[tokio::test]
async fn rejects_non_allowlisted_payee_and_non_agent() -> anyhow::Result<()> {
    let env = setup().await?;

    let result = env
        .request_payment(
            "inv-evil",
            "evil.test.near",
            50_000 * USDC,
            &invoice_hash("evil"),
        )
        .await?;
    assert_failure(result, "Payee is not on the allowlist");
    assert!(env.invoice("inv-evil").await?.is_none());

    let result = request_payment_as(
        &env.owner,
        &env,
        "inv-1",
        env.payee.id().as_str(),
        USDC,
        &invoice_hash("inv-1"),
    )
    .await?;
    assert_failure(result, "Only the agent can request payments");

    assert_eq!(env.usdc_balance(env.policy.id().as_str()).await?, TREASURY);
    Ok(())
}

#[tokio::test]
async fn rejects_duplicate_hash_and_invoice_id() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().as_str();
    let hash = invoice_hash("inv-1");

    env.request_payment("inv-1", bob, 1 * USDC, &hash)
        .await?
        .into_result()?;

    // Same PDF under a new invoice id (also in upper case).
    let result = env
        .request_payment("inv-2", bob, 1 * USDC, &hash.to_uppercase())
        .await?;
    assert_failure(result, "Invoice hash has already been used");

    // Same invoice id with a different PDF.
    let result = env
        .request_payment("inv-1", bob, 1 * USDC, &invoice_hash("other"))
        .await?;
    assert_failure(result, "Invoice id already exists");

    let used: bool = env
        .policy
        .view("is_hash_used")
        .args_json(json!({ "invoice_hash": hash }))
        .await?
        .json()?;
    assert!(used);
    assert_eq!(env.usdc_balance(bob).await?, 1 * USDC);
    Ok(())
}

#[tokio::test]
async fn escalates_when_daily_cap_is_reached() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().as_str();

    // 3 x 5 = 15 USDC: exactly at the cap is still auto-paid.
    for id in ["inv-1", "inv-2", "inv-3"] {
        let invoice: Invoice = env
            .request_payment(id, bob, 5 * USDC, &invoice_hash(id))
            .await?
            .json()?;
        assert_eq!(invoice.status, "paid");
    }

    // 15 + 5 > 15: at the per-invoice limit but over the daily cap.
    let result = env
        .request_payment("inv-4", bob, 5 * USDC, &invoice_hash("inv-4"))
        .await?;
    let events = payables_events(&result);
    let invoice: Invoice = result.json()?;
    assert_eq!(invoice.status, "pending_approval");
    let proposal_id = invoice.proposal_id.expect("proposal id is recorded");

    let escalated = events
        .iter()
        .find(|e| e["event"] == "payment_escalated")
        .expect("payment_escalated event");
    assert_eq!(escalated["data"]["reason"], "daily_cap_exceeded");
    assert_eq!(escalated["data"]["proposal_id"], proposal_id);

    let proposal = env.proposal(proposal_id).await?;
    assert_eq!(proposal["status"], "InProgress");
    assert_eq!(proposal["proposer"], env.policy.id().as_str());
    let call = &proposal["kind"]["FunctionCall"];
    assert_eq!(call["receiver_id"], env.policy.id().as_str());
    assert_eq!(call["actions"][0]["method_name"], "release_payment");

    assert_eq!(env.daily_spent().await?, 15 * USDC);
    assert_eq!(env.usdc_balance(bob).await?, 15 * USDC);
    Ok(())
}

/// Scenario 4: over-limit invoice -> DAO proposal -> council approves -> paid.
#[tokio::test]
async fn dao_approval_releases_over_limit_payment() -> anyhow::Result<()> {
    over_limit_flow(SPUTNIK_GITHUB).await
}

/// Same flow against the DAO code the testnet factory (`sputnik-v2.testnet`) deploys today.
#[tokio::test]
async fn dao_approval_works_with_testnet_sputnik_build() -> anyhow::Result<()> {
    over_limit_flow(SPUTNIK_TESTNET).await
}

async fn over_limit_flow(dao_wasm: &str) -> anyhow::Result<()> {
    let env = setup_with_dao(dao_wasm).await?;
    let bob = env.payee.id().as_str();
    let amount = 8 * USDC;

    let result = env
        .request_payment("inv-big", bob, amount, &invoice_hash("inv-big"))
        .await?;
    assert_eq!(
        event_names(&result),
        ["payment_requested", "payment_escalated"]
    );
    let invoice: Invoice = result.json()?;
    assert_eq!(invoice.status, "pending_approval");
    let proposal_id = invoice.proposal_id.expect("proposal id is recorded");
    assert_eq!(env.usdc_balance(bob).await?, 0);

    let proposal = env.proposal(proposal_id).await?;
    assert!(
        proposal["description"]
            .as_str()
            .unwrap()
            .contains("pay 8 USDC")
    );

    let vote = env.approve_proposal(proposal_id).await?;
    assert!(vote.is_success(), "{:?}", vote.into_result());
    assert_eq!(event_names(&vote), ["payment_paid"]);

    assert_eq!(env.proposal(proposal_id).await?["status"], "Approved");
    assert_eq!(env.invoice("inv-big").await?.unwrap().status, "paid");
    assert_eq!(env.usdc_balance(bob).await?, amount);
    // DAO-approved payments don't count toward the auto-pay daily cap.
    assert_eq!(env.daily_spent().await?, 0);
    Ok(())
}

#[tokio::test]
async fn release_payment_only_callable_by_dao() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().as_str();
    env.request_payment("inv-big", bob, 8 * USDC, &invoice_hash("inv-big"))
        .await?
        .into_result()?;

    for caller in [&env.owner, &env.agent, &env.council] {
        let result = caller
            .call(env.policy.id(), "release_payment")
            .args_json(json!({ "invoice_id": "inv-big" }))
            .max_gas()
            .transact()
            .await?;
        assert_failure(result, "Only the DAO can release payments");
    }

    assert_eq!(
        env.invoice("inv-big").await?.unwrap().status,
        "pending_approval"
    );
    assert_eq!(env.usdc_balance(bob).await?, 0);
    Ok(())
}

#[tokio::test]
async fn owner_rejection_blocks_later_dao_approval() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().as_str();
    let invoice: Invoice = env
        .request_payment("inv-big", bob, 8 * USDC, &invoice_hash("inv-big"))
        .await?
        .json()?;

    let result = env
        .owner
        .call(env.policy.id(), "reject_payment")
        .args_json(json!({ "invoice_id": "inv-big" }))
        .transact()
        .await?;
    assert_eq!(event_names(&result), ["payment_rejected"]);
    assert_eq!(result.json::<Invoice>()?.status, "rejected");

    // The proposal is still open; approving it now must not pay anything.
    let vote = env.approve_proposal(invoice.proposal_id.unwrap()).await?;
    let failures = format!("{:?}", vote.receipt_failures());
    assert!(
        failures.contains("Invoice is not pending approval"),
        "{failures}"
    );
    assert_eq!(env.invoice("inv-big").await?.unwrap().status, "rejected");
    assert_eq!(env.usdc_balance(bob).await?, 0);
    Ok(())
}

#[tokio::test]
async fn failed_transfer_marks_invoice_failed() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().as_str();

    // Bob closes his USDC storage registration, so the treasury's ft_transfer to him fails.
    env.payee
        .call(env.usdc.id(), "storage_unregister")
        .args_json(json!({}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let hash = invoice_hash("inv-1");
    let result = env.request_payment("inv-1", bob, 2 * USDC, &hash).await?;
    assert_eq!(
        event_names(&result),
        ["payment_requested", "payment_failed"]
    );
    let invoice: Invoice = result.json()?;
    assert_eq!(invoice.status, "failed");
    assert_eq!(
        invoice.failure_reason.as_deref(),
        Some("USDC transfer failed")
    );

    // Nothing left the treasury, the daily spend was rolled back and the hash freed.
    assert_eq!(env.usdc_balance(env.policy.id().as_str()).await?, TREASURY);
    assert_eq!(env.daily_spent().await?, 0);

    // Once Bob registers again, the same invoice can be retried.
    env.payee
        .call(env.usdc.id(), "storage_deposit")
        .args_json(json!({}))
        .deposit(near_workspaces::types::NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    let invoice: Invoice = env
        .request_payment("inv-1", bob, 2 * USDC, &hash)
        .await?
        .json()?;
    assert_eq!(invoice.status, "paid");
    assert_eq!(env.usdc_balance(bob).await?, 2 * USDC);
    Ok(())
}

#[tokio::test]
async fn register_payee_registers_usdc_storage() -> anyhow::Result<()> {
    let env = setup().await?;
    let carol = env
        .worker
        .root_account()?
        .create_subaccount("carol")
        .transact()
        .await?
        .into_result()?;

    let result = env
        .owner
        .call(env.policy.id(), "register_payee")
        .args_json(json!({ "account_id": carol.id(), "name": "Carol Consulting" }))
        .max_gas()
        .transact()
        .await?;
    assert_eq!(event_names(&result), ["payee_registered"]);
    result.into_result()?;

    let storage: serde_json::Value = env
        .usdc
        .view("storage_balance_of")
        .args_json(json!({ "account_id": carol.id() }))
        .await?
        .json()?;
    assert!(!storage.is_null(), "payee is registered on USDC");

    let payee: serde_json::Value = env
        .policy
        .view("get_payee")
        .args_json(json!({ "account_id": carol.id() }))
        .await?
        .json()?;
    assert_eq!(payee["name"], "Carol Consulting");

    // Only the owner can register payees.
    let result = env
        .agent
        .call(env.policy.id(), "register_payee")
        .args_json(json!({ "account_id": "evil.test.near", "name": "Evil" }))
        .max_gas()
        .transact()
        .await?;
    assert_failure(result, "Only the owner can call this method");
    Ok(())
}

#[tokio::test]
async fn payee_change_goes_through_dao() -> anyhow::Result<()> {
    let env = setup().await?;
    let bob = env.payee.id().clone();
    let bob2 = env
        .worker
        .root_account()?
        .create_subaccount("bob2")
        .transact()
        .await?
        .into_result()?;

    let pending: serde_json::Value = env
        .owner
        .call(env.policy.id(), "request_payee_change")
        .args_json(json!({ "old": bob, "new": bob2.id() }))
        .max_gas()
        .transact()
        .await?
        .json()?;
    let proposal_id = pending["proposal_id"].as_u64().expect("proposal id");

    // Only the DAO can apply the change.
    let result = env
        .owner
        .call(env.policy.id(), "approve_payee_change")
        .args_json(json!({ "old": bob, "new": bob2.id() }))
        .max_gas()
        .transact()
        .await?;
    assert_failure(result, "Only the DAO can approve payee changes");

    let vote = env.approve_proposal(proposal_id).await?;
    assert_eq!(event_names(&vote), ["payee_changed"]);

    let old: serde_json::Value = env
        .policy
        .view("get_payee")
        .args_json(json!({ "account_id": bob }))
        .await?
        .json()?;
    assert!(old.is_null());

    // Payments now go to the new account only.
    let invoice: Invoice = env
        .request_payment(
            "inv-1",
            bob2.id().as_str(),
            1 * USDC,
            &invoice_hash("inv-1"),
        )
        .await?
        .json()?;
    assert_eq!(invoice.status, "paid");
    assert_eq!(env.usdc_balance(bob2.id().as_str()).await?, 1 * USDC);
    let result = env
        .request_payment("inv-2", bob.as_str(), 1 * USDC, &invoice_hash("inv-2"))
        .await?;
    assert_failure(result, "Payee is not on the allowlist");
    Ok(())
}
