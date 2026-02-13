#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT_DIR/.e2e/logs"
TMP_DIR="$ROOT_DIR/.e2e/tmp"
mkdir -p "$LOG_DIR" "$TMP_DIR"

KEEP_STACK="${KEEP_E2E_STACK:-0}"

POSTGRES_PORT="${POSTGRES_PORT:-55432}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
BOT_PORT="${BOT_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
MOCK_GITHUB_PORT="${MOCK_GITHUB_PORT:-9010}"

POSTGRES_URL="${POSTGRES_URL:-postgres://postgres:postgres@127.0.0.1:${POSTGRES_PORT}/sitg}"
ANVIL_RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
BOT_URL="http://127.0.0.1:${BOT_PORT}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
MOCK_GITHUB_URL="http://127.0.0.1:${MOCK_GITHUB_PORT}"

ANVIL_DEPLOYER_PRIVATE_KEY="${ANVIL_DEPLOYER_PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
CONTRIB_PRIVATE_KEY="${CONTRIB_PRIVATE_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
CONTRIB_ADDRESS="${CONTRIB_ADDRESS:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"

BOT_KEY_ID="bck_live_e2e_key"
BOT_RAW_SECRET="0123456789abcdef0123456789abcdef"
WEBHOOK_SECRET="e2e_webhook_secret"
CONTRIB_SESSION_TOKEN="e2e_contrib_session"

PIDS=()

info() {
  printf '[e2e] %s\n' "$*"
}

fail() {
  printf '[e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

wait_http() {
  local url="$1"
  local timeout="${2:-60}"
  local started
  started="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if (( "$(date +%s)" - started > timeout )); then
      return 1
    fi
    sleep 1
  done
}

wait_db() {
  local timeout="${1:-60}"
  local started
  started="$(date +%s)"
  while true; do
    if psql "$POSTGRES_URL" -Atqc "select 1" >/dev/null 2>&1; then
      return 0
    fi
    if (( "$(date +%s)" - started > timeout )); then
      return 1
    fi
    sleep 1
  done
}

wait_nonempty_query() {
  local sql="$1"
  local timeout="${2:-30}"
  local started
  started="$(date +%s)"
  while true; do
    local out
    out="$(psql "$POSTGRES_URL" -Atqc "$sql" || true)"
    if [[ -n "$out" ]]; then
      printf '%s' "$out"
      return 0
    fi
    if (( "$(date +%s)" - started > timeout )); then
      return 1
    fi
    sleep 1
  done
}

hmac_sha256_hex_raw() {
  local key="$1"
  local message="$2"
  printf '%s' "$message" | openssl dgst -sha256 -mac HMAC -macopt "key:$key" | awk '{print $2}'
}

hmac_sha256_hex_internal() {
  local secret="$1"
  local message="$2"
  local derived
  derived="$(printf '%s' "$secret" | sha256sum | awk '{print $1}')"
  printf '%s' "$message" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$derived" | awk '{print $2}'
}

cleanup() {
  local exit_code=$?
  if [[ "$KEEP_STACK" != "1" ]]; then
    for pid in "${PIDS[@]:-}"; do
      if kill -0 "$pid" >/dev/null 2>&1; then
        kill "$pid" >/dev/null 2>&1 || true
      fi
    done
  else
    info "KEEP_E2E_STACK=1, leaving services running"
    info "logs: $LOG_DIR"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

require_cmd curl
require_cmd node
require_cmd npm
require_cmd cargo
require_cmd anvil
require_cmd forge
require_cmd cast
require_cmd openssl
require_cmd psql

info "Checking Postgres connection: $POSTGRES_URL"
wait_db 60 || fail "Postgres is not reachable. Start it first (e.g. scripts/e2e/postgres-docker.sh up)"

info "Starting Anvil"
anvil --host 127.0.0.1 --port "$ANVIL_PORT" --chain-id 8453 >"$LOG_DIR/anvil.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 30); do
  if cast block-number --rpc-url "$ANVIL_RPC_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
cast block-number --rpc-url "$ANVIL_RPC_URL" >/dev/null 2>&1 || fail "Anvil did not become ready"

info "Deploying staking contract to Anvil"
deploy_json="$(
  cd "$ROOT_DIR/staking-contract"
  forge create src/SITGStaking.sol:SITGStaking \
    --rpc-url "$ANVIL_RPC_URL" \
    --private-key "$ANVIL_DEPLOYER_PRIVATE_KEY" \
    --broadcast \
    --json
)"
printf '%s\n' "$deploy_json" >"$LOG_DIR/forge-deploy.json"
STAKING_CONTRACT_ADDRESS="$(
  printf '%s' "$deploy_json" | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s);
  const fromCandidates = (obj) => {
    if (!obj || typeof obj !== "object") return "";
    return String(
      obj.deployedTo ??
      obj.deployed_to ??
      obj.contractAddress ??
      obj.contract_address ??
      obj.address ??
      ""
    );
  };
  const addr =
    fromCandidates(j) ||
    fromCandidates(j.receipt) ||
    fromCandidates(j.deployment) ||
    fromCandidates(j.result);
  process.stdout.write(addr);
});
'
)"
if [[ -z "$STAKING_CONTRACT_ADDRESS" ]]; then
  DEPLOY_TX_HASH="$(
    printf '%s' "$deploy_json" | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s);
  const h =
    j.transactionHash ??
    j.transaction_hash ??
    j.txHash ??
    j.tx_hash ??
    j.hash ??
    "";
  process.stdout.write(String(h || ""));
});
'
  )"
  if [[ -n "$DEPLOY_TX_HASH" ]]; then
    receipt_json="$(cast receipt --rpc-url "$ANVIL_RPC_URL" "$DEPLOY_TX_HASH" --json || true)"
    printf '%s\n' "$receipt_json" >"$LOG_DIR/forge-deploy-receipt.json"
    STAKING_CONTRACT_ADDRESS="$(
      printf '%s' "$receipt_json" | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  if (!s.trim()) return;
  const j = JSON.parse(s);
  process.stdout.write(String(j.contractAddress ?? j.contract_address ?? ""));
});
'
    )"
  fi
