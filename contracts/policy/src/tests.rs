use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

const USDC: u128 = 1_000_000;
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acc("acme.payables.testnet"))
        .predecessor_account_id(acc(predecessor))
        .account_balance(NearToken::from_near(10))
        .block_timestamp(1_700_000_000 * 1_000_000_000);
    builder
}

fn setup() -> Contract {
    testing_env!(ctx("owner.testnet").build());
    let mut contract = Contract::new(
        acc("owner.testnet"),
        acc("agent.testnet"),
        acc("dao.testnet"),
        acc("usdc.testnet"),
        U128(5 * USDC),  // auto_pay_limit, same as the testnet deployment
        U128(15 * USDC), // daily_cap
    );
    let _ = contract.register_payee(acc("bob.testnet"), "Bob's Bakery".into());
    testing_env!(ctx("agent.testnet").build());
    contract
}

fn request(contract: &mut Contract, id: &str, payee: &str, amount: u128, hash: &str) {
    let _ = contract.request_payment(
        id.into(),
        acc(payee),
        U128(amount),
        hash.into(),
        "2026-11-30".into(),
    );
}

fn status(contract: &Contract, id: &str) -> InvoiceStatus {
    contract.get_invoice(id.into()).unwrap().status
}

/// Callbacks run with this contract as the predecessor.
fn as_callback() {
    testing_env!(ctx("acme.payables.testnet").build());
}

#[test]
fn under_limit_is_auto_paid_and_charged() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", 2 * USDC, HASH_A);
    assert_eq!(status(&contract, "inv-1"), InvoiceStatus::Paying);
    assert_eq!(contract.get_daily_spent().0, 2 * USDC);
    assert!(get_logs()[0].starts_with("EVENT_JSON:"));
    assert!(get_logs()[0].contains(r#""event":"payment_requested""#));

    as_callback();
    let invoice = contract.on_transfer_complete("inv-1".into(), Ok(()));
    assert_eq!(invoice.status, InvoiceStatus::Paid);
}

#[test]
fn failed_transfer_rolls_back_daily_spend_and_frees_hash() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", 2 * USDC, HASH_A);

    as_callback();
    let invoice = contract.on_transfer_complete("inv-1".into(), Err(PromiseError::Failed));
    assert_eq!(invoice.status, InvoiceStatus::Failed);
    assert_eq!(contract.get_daily_spent().0, 0);
    assert!(!contract.is_hash_used(HASH_A.into()));

    // A failed invoice can be requested again.
    testing_env!(ctx("agent.testnet").build());
    request(&mut contract, "inv-1", "bob.testnet", 2 * USDC, HASH_A);
    assert_eq!(status(&contract, "inv-1"), InvoiceStatus::Paying);
}

#[test]
fn over_limit_is_escalated() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", 8 * USDC, HASH_A);
    assert_eq!(status(&contract, "inv-1"), InvoiceStatus::PendingApproval);
    assert_eq!(contract.get_daily_spent().0, 0);
}

#[test]
fn daily_cap_escalates() {
    let mut contract = setup();
    // 3 x 5 = 15 USDC lands exactly on the cap (allowed); the 4th would make it 20.
    request(&mut contract, "inv-1", "bob.testnet", 5 * USDC, HASH_A);
    request(&mut contract, "inv-2", "bob.testnet", 5 * USDC, HASH_B);
    request(&mut contract, "inv-3", "bob.testnet", 5 * USDC, HASH_C);
    request(&mut contract, "inv-4", "bob.testnet", 5 * USDC, HASH_D);
    assert_eq!(status(&contract, "inv-3"), InvoiceStatus::Paying);
    assert_eq!(status(&contract, "inv-4"), InvoiceStatus::PendingApproval);
    assert_eq!(contract.get_daily_spent().0, 15 * USDC);
}

#[test]
fn daily_spend_resets_on_next_utc_day() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", 5 * USDC, HASH_A);
    request(&mut contract, "inv-2", "bob.testnet", 5 * USDC, HASH_B);

    let mut next_day = ctx("agent.testnet");
    next_day.block_timestamp((1_700_000_000 + 86_400) * 1_000_000_000);
    testing_env!(next_day.build());
    assert_eq!(contract.get_daily_spent().0, 0);
    request(&mut contract, "inv-3", "bob.testnet", 5 * USDC, HASH_C);
    assert_eq!(status(&contract, "inv-3"), InvoiceStatus::Paying);
}

#[test]
#[should_panic(expected = "Only the agent can request payments")]
fn only_agent_can_request() {
    let mut contract = setup();
    testing_env!(ctx("owner.testnet").build());
    request(&mut contract, "inv-1", "bob.testnet", USDC, HASH_A);
}

#[test]
#[should_panic(expected = "Payee is not on the allowlist")]
fn rejects_unknown_payee() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "evil.testnet", USDC, HASH_A);
}

#[test]
#[should_panic(expected = "Invoice hash has already been used")]
fn rejects_duplicate_hash_in_any_case() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", USDC, HASH_A);
    request(
        &mut contract,
        "inv-2",
        "bob.testnet",
        USDC,
        &HASH_A.to_uppercase(),
    );
}

#[test]
#[should_panic(expected = "Invoice id already exists")]
fn rejects_duplicate_invoice_id() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", USDC, HASH_A);
    request(&mut contract, "inv-1", "bob.testnet", USDC, HASH_B);
}

#[test]
#[should_panic(expected = "Only the DAO can release payments")]
fn only_dao_can_release() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", 8 * USDC, HASH_A);
    testing_env!(ctx("owner.testnet").build());
    let _ = contract.release_payment("inv-1".into());
}

#[test]
fn owner_can_reject_pending_invoice() {
    let mut contract = setup();
    request(&mut contract, "inv-1", "bob.testnet", 8 * USDC, HASH_A);
    testing_env!(ctx("owner.testnet").build());
    assert_eq!(
        contract.reject_payment("inv-1".into()).status,
        InvoiceStatus::Rejected
    );
    // Rejected invoices keep their hash reserved.
    assert!(contract.is_hash_used(HASH_A.into()));
}

#[test]
fn dao_approves_payee_change() {
    let mut contract = setup();
    testing_env!(ctx("owner.testnet").build());
    let _ = contract.request_payee_change(acc("bob.testnet"), acc("bob2.testnet"));
    assert!(
        contract
            .get_pending_payee_change(acc("bob.testnet"))
            .is_some()
    );

    testing_env!(ctx("dao.testnet").build());
    let _ = contract.approve_payee_change(acc("bob.testnet"), acc("bob2.testnet"));
    assert!(contract.get_payee(acc("bob.testnet")).is_none());
    assert_eq!(
        contract.get_payee(acc("bob2.testnet")).unwrap().name,
        "Bob's Bakery"
    );
}

#[test]
fn formats_usdc() {
    assert_eq!(format_usdc(1_500_000_000), "1500");
    assert_eq!(format_usdc(1_500_250_000), "1500.25");
    assert_eq!(format_usdc(1), "0.000001");
}
