# Payables contracts

Rust workspace with the on-chain half of Payables (see `../SPEC.md`):

| Crate | What it is |
|---|---|
| `policy/` | Policy contract. Holds the USDC treasury and decides what the agent may pay: payee allowlist, auto-pay limit, UTC daily cap, duplicate hash/id rejection, Sputnik DAO v2 escalation. |
| `mock_usdc/` | NEP-141 + NEP-145 token (near-contract-standards), 6 decimals, owner-only `mint`. |
| `integration-tests/` | near-workspaces sandbox tests for the demo scenarios. |
| `res/` | Vendored Sputnik DAO v2 wasm binaries used by the tests (sources below). |
| `scripts/deploy-testnet.sh` | Creates the testnet accounts and deploys and wires everything. |

Versions: near-sdk / near-contract-standards 5.30, near-workspaces 0.24, cargo-near 0.22,
near-cli-rs 0.30. The toolchain is pinned to Rust 1.96.0 in `rust-toolchain.toml` (near-workspaces 0.24 needs Rust 1.95 or newer).

## Setup

```bash
rustup target add wasm32-unknown-unknown        # rust-toolchain.toml installs this for 1.96.0 too
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
```

## Build

```bash
cd policy    && cargo near build non-reproducible-wasm   # -> target/near/policy/policy.wasm
cd mock_usdc && cargo near build non-reproducible-wasm   # -> target/near/mock_usdc/mock_usdc.wasm
```

`cargo build` on a contract crate fails on purpose (near-sdk requires cargo-near). Use `cargo near build`, or `cargo test`.

## Test

```bash
cargo test -p policy -p mock_usdc        # unit tests
cargo test -p integration-tests          # sandbox tests (builds the wasm itself, downloads neard once)
```

The integration tests run one at a time, because each one starts its own sandbox node. They cover:

- under-limit invoice is auto-paid (payee balance and daily spend checked);
- non-allowlisted payee (`evil.test.near`) and non-agent caller are rejected;
- duplicate invoice hash (case-insensitive) and duplicate invoice id are rejected;
- daily cap reached → escalated to a Sputnik `FunctionCall` proposal for `release_payment`;
- over-limit invoice → DAO proposal → council `VoteApprove` → `release_payment` → payee paid.
  This runs against both the GitHub Sputnik build and the build the testnet factory deploys;
- `release_payment` from owner, agent or a council member directly fails;
- owner `reject_payment` → a later DAO approval pays nothing;
- failed `ft_transfer` (payee unregistered on USDC) → `failed`, daily spend rolled back, hash freed, retry works;
- `register_payee` does `storage_deposit` on USDC; owner-only;
- payee account change only takes effect through a DAO proposal.

### Sputnik DAO wasm sources

- `res/sputnikdao2.wasm`: the last binary published in the official repo, at
  https://github.com/near-daos/sputnik-dao-contract/blob/af36ff669a4b7c4d980fabc9e3634e57fb8ce1a2/sputnikdao2/res/sputnikdao2.wasm
  (sputnikdao2 v2.3.x). Newer commits stopped committing binaries and build them with cargo-near.
  sha256 `c9a502ef08a06cef04e2fce82da60b1fbc78db3066ff41416110f4292fca39ce`.
- `res/sputnikdao2_testnet.wasm`: the code the testnet factory `sputnik-v2.testnet` currently
  deploys. It was fetched with RPC `view_code` from `hack-dao.sputnik-v2.testnet` (code hash
  `ZGdM2TFdQpcXrxPxvq25514EViyi9xBSboetDiB3Uiq`). It is an older build than the GitHub one.

The two differ in one way that matters to callers: the newer build's `act_proposal` requires the
proposal `kind` to be echoed back (`{"id", "action", "proposal": <kind from get_proposal>}`).
The testnet build ignores that extra argument, so always sending it works with both.

## Contract interface (policy)

All amounts are USDC base units as strings. Timestamps are nanoseconds as strings (`U64`).

| Method | Caller | Args (JSON) | Returns |
|---|---|---|---|
| `new` | init | `{owner_id, agent_id, dao_id, usdc_id, auto_pay_limit, daily_cap}` | |
| `request_payment` | agent | `{invoice_id, payee, amount, invoice_hash, due_date}` | `Invoice` (final status after callbacks) |
| `release_payment` | DAO | `{invoice_id}` | `Invoice` |
| `reject_payment` | DAO or owner | `{invoice_id}` | `Invoice` |
| `register_payee` | owner | `{account_id, name}` | storage_deposit result |
| `request_payee_change` | owner | `{old, new}` | `PendingPayeeChange` or `null` |
| `approve_payee_change` | DAO | `{old, new}` | storage_deposit result |
| `reject_payee_change` | DAO or owner | `{old}` | |
| `set_limits` | owner | `{auto_pay_limit, daily_cap}` | |
| `get_invoice` | view | `{invoice_id}` | `Invoice \| null` |
| `get_payee` | view | `{account_id}` | `{name, registered_at} \| null` |
| `get_pending_payee_change` | view | `{old}` | `{new_account_id, proposal_id, requested_at} \| null` |
| `is_hash_used` | view | `{invoice_hash}` | `bool` |
| `get_config` | view | | `{owner_id, agent_id, dao_id, usdc_id, auto_pay_limit, daily_cap}` |
| `get_daily_spent` | view | | `"<amount>"` auto-paid in the current UTC day |