fi
[[ -n "$STAKING_CONTRACT_ADDRESS" ]] || fail "Could not parse deployed contract address"
info "Contract deployed: $STAKING_CONTRACT_ADDRESS"

info "Starting backend-api"
(
  cd "$ROOT_DIR/backend-api"
  env \
    DATABASE_URL="$POSTGRES_URL" \
    HOST="127.0.0.1" \
    PORT="$BACKEND_PORT" \
    APP_BASE_URL="$FRONTEND_URL" \
    API_BASE_URL="$BACKEND_URL" \
    BASE_RPC_URL="$ANVIL_RPC_URL" \
    STAKING_CONTRACT_ADDRESS="$STAKING_CONTRACT_ADDRESS" \
    RUST_LOG="info" \
    cargo run
) >"$LOG_DIR/backend-api.log" 2>&1 &
PIDS+=("$!")
wait_http "$BACKEND_URL/healthz" 120 || fail "backend-api did not become ready"

info "Seeding database"
BOT_SECRET_SHA256="$(printf '%s' "$BOT_RAW_SECRET" | sha256sum | awk '{print $1}')"
cat <<SQL | psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 >/dev/null
delete from bot_actions;
delete from challenge_nonces;
delete from pr_confirmations;
delete from pr_challenges;
delete from internal_request_replays;

