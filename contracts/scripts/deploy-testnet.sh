#!/usr/bin/env bash
# Deploys the Payables contracts to NEAR testnet with near-cli-rs (`near`) and cargo-near.
#
#   PARENT=payables.testnet ./scripts/deploy-testnet.sh
#
# Prerequisites:
#   - PARENT exists, holds ~12 NEAR, and its full-access key is in the legacy keychain
#     (~/.near-credentials), e.g. via `near account import-account ... save-to-legacy-keychain`.
#   - OWNER_ID and every COUNCIL member also have legacy-keychain keys (both default to PARENT).
#
# The script is idempotent: accounts and the DAO that already exist are left alone, but a
# contract that is already initialized will fail its `new` call. Re-run with fresh names then.
set -euo pipefail

NETWORK=testnet
RPC_URL=${RPC_URL:-https://rpc.testnet.fastnear.com}

PARENT=${PARENT:-payables.testnet}
POLICY_CONTRACT_ID=${POLICY_CONTRACT_ID:-acme.$PARENT}
# Circle's testnet USDC on NEAR (6 decimals). Set USE_EXISTING_USDC=0 and a usdc.$PARENT id for the mock.
USDC_CONTRACT_ID=${USDC_CONTRACT_ID:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}
# Top-level account created via the faucet service, so it brings its own gas money.
AGENT_ACCOUNT_ID=${AGENT_ACCOUNT_ID:-payables-agent.testnet}
DAO_FACTORY=${DAO_FACTORY:-sputnik-v2.testnet}
DAO_NAME=${DAO_NAME:-acme-dao}
DAO_ID=$DAO_NAME.$DAO_FACTORY
OWNER_ID=${OWNER_ID:-$PARENT}
# Comma-separated DAO council; one member is enough to approve proposals.
COUNCIL=${COUNCIL:-$PARENT}
# Demo payees as "account|name"; they match the API seed.
DEMO_PAYEES=${DEMO_PAYEES:-"northwind.$PARENT|Northwind Design Studio;bluepeak.$PARENT|BluePeak Consulting;orbit-labs.$PARENT|Orbit Labs"}

# USDC base units (6 decimals).
# Sized for a small faucet-funded treasury (~15 USDC).
AUTO_PAY_LIMIT=${AUTO_PAY_LIMIT:-5000000}      # 5 USDC
DAILY_CAP=${DAILY_CAP:-15000000}               # 15 USDC
TREASURY_MINT=${TREASURY_MINT:-15000000}       # 15 USDC (mock USDC only)
# Sputnik proposal bond in yoctoNEAR, paid by the policy contract and refunded on approval.
PROPOSAL_BOND=${PROPOSAL_BOND:-100000000000000000000000}   # 0.1 NEAR
# Set to 1 when USDC_CONTRACT_ID points at an existing token (e.g. Circle testnet USDC).
USE_EXISTING_USDC=${USE_EXISTING_USDC:-1}

CONTRACTS_DIR=$(cd "$(dirname "$0")/.." && pwd)

send() { near "$@" network-config "$NETWORK" sign-with-legacy-keychain send; }

account_exists() {
  curl -s "$RPC_URL" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",
    \"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    grep -q '"amount"'
}

create_subaccount() { # <account_id> <initial balance>
  if account_exists "$1"; then
    echo "• $1 already exists"
  else
    echo "• creating $1 with $2"
    near account create-account fund-myself "$1" "$2" \
      autogenerate-new-keypair save-to-legacy-keychain \
      sign-as "$PARENT" network-config "$NETWORK" sign-with-legacy-keychain send
  fi
}

call() { # <signer> <contract> <method> <json args> <gas> <deposit>
  send contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "$5" attached-deposit "$6" sign-as "$1"
}

echo "== Building contracts"
(cd "$CONTRACTS_DIR/policy" && cargo near build non-reproducible-wasm)
[ "$USE_EXISTING_USDC" = 1 ] || (cd "$CONTRACTS_DIR/mock_usdc" && cargo near build non-reproducible-wasm)
POLICY_WASM=$CONTRACTS_DIR/target/near/policy/policy.wasm
USDC_WASM=$CONTRACTS_DIR/target/near/mock_usdc/mock_usdc.wasm

echo "== Accounts"
create_subaccount "$POLICY_CONTRACT_ID" '3.5 NEAR' # ~2.2 NEAR code storage + DAO bonds + payee storage
account_exists "$AGENT_ACCOUNT_ID" || { echo "Create $AGENT_ACCOUNT_ID first (see README)"; exit 1; }
IFS=';' read -ra payees <<< "$DEMO_PAYEES"
for entry in "${payees[@]}"; do create_subaccount "${entry%%|*}" '0.1 NEAR'; done
[ "$USE_EXISTING_USDC" = 1 ] || create_subaccount "$USDC_CONTRACT_ID" '3 NEAR'

if [ "$USE_EXISTING_USDC" != 1 ]; then
  echo "== Mock USDC ($USDC_CONTRACT_ID)"
  send contract deploy "$USDC_CONTRACT_ID" use-file "$USDC_WASM" \
    with-init-call new json-args "{\"owner_id\":\"$OWNER_ID\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0 NEAR'
fi

echo "== Sputnik DAO ($DAO_ID)"
if account_exists "$DAO_ID"; then
  echo "• $DAO_ID already exists"
else
  council_json=$(printf '"%s",' ${COUNCIL//,/ }); council_json="[${council_json%,}]"
  dao_args=$(cat <<EOF
{"config":{"name":"$DAO_NAME","purpose":"Approve Payables invoices above the auto-pay limit","metadata":""},
 "policy":{
  "roles":[
   {"name":"council","kind":{"Group":$council_json},"permissions":["*:*"],"vote_policy":{}},
   {"name":"payables","kind":{"Group":["$POLICY_CONTRACT_ID"]},"permissions":["call:AddProposal"],"vote_policy":{}}],
  "default_vote_policy":{"weight_kind":"RoleWeight","quorum":"0","threshold":[1,2]},
  "proposal_bond":"$PROPOSAL_BOND","proposal_period":"604800000000000",
  "bounty_bond":"$PROPOSAL_BOND","bounty_forgiveness_period":"86400000000000"}}
EOF
)
  dao_args_b64=$(printf '%s' "$dao_args" | base64 | tr -d '\n')
  call "$PARENT" "$DAO_FACTORY" create "{\"name\":\"$DAO_NAME\",\"args\":\"$dao_args_b64\"}" '300 Tgas' '6 NEAR'
fi

echo "== Policy contract ($POLICY_CONTRACT_ID)"
send contract deploy "$POLICY_CONTRACT_ID" use-file "$POLICY_WASM" \
  with-init-call new json-args "{
    \"owner_id\":\"$OWNER_ID\",\"agent_id\":\"$AGENT_ACCOUNT_ID\",\"dao_id\":\"$DAO_ID\",
    \"usdc_id\":\"$USDC_CONTRACT_ID\",\"auto_pay_limit\":\"$AUTO_PAY_LIMIT\",\"daily_cap\":\"$DAILY_CAP\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR'

echo "== Treasury"
if [ "$USE_EXISTING_USDC" = 1 ]; then
  # Register the treasury; fund it by transferring USDC to $POLICY_CONTRACT_ID yourself.
  call "$PARENT" "$USDC_CONTRACT_ID" storage_deposit \
    "{\"account_id\":\"$POLICY_CONTRACT_ID\",\"registration_only\":true}" '30 Tgas' '0.0125 NEAR'
else
  call "$OWNER_ID" "$USDC_CONTRACT_ID" mint \
    "{\"account_id\":\"$POLICY_CONTRACT_ID\",\"amount\":\"$TREASURY_MINT\"}" '30 Tgas' '0 NEAR'
fi

echo "== Demo payees"
for entry in "${payees[@]}"; do
  call "$OWNER_ID" "$POLICY_CONTRACT_ID" register_payee \
    "{\"account_id\":\"${entry%%|*}\",\"name\":\"${entry#*|}\"}" '100 Tgas' '0 NEAR'
done

echo "== Agent function-call key (request_payment only)"
send account add-key "$AGENT_ACCOUNT_ID" grant-function-call-access \
  --allowance '1 NEAR' --contract-account-id "$POLICY_CONTRACT_ID" --function-names request_payment \
  autogenerate-new-keypair save-to-legacy-keychain

cat <<EOF

Done. Environment for api/:
  POLICY_CONTRACT_ID=$POLICY_CONTRACT_ID
  USDC_CONTRACT_ID=$USDC_CONTRACT_ID
  DAO_ID=$DAO_ID
  AGENT_ACCOUNT_ID=$AGENT_ACCOUNT_ID
The agent's function-call key was saved under ~/.near-credentials/$NETWORK/ (the CLI printed
the exact file above); the API must sign request_payment with that key, not the full-access one.
Owner key (register_payee, request_payee_change, reject_payment): ~/.near-credentials/$NETWORK/$OWNER_ID.json
EOF