`Invoice`:

```json
{
  "invoice_id": "clx123", "payee": "northwind.payables.testnet", "amount": "1500000000",
  "invoice_hash": "<64 lowercase hex chars>", "due_date": "2026-11-30",
  "status": "pending_approval", "proposal_id": 7, "failure_reason": null,
  "created_at": "1762300000000000000", "updated_at": "1762300000000000000"
}
```

Rules:
- `invoice_hash` must be 64 hex characters (sha256). It is lower-cased before comparison.
- `due_date` is a free-form string up to 64 characters (ISO 8601 date recommended). It is stored and not interpreted.
- An invoice id can be requested again only if its previous attempt is `failed`. A failed payment frees its hash. Paid, pending, paying and rejected invoices keep their hashes reserved.
- Auto-pay applies when `amount <= auto_pay_limit` and `daily_spent + amount <= daily_cap`. Otherwise the invoice escalates. DAO-released payments do not count toward the daily cap.
- Escalation reads `proposal_bond` from the DAO's `get_policy` and attaches exactly that amount to `add_proposal`. The bond comes from the policy contract's NEAR balance, and Sputnik refunds it when the proposal is approved or rejected.
- When the DAO votes a proposal down, Sputnik does not call back. The invoice stays `pending_approval` until the owner calls `reject_payment`.
- Gas: attach 150–300 TGas to `request_payment` (auto-pay uses about 35, escalation about 80). Voters should attach 300 TGas to `act_proposal`.

Events (`EVENT_JSON:` logs, `standard: "payables"`, `version: "1.0.0"`, `data` is an object):

| event | data |
|---|---|
| `payment_requested` | `invoice_id, payee, amount, invoice_hash, auto_pay` |
| `payment_escalated` | `invoice_id, payee, amount, dao_id, proposal_id, reason` (`over_auto_pay_limit` \| `daily_cap_exceeded`) |
| `payment_paid` | `invoice_id, payee, amount` |
| `payment_failed` | `invoice_id, payee, amount, reason` |
| `payment_rejected` | `invoice_id, payee, amount, rejected_by` |
| `payee_registered` | `account_id, name` |
| `payee_change_requested` | `old, new, proposal_id` |
| `payee_changed` | `old, new` |
| `limits_updated` | `auto_pay_limit, daily_cap` |

## Deploy to testnet

```bash
PARENT=payables.testnet ./scripts/deploy-testnet.sh
```

`PARENT` must already exist, hold about 12 NEAR, and have its key in the legacy keychain
(`~/.near-credentials`). With the defaults the script:

1. builds the policy contract;
2. creates the policy contract account (`acme.PARENT`), the demo payees (`northwind.`, `bluepeak.`,
   `orbit-labs.` subaccounts) and the agent (`payables-agent.testnet`);
3. uses Circle's testnet USDC (`3e2210e1…b8af`, 6 decimals);
4. creates `acme-dao.sputnik-v2.testnet` through the factory. The council (`COUNCIL`, default `PARENT`) has full rights, the policy contract may only add `call` proposals, and the bond is 0.1 NEAR;
5. deploys and initializes the policy contract with an **auto-pay limit of 5 USDC and a daily cap of 15 USDC**,
   sized for a faucet-funded treasury;
6. registers the demo payees (which also does their USDC `storage_deposit`);
7. adds a function-call access key to the agent, limited to `request_payment` on the policy contract with a 1 NEAR allowance.

Fund the treasury yourself from the Circle faucet: send testnet USDC to the policy contract account.
Every value can be overridden with an environment variable; see the top of the script. To deploy
the bundled mock token instead, set `USE_EXISTING_USDC=0 USDC_CONTRACT_ID=usdc.PARENT`; the script then
mints `TREASURY_MINT` (default 15 USDC) to the treasury.

Approving an escalated invoice from the CLI (as a council member):

```bash
near contract call-function as-read-only acme-dao.sputnik-v2.testnet get_proposal json-args '{"id":7}' network-config testnet now
near contract call-function as-transaction acme-dao.sputnik-v2.testnet act_proposal \
  json-args '{"id":7,"action":"VoteApprove","proposal":<kind from get_proposal>}' \
  prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as payables.testnet \
  network-config testnet sign-with-legacy-keychain send
```