insert into users (id, github_user_id, github_login, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000001', 1001, 'owner', now(), now()),
  ('00000000-0000-0000-0000-000000000002', 2002, 'contrib', now(), now())
on conflict (github_user_id) do update set github_login = excluded.github_login, updated_at = now();

insert into user_sessions (id, user_id, session_token, expires_at, created_at, revoked_at)
values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000002', '${CONTRIB_SESSION_TOKEN}', now() + interval '30 days', now(), null)
on conflict (session_token) do update set user_id = excluded.user_id, expires_at = excluded.expires_at, revoked_at = null;

delete from wallet_links where user_id = '00000000-0000-0000-0000-000000000002';

insert into wallet_links (id, user_id, wallet_address, chain_id, linked_at, unlinked_at)
values ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000002', lower('${CONTRIB_ADDRESS}'), 8453, now(), null)
on conflict (id) do update set
  wallet_address = excluded.wallet_address,
  chain_id = excluded.chain_id,
  linked_at = excluded.linked_at,
  unlinked_at = null;

insert into github_installations (installation_id, account_login, account_type, created_at, updated_at)
values (123, 'owner', 'User', now(), now())
on conflict (installation_id) do update set account_login = excluded.account_login, account_type = excluded.account_type, updated_at = now();

insert into spot_quotes (id, source, pair, price, fetched_at, expires_at, created_at)
values ('00000000-0000-0000-0000-000000000004', 'coingecko', 'ETH_USD', 2500.00, now(), now() + interval '5 minutes', now())
on conflict (id) do nothing;

insert into repo_configs (
  github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei,
  input_mode, input_value, spot_price_usd, spot_source, spot_at, spot_quote_id,
  spot_from_cache, created_at, updated_at
)
values (
  999, 123, 'owner/repo', true, 1000000000000000000,
  'ETH', 1.0, 2500.00, 'coingecko', now(), '00000000-0000-0000-0000-000000000004',
  false, now(), now()
)
on conflict (github_repo_id) do update set threshold_wei = excluded.threshold_wei, updated_at = now();

insert into bot_clients (id, owner_user_id, name, status, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'e2e-bot', 'ACTIVE', now(), now())
on conflict (id) do update set status = 'ACTIVE', updated_at = now();

insert into bot_client_keys (key_id, bot_client_id, secret_hash, active, last_used_at, revoked_at, created_at)
values ('${BOT_KEY_ID}', '00000000-0000-0000-0000-000000000003', 'sha256:${BOT_SECRET_SHA256}', true, null, null, now())
on conflict (key_id) do update set secret_hash = excluded.secret_hash, active = true, revoked_at = null;

insert into bot_installation_bindings (bot_client_id, installation_id, created_at)
values ('00000000-0000-0000-0000-000000000003', 123, now())
on conflict (bot_client_id, installation_id) do nothing;
SQL

info "Starting mock GitHub API"
env MOCK_GITHUB_PORT="$MOCK_GITHUB_PORT" node "$ROOT_DIR/scripts/e2e/mock-github.mjs" >"$LOG_DIR/mock-github.log" 2>&1 &
PIDS+=("$!")
wait_http "$MOCK_GITHUB_URL/healthz" 30 || fail "mock-github did not become ready"

info "Building bot-worker"
npm --prefix "$ROOT_DIR/bot-worker" run build >/dev/null

info "Starting bot-worker"
BOT_STATE_FILE="$TMP_DIR/bot-state.json"
rm -f "$BOT_STATE_FILE"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP_DIR/github-app.pem" >/dev/null 2>&1
GITHUB_APP_PRIVATE_KEY_RAW="$(cat "$TMP_DIR/github-app.pem")"
(
  cd "$ROOT_DIR/bot-worker"
  env \
    PORT="$BOT_PORT" \
    GITHUB_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    GITHUB_API_BASE_URL="$MOCK_GITHUB_URL" \
    BACKEND_BASE_URL="$BACKEND_URL" \
    BACKEND_BOT_KEY_ID="$BOT_KEY_ID" \
    BACKEND_INTERNAL_HMAC_SECRET="$BOT_RAW_SECRET" \
    GITHUB_APP_ID="1" \
    GITHUB_APP_PRIVATE_KEY="$GITHUB_APP_PRIVATE_KEY_RAW" \
    BOT_STATE_FILE="$BOT_STATE_FILE" \
    WORKER_ID="e2e-bot-worker-1" \
    OUTBOX_POLLING_ENABLED="true" \
    OUTBOX_POLL_INTERVAL_MS="1100" \
    OUTBOX_CLAIM_LIMIT="25" \
    ENABLE_LOCAL_DEADLINE_TIMERS="false" \
    DEFAULT_INSTALLATION_ID="123" \
    node dist/src/index.js
) >"$LOG_DIR/bot-worker.log" 2>&1 &
PIDS+=("$!")
wait_http "$BOT_URL/healthz" 60 || fail "bot-worker did not become ready"

info "Starting frontend-web"
(
  cd "$ROOT_DIR/frontend-web"
  env \
    VITE_API_BASE_URL="$BACKEND_URL" \
    npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT"
) >"$LOG_DIR/frontend-web.log" 2>&1 &
PIDS+=("$!")
wait_http "$FRONTEND_URL" 60 || fail "frontend-web did not become ready"

info "Scenario 0: auth/session and frontend route sanity checks"
ME_NO_COOKIE_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$BACKEND_URL/api/v1/me")"
[[ "$ME_NO_COOKIE_STATUS" == "401" ]] || fail "Expected /api/v1/me without cookie to return 401, got ${ME_NO_COOKIE_STATUS}"

curl -fsS -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}" "$BACKEND_URL/api/v1/me" >"$TMP_DIR/me-contrib.json"
node - "$TMP_DIR/me-contrib.json" <<'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const body = JSON.parse(fs.readFileSync(p, "utf8"));
if (body.github_login !== "contrib") {
  console.error(`unexpected github_login from /me: ${String(body.github_login)}`);
  process.exit(1);
}
NODE

curl -fsS "$FRONTEND_URL/" >/dev/null
curl -fsS "$FRONTEND_URL/wallet" >/dev/null

info "Scenario 1: PR opened -> stake + confirm -> challenge VERIFIED"
PR1_PAYLOAD_FILE="$TMP_DIR/pr1.json"
cat >"$PR1_PAYLOAD_FILE" <<'JSON'
{
  "action": "opened",
  "installation": { "id": 123 },
  "repository": { "id": 999, "full_name": "owner/repo" },
  "pull_request": {
    "number": 1,
    "id": 5001,
    "html_url": "https://github.com/owner/repo/pull/1",
    "draft": false,
    "user": { "id": 2002, "login": "contrib" },
    "head": { "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  }
}
JSON
PR1_BODY="$(cat "$PR1_PAYLOAD_FILE")"
PR1_SIG="$(hmac_sha256_hex_raw "$WEBHOOK_SECRET" "$PR1_BODY")"
curl -fsS -X POST "$BOT_URL/webhooks/github" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-github-delivery: 00000000-0000-0000-0000-000000000101" \
  -H "x-hub-signature-256: sha256=$PR1_SIG" \
  --data "$PR1_BODY" >/dev/null

PR1_GATE_TOKEN="$(wait_nonempty_query "select gate_token from pr_challenges where github_repo_id = 999 and github_pr_number = 1 order by created_at desc limit 1" 30)" || fail "PR1 challenge was not created"
[[ -n "$PR1_GATE_TOKEN" ]] || fail "PR1 gate token empty"
PR1_CHALLENGE_ID="$(wait_nonempty_query "select id::text from pr_challenges where github_repo_id = 999 and github_pr_number = 1 order by created_at desc limit 1" 30)" || fail "PR1 challenge id missing"

curl -fsS "$BACKEND_URL/api/v1/gate/${PR1_GATE_TOKEN}" >"$TMP_DIR/pr1-gate-pending.json"
node - "$TMP_DIR/pr1-gate-pending.json" <<'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const body = JSON.parse(fs.readFileSync(p, "utf8"));
if (body.status !== "PENDING") {
  console.error(`expected gate status PENDING before confirm, got ${String(body.status)}`);
  process.exit(1);
}
NODE

curl -fsS "$MOCK_GITHUB_URL/_state" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const st = JSON.parse(s);
  const hasGate = st.comments.some((c) => c.thread === "owner/repo#1" && c.comments.some((m) => m.body.includes("sitg:gate:")));
  if (!hasGate) {
    console.error("gate comment not found for PR1");
    process.exit(1);
  }
});'

cast send "$STAKING_CONTRACT_ADDRESS" "stake()" \
  --value 2000000000000000000 \
  --private-key "$CONTRIB_PRIVATE_KEY" \
  --rpc-url "$ANVIL_RPC_URL" >/dev/null

curl -fsS \
  -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}" \
  "$BACKEND_URL/api/v1/gate/${PR1_GATE_TOKEN}/confirm-typed-data" >"$TMP_DIR/pr1-typed-raw.json"

node - "$TMP_DIR/pr1-typed-raw.json" "$TMP_DIR/pr1-typed-sign.json" <<'NODE'
const fs = require("node:fs");
const [inPath, outPath] = process.argv.slice(2);
const typed = JSON.parse(fs.readFileSync(inPath, "utf8"));
const out = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" }
    ],
    PRGateConfirmation: [
      { name: "githubUserId", type: "uint256" },
      { name: "githubRepoId", type: "uint256" },
      { name: "pullRequestNumber", type: "uint256" },
      { name: "headSha", type: "string" },
      { name: "challengeId", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "expiresAt", type: "uint256" }
    ]
  },
  primaryType: "PRGateConfirmation",
  domain: typed.domain,
  message: typed.message
};
fs.writeFileSync(outPath, JSON.stringify(out));
NODE

PR1_SIGNATURE="$(cast wallet sign --data --from-file "$TMP_DIR/pr1-typed-sign.json" --private-key "$CONTRIB_PRIVATE_KEY" | tr -d '\n')"
curl -fsS -X POST "$BACKEND_URL/api/v1/gate/${PR1_GATE_TOKEN}/confirm" \
  -H "content-type: application/json" \
  -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}" \
  --data "{\"signature\":\"${PR1_SIGNATURE}\"}" >/dev/null

PR1_STATUS="$(wait_nonempty_query "select status from pr_challenges where id = '${PR1_CHALLENGE_ID}'::uuid" 10)" || fail "PR1 status missing"
[[ "$PR1_STATUS" == "VERIFIED" ]] || fail "Expected PR1 status VERIFIED, got ${PR1_STATUS}"

curl -fsS "$BACKEND_URL/api/v1/gate/${PR1_GATE_TOKEN}" >"$TMP_DIR/pr1-gate-verified.json"
node - "$TMP_DIR/pr1-gate-verified.json" <<'NODE'
const fs = require("node:fs");
const p = process.argv[2];
const body = JSON.parse(fs.readFileSync(p, "utf8"));
if (body.status !== "VERIFIED") {
  console.error(`expected gate status VERIFIED after confirm, got ${String(body.status)}`);
  process.exit(1);
}
NODE

info "Scenario 2: PR opened -> timeout check -> outbox close action executed by bot"
PR2_PAYLOAD_FILE="$TMP_DIR/pr2.json"
cat >"$PR2_PAYLOAD_FILE" <<'JSON'
{
  "action": "opened",
  "installation": { "id": 123 },
  "repository": { "id": 999, "full_name": "owner/repo" },
  "pull_request": {
    "number": 2,
    "id": 5002,
    "html_url": "https://github.com/owner/repo/pull/2",
    "draft": false,
    "user": { "id": 2002, "login": "contrib" },
    "head": { "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  }
}
JSON
PR2_BODY="$(cat "$PR2_PAYLOAD_FILE")"
PR2_SIG="$(hmac_sha256_hex_raw "$WEBHOOK_SECRET" "$PR2_BODY")"
curl -fsS -X POST "$BOT_URL/webhooks/github" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-github-delivery: 00000000-0000-0000-0000-000000000102" \
  -H "x-hub-signature-256: sha256=$PR2_SIG" \
  --data "$PR2_BODY" >/dev/null

PR2_CHALLENGE_ID="$(wait_nonempty_query "select id::text from pr_challenges where github_repo_id = 999 and github_pr_number = 2 order by created_at desc limit 1" 30)" || fail "PR2 challenge was not created"

NOW_TS="$(date +%s)"
CHECK_SIG="$(hmac_sha256_hex_internal "$BOT_RAW_SECRET" "${NOW_TS}.${PR2_CHALLENGE_ID}")"
curl -fsS -X POST "$BACKEND_URL/internal/v1/challenges/${PR2_CHALLENGE_ID}/deadline-check" \
  -H "x-sitg-key-id: ${BOT_KEY_ID}" \
  -H "x-sitg-timestamp: ${NOW_TS}" \
  -H "x-sitg-signature: sha256=${CHECK_SIG}" >/dev/null

wait_nonempty_query "select id::text from bot_actions where challenge_id = '${PR2_CHALLENGE_ID}'::uuid and status = 'DONE' limit 1" 30 >/dev/null || fail "PR2 bot action did not complete"

PR2_STATUS="$(wait_nonempty_query "select status from pr_challenges where id = '${PR2_CHALLENGE_ID}'::uuid" 10)" || fail "PR2 status missing"
[[ "$PR2_STATUS" == "TIMED_OUT_CLOSED" ]] || fail "Expected PR2 status TIMED_OUT_CLOSED, got ${PR2_STATUS}"

curl -fsS "$MOCK_GITHUB_URL/_state" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const st = JSON.parse(s);
  const closed = st.pulls.some((p) => p.key === "owner/repo#2" && p.state === "closed");
  const timeoutComment = st.comments.some((c) => c.thread === "owner/repo#2" && c.comments.some((m) => m.body.includes("sitg:timeout:")));
  if (!closed) {
    console.error("PR2 was not closed by bot");
    process.exit(1);
  }
  if (!timeoutComment) {
    console.error("timeout comment missing for PR2");
    process.exit(1);
  }
});'

info "Scenario 3: replay protection rejects duplicate internal signature"
REPLAY_STATUS_1="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BACKEND_URL/internal/v1/challenges/${PR2_CHALLENGE_ID}/deadline-check" \
  -H "x-sitg-key-id: ${BOT_KEY_ID}" \
  -H "x-sitg-timestamp: ${NOW_TS}" \
  -H "x-sitg-signature: sha256=${CHECK_SIG}")"
[[ "$REPLAY_STATUS_1" == "403" ]] || fail "Expected duplicate replay signature to return 403, got ${REPLAY_STATUS_1}"

info "Scenario 4: wallet link challenge/confirm and unlink guards"
curl -fsS -X POST "$BACKEND_URL/api/v1/wallet/link/challenge" \
  -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}" >"$TMP_DIR/wallet-link-challenge.json"

WL_NONCE="$(node - "$TMP_DIR/wallet-link-challenge.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(String(body.nonce ?? ""));
NODE
)"
WL_MESSAGE="$(node - "$TMP_DIR/wallet-link-challenge.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(String(body.message ?? ""));
NODE
)"
[[ -n "$WL_NONCE" ]] || fail "wallet link challenge missing nonce"
[[ -n "$WL_MESSAGE" ]] || fail "wallet link challenge missing message"

WL_SIGNATURE="$(cast wallet sign "$WL_MESSAGE" --private-key "$CONTRIB_PRIVATE_KEY" | tr -d '\n')"
curl -fsS -X POST "$BACKEND_URL/api/v1/wallet/link/confirm" \
  -H "content-type: application/json" \
  -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}" \
  --data "{\"nonce\":\"${WL_NONCE}\",\"wallet_address\":\"${CONTRIB_ADDRESS}\",\"signature\":\"${WL_SIGNATURE}\"}" >"$TMP_DIR/wallet-link-confirm.json"

node - "$TMP_DIR/wallet-link-confirm.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!body.linked || !String(body.wallet_address || "").startsWith("0x")) {
  console.error("wallet link confirm response invalid");
  process.exit(1);
}
NODE

UNLINK_ACTIVE_STATUS="$(curl -sS -o "$TMP_DIR/unlink-active.json" -w '%{http_code}' -X DELETE "$BACKEND_URL/api/v1/wallet/link" \
  -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}")"
[[ "$UNLINK_ACTIVE_STATUS" == "409" ]] || fail "Expected unlink with active stake to fail 409, got ${UNLINK_ACTIVE_STATUS}"
node - "$TMP_DIR/unlink-active.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const msg = String(body?.error?.message ?? "");
if (!msg.includes("WALLET_HAS_STAKE")) {
  console.error(`expected WALLET_HAS_STAKE conflict, got: ${msg}`);
  process.exit(1);
}
NODE

cast rpc --rpc-url "$ANVIL_RPC_URL" evm_increaseTime 2678400 >/dev/null
cast rpc --rpc-url "$ANVIL_RPC_URL" evm_mine >/dev/null
cast send "$STAKING_CONTRACT_ADDRESS" "withdraw()" \
  --private-key "$CONTRIB_PRIVATE_KEY" \
  --rpc-url "$ANVIL_RPC_URL" >/dev/null

UNLINK_CLEAR_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BACKEND_URL/api/v1/wallet/link" \
  -H "Cookie: sitg_session=${CONTRIB_SESSION_TOKEN}")"
[[ "$UNLINK_CLEAR_STATUS" == "204" ]] || fail "Expected unlink after withdraw to return 204, got ${UNLINK_CLEAR_STATUS}"

ACTIVE_WALLET_AFTER_UNLINK="$(psql "$POSTGRES_URL" -Atqc "select wallet_address from wallet_links wl join users u on u.id = wl.user_id where u.github_user_id = 2002 and wl.unlinked_at is null limit 1")"
[[ -z "$ACTIVE_WALLET_AFTER_UNLINK" ]] || fail "Expected no active wallet link after unlink"

info "Scenario 5: whitelist added after PR open yields deadline NOOP + EXEMPT status"
PR3_PAYLOAD_FILE="$TMP_DIR/pr3.json"
cat >"$PR3_PAYLOAD_FILE" <<'JSON'
{
  "action": "opened",
  "installation": { "id": 123 },
  "repository": { "id": 999, "full_name": "owner/repo" },
  "pull_request": {
    "number": 3,
    "id": 5003,
    "html_url": "https://github.com/owner/repo/pull/3",
    "draft": false,
    "user": { "id": 2002, "login": "contrib" },
    "head": { "sha": "cccccccccccccccccccccccccccccccccccccccc" }
  }
}
JSON
PR3_BODY="$(cat "$PR3_PAYLOAD_FILE")"
PR3_SIG="$(hmac_sha256_hex_raw "$WEBHOOK_SECRET" "$PR3_BODY")"
curl -fsS -X POST "$BOT_URL/webhooks/github" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-github-delivery: 00000000-0000-0000-0000-000000000103" \
  -H "x-hub-signature-256: sha256=$PR3_SIG" \
  --data "$PR3_BODY" >/dev/null

PR3_CHALLENGE_ID="$(wait_nonempty_query "select id::text from pr_challenges where github_repo_id = 999 and github_pr_number = 3 order by created_at desc limit 1" 30)" || fail "PR3 challenge was not created"
cat <<SQL | psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 >/dev/null
insert into repo_whitelist (id, github_repo_id, github_user_id, github_login, created_at)
values ('00000000-0000-0000-0000-000000000051', 999, 2002, 'contrib', now())
on conflict (github_repo_id, github_user_id) do update set github_login = excluded.github_login;
SQL

PR3_NOW_TS="$(date +%s)"
PR3_CHECK_SIG="$(hmac_sha256_hex_internal "$BOT_RAW_SECRET" "${PR3_NOW_TS}.${PR3_CHALLENGE_ID}")"
curl -fsS -X POST "$BACKEND_URL/internal/v1/challenges/${PR3_CHALLENGE_ID}/deadline-check" \
  -H "x-sitg-key-id: ${BOT_KEY_ID}" \
  -H "x-sitg-timestamp: ${PR3_NOW_TS}" \
  -H "x-sitg-signature: sha256=${PR3_CHECK_SIG}" >"$TMP_DIR/pr3-deadline.json"
node - "$TMP_DIR/pr3-deadline.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (body.action !== "NOOP") {
  console.error(`expected deadline action NOOP for whitelisted challenge, got ${String(body.action)}`);
  process.exit(1);
}
NODE

PR3_STATUS="$(wait_nonempty_query "select status from pr_challenges where id = '${PR3_CHALLENGE_ID}'::uuid" 10)" || fail "PR3 status missing"
[[ "$PR3_STATUS" == "EXEMPT" ]] || fail "Expected PR3 status EXEMPT, got ${PR3_STATUS}"
psql "$POSTGRES_URL" -c "delete from repo_whitelist where github_repo_id = 999 and github_user_id = 2002" >/dev/null

info "Scenario 6: draft PR ignored when draft gating is disabled"
psql "$POSTGRES_URL" -c "update repo_configs set draft_prs_gated = false, updated_at = now() where github_repo_id = 999" >/dev/null
PR4_PAYLOAD_FILE="$TMP_DIR/pr4.json"
cat >"$PR4_PAYLOAD_FILE" <<'JSON'
{
  "action": "opened",
  "installation": { "id": 123 },
  "repository": { "id": 999, "full_name": "owner/repo" },
  "pull_request": {
    "number": 4,
    "id": 5004,
    "html_url": "https://github.com/owner/repo/pull/4",
    "draft": true,
    "user": { "id": 2002, "login": "contrib" },
    "head": { "sha": "dddddddddddddddddddddddddddddddddddddddd" }
  }
}
JSON
PR4_BODY="$(cat "$PR4_PAYLOAD_FILE")"
PR4_SIG="$(hmac_sha256_hex_raw "$WEBHOOK_SECRET" "$PR4_BODY")"
curl -fsS -X POST "$BOT_URL/webhooks/github" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-github-delivery: 00000000-0000-0000-0000-000000000104" \
  -H "x-hub-signature-256: sha256=$PR4_SIG" \
  --data "$PR4_BODY" >/dev/null
sleep 1
PR4_COUNT="$(psql "$POSTGRES_URL" -Atqc "select count(*) from pr_challenges where github_repo_id = 999 and github_pr_number = 4")"
[[ "$PR4_COUNT" == "0" ]] || fail "Expected no challenge for PR4 draft when draft gating off"
psql "$POSTGRES_URL" -c "update repo_configs set draft_prs_gated = true, updated_at = now() where github_repo_id = 999" >/dev/null

info "Scenario 7: invalid webhook signature is ignored"
PR5_PAYLOAD_FILE="$TMP_DIR/pr5.json"
cat >"$PR5_PAYLOAD_FILE" <<'JSON'
{
  "action": "opened",
  "installation": { "id": 123 },
  "repository": { "id": 999, "full_name": "owner/repo" },
  "pull_request": {
    "number": 5,
    "id": 5005,
    "html_url": "https://github.com/owner/repo/pull/5",
    "draft": false,
    "user": { "id": 2002, "login": "contrib" },
    "head": { "sha": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }
  }
}
JSON
PR5_STATUS_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BOT_URL/webhooks/github" \
  -H "content-type: application/json" \
  -H "x-github-event: pull_request" \
  -H "x-github-delivery: 00000000-0000-0000-0000-000000000105" \
  -H "x-hub-signature-256: sha256=deadbeef" \
  --data-binary @"$PR5_PAYLOAD_FILE")"
[[ "$PR5_STATUS_CODE" == "202" ]] || fail "Expected invalid webhook signature to return 202 ignored, got ${PR5_STATUS_CODE}"
PR5_COUNT="$(psql "$POSTGRES_URL" -Atqc "select count(*) from pr_challenges where github_repo_id = 999 and github_pr_number = 5")"
[[ "$PR5_COUNT" == "0" ]] || fail "Expected no challenge for invalid-signature PR5"

info "Scenario 8: bot action result endpoint covers retryable, failed, and conflict outcomes"
cat <<SQL | psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 >/dev/null
insert into bot_actions (id, action_type, challenge_id, github_repo_id, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at, claimed_by, failure_reason, attempts)
values
  ('00000000-0000-0000-0000-000000000061', 'CLOSE_PR', null, 999, 91, '{}'::jsonb, 'CLAIMED', now(), null, now(), now(), 'manual-worker', null, 1),
  ('00000000-0000-0000-0000-000000000062', 'CLOSE_PR', null, 999, 92, '{}'::jsonb, 'CLAIMED', now(), null, now(), now(), 'manual-worker', null, 1),
  ('00000000-0000-0000-0000-000000000063', 'CLOSE_PR', null, 999, 93, '{}'::jsonb, 'CLAIMED', now(), null, now(), now(), 'different-worker', null, 1);
SQL

BA_RETRY_ID="00000000-0000-0000-0000-000000000061"
BA_FAIL_ID="00000000-0000-0000-0000-000000000062"
BA_CONFLICT_ID="00000000-0000-0000-0000-000000000063"
BA_WORKER="manual-worker"

BA_RETRY_TS="$(date +%s)"
BA_RETRY_SIG="$(hmac_sha256_hex_internal "$BOT_RAW_SECRET" "${BA_RETRY_TS}.bot-action-result:${BA_RETRY_ID}:${BA_WORKER}:false")"
curl -fsS -X POST "$BACKEND_URL/internal/v1/bot-actions/${BA_RETRY_ID}/result" \
  -H "content-type: application/json" \
  -H "x-sitg-key-id: ${BOT_KEY_ID}" \
  -H "x-sitg-timestamp: ${BA_RETRY_TS}" \
  -H "x-sitg-signature: sha256=${BA_RETRY_SIG}" \
  --data "{\"worker_id\":\"${BA_WORKER}\",\"success\":false,\"failure_reason\":\"retry me\",\"retryable\":true}" >"$TMP_DIR/ba-retry.json"
node - "$TMP_DIR/ba-retry.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (body.status !== "PENDING") {
  console.error(`expected bot action retry response status PENDING, got ${String(body.status)}`);
  process.exit(1);
}
NODE

BA_FAIL_TS="$(date +%s)"
BA_FAIL_SIG="$(hmac_sha256_hex_internal "$BOT_RAW_SECRET" "${BA_FAIL_TS}.bot-action-result:${BA_FAIL_ID}:${BA_WORKER}:false")"
curl -fsS -X POST "$BACKEND_URL/internal/v1/bot-actions/${BA_FAIL_ID}/result" \
  -H "content-type: application/json" \
  -H "x-sitg-key-id: ${BOT_KEY_ID}" \
  -H "x-sitg-timestamp: ${BA_FAIL_TS}" \
  -H "x-sitg-signature: sha256=${BA_FAIL_SIG}" \
  --data "{\"worker_id\":\"${BA_WORKER}\",\"success\":false,\"failure_reason\":\"hard failure\",\"retryable\":false}" >"$TMP_DIR/ba-fail.json"
node - "$TMP_DIR/ba-fail.json" <<'NODE'
const fs = require("node:fs");
const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (body.status !== "FAILED") {
  console.error(`expected bot action failure response status FAILED, got ${String(body.status)}`);
  process.exit(1);
}
NODE

BA_CONFLICT_TS="$(date +%s)"
BA_CONFLICT_SIG="$(hmac_sha256_hex_internal "$BOT_RAW_SECRET" "${BA_CONFLICT_TS}.bot-action-result:${BA_CONFLICT_ID}:${BA_WORKER}:true")"
BA_CONFLICT_CODE="$(curl -sS -o "$TMP_DIR/ba-conflict.json" -w '%{http_code}' -X POST "$BACKEND_URL/internal/v1/bot-actions/${BA_CONFLICT_ID}/result" \
  -H "content-type: application/json" \
  -H "x-sitg-key-id: ${BOT_KEY_ID}" \
  -H "x-sitg-timestamp: ${BA_CONFLICT_TS}" \
  -H "x-sitg-signature: sha256=${BA_CONFLICT_SIG}" \
  --data "{\"worker_id\":\"${BA_WORKER}\",\"success\":true,\"failure_reason\":null,\"retryable\":null}")"
[[ "$BA_CONFLICT_CODE" == "409" ]] || fail "Expected bot action result conflict to return 409, got ${BA_CONFLICT_CODE}"

curl -fsS "$FRONTEND_URL/g/${PR1_GATE_TOKEN}" >/dev/null

info "E2E harness succeeded"
info "Backend URL: $BACKEND_URL"
info "Bot URL: $BOT_URL"
info "Frontend URL: $FRONTEND_URL"
info "Mock GitHub URL: $MOCK_GITHUB_URL"
info "Logs: $LOG_DIR"
