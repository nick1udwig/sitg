#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/scripts/e2e/docker-compose.local.yml"
LOCAL_E2E_POSTGRES_PORT="${LOCAL_E2E_POSTGRES_PORT:-55432}"
LOCAL_E2E_BACKEND_PORT="${LOCAL_E2E_BACKEND_PORT:-18080}"
LOCAL_E2E_BOT_PORT="${LOCAL_E2E_BOT_PORT:-13000}"
LOCAL_E2E_MOCK_GITHUB_PORT="${LOCAL_E2E_MOCK_GITHUB_PORT:-19010}"
export LOCAL_E2E_POSTGRES_PORT LOCAL_E2E_BACKEND_PORT LOCAL_E2E_BOT_PORT LOCAL_E2E_MOCK_GITHUB_PORT

POSTGRES_URL="${POSTGRES_URL:-postgres://postgres:postgres@127.0.0.1:${LOCAL_E2E_POSTGRES_PORT}/sitg}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:${LOCAL_E2E_BACKEND_PORT}}"
BOT_URL="${BOT_URL:-http://127.0.0.1:${LOCAL_E2E_BOT_PORT}}"
MOCK_GITHUB_URL="${MOCK_GITHUB_URL:-http://127.0.0.1:${LOCAL_E2E_MOCK_GITHUB_PORT}}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-e2e_webhook_secret}"
BOT_KEY_ID="${BOT_KEY_ID:-e2e_service_key}"
BOT_RAW_SECRET="${BOT_RAW_SECRET:-e2e_internal_secret}"

COMPOSE=(docker compose -p sitg-local-e2e -f "$COMPOSE_FILE")

info() {
  printf '[local-e2e] %s\n' "$*"
}

fail() {
  printf '[local-e2e] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

dc() {
  "${COMPOSE[@]}" "$@"
}

wait_http() {
  local url="$1"
  local timeout="${2:-120}"
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
  local timeout="${1:-120}"
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
  local timeout="${2:-60}"
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
  printf '%s' "$message" | openssl dgst -sha256 -hmac "$key" | awk '{print $2}'
}

up_stack() {
  info "Starting docker compose stack"
  dc up -d postgres mock-github backend bot

  info "Waiting for postgres"
  wait_db 120 || fail "Postgres did not become ready"

  info "Waiting for backend"
  wait_http "$BACKEND_URL/healthz" 240 || fail "Backend did not become ready"

  info "Waiting for bot"
  wait_http "$BOT_URL/healthz" 240 || fail "Bot did not become ready"

  info "Waiting for mock-github"
  wait_http "$MOCK_GITHUB_URL/healthz" 120 || fail "Mock GitHub did not become ready"
}

seed_db() {
  info "Seeding database for centralized bot flow"
  local bot_secret_sha256
  bot_secret_sha256="$(printf '%s' "$BOT_RAW_SECRET" | sha256sum | awk '{print $1}')"

  cat <<SQL | psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 >/dev/null
truncate table bot_actions, challenge_nonces, pr_confirmations, pr_challenges, internal_request_replays, github_event_deliveries restart identity cascade;
delete from repo_whitelist where github_repo_id = 999;
delete from repo_configs where github_repo_id = 999;
delete from github_installation_repositories where github_repo_id = 999;
delete from github_installations where installation_id = 123;
delete from service_bot_keys where key_id = '${BOT_KEY_ID}';

delete from spot_quotes where id = '00000000-0000-0000-0000-000000000004';
insert into spot_quotes (id, source, pair, price, fetched_at, expires_at, created_at)
values ('00000000-0000-0000-0000-000000000004', 'coingecko', 'ETH_USD', 2500.00, now(), now() + interval '5 minutes', now())
on conflict (id) do nothing;

insert into github_installations (installation_id, account_login, account_type, active, created_at, updated_at)
values (123, 'owner', 'User', true, now(), now())
on conflict (installation_id) do update set
  account_login = excluded.account_login,
  account_type = excluded.account_type,
  active = true,
  updated_at = now();

insert into github_installation_repositories (installation_id, github_repo_id, full_name, active, created_at, updated_at)
values (123, 999, 'owner/repo', true, now(), now())
on conflict (installation_id, github_repo_id) do update set
  full_name = excluded.full_name,
  active = true,
  updated_at = now();

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
on conflict (github_repo_id) do update set
  installation_id = excluded.installation_id,
  full_name = excluded.full_name,
  draft_prs_gated = excluded.draft_prs_gated,
  threshold_wei = excluded.threshold_wei,
  input_mode = excluded.input_mode,
  input_value = excluded.input_value,
  spot_price_usd = excluded.spot_price_usd,
  spot_source = excluded.spot_source,
  spot_at = excluded.spot_at,
  spot_quote_id = excluded.spot_quote_id,
  spot_from_cache = excluded.spot_from_cache,
  updated_at = now();

insert into service_bot_keys (key_id, secret_hash, active, revoked_at, created_at)
values ('${BOT_KEY_ID}', 'sha256:${bot_secret_sha256}', true, null, now())
on conflict (key_id) do update set
  secret_hash = excluded.secret_hash,
  active = true,
  revoked_at = null;
SQL
}

run_test_flow() {
  info "Scenario 1: installation sync webhook through bot -> backend"
  local install_payload install_sig
  install_payload='{"action":"created","installation":{"id":123,"account":{"login":"owner","type":"User"}},"repositories":[{"id":999,"full_name":"owner/repo"}],"repositories_added":[],"repositories_removed":[]}'
  install_sig="$(hmac_sha256_hex_raw "$WEBHOOK_SECRET" "$install_payload")"
  curl -fsS -X POST "$BOT_URL/webhooks/github" \
    -H "content-type: application/json" \
    -H "x-github-event: installation" \
    -H "x-github-delivery: local-install-001" \
    -H "x-hub-signature-256: sha256=$install_sig" \
    --data "$install_payload" >/dev/null

  wait_nonempty_query "select 1 from github_event_deliveries where delivery_id = 'local-install-001' and event_name = 'installation'" 30 >/dev/null || fail "installation delivery was not recorded"
  wait_nonempty_query "select 1 from github_installation_repositories where installation_id = 123 and github_repo_id = 999 and active = true" 30 >/dev/null || fail "installation repository mapping was not written"

  info "Scenario 2: pull_request opened webhook -> challenge + gate comment"
  local pr_payload pr_sig
  pr_payload='{"action":"opened","installation":{"id":123},"repository":{"id":999,"full_name":"owner/repo"},"pull_request":{"number":7,"id":5007,"html_url":"https://github.com/owner/repo/pull/7","draft":false,"user":{"id":2002,"login":"contrib"},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}'
  pr_sig="$(hmac_sha256_hex_raw "$WEBHOOK_SECRET" "$pr_payload")"
  curl -fsS -X POST "$BOT_URL/webhooks/github" \
    -H "content-type: application/json" \
    -H "x-github-event: pull_request" \
    -H "x-github-delivery: local-pr-001" \
    -H "x-hub-signature-256: sha256=$pr_sig" \
    --data "$pr_payload" >/dev/null

  local challenge_id
  challenge_id="$(wait_nonempty_query "select id::text from pr_challenges where github_repo_id = 999 and github_pr_number = 7 order by created_at desc limit 1" 30)" || fail "challenge for PR #7 not created"
  wait_nonempty_query "select 1 from bot_actions where challenge_id = '${challenge_id}'::uuid and action_type = 'UPSERT_PR_COMMENT' and status = 'DONE'" 60 >/dev/null || fail "gate comment action was not executed"

  curl -fsS "$MOCK_GITHUB_URL/_state" | node -e '
let s="";
process.stdin.on("data", (d) => s += d).on("end", () => {
  const st = JSON.parse(s);
  const ok = st.comments.some((c) => c.thread === "owner/repo#7" && c.comments.some((m) => String(m.body).includes("sitg:gate:")));
  if (!ok) {
    console.error("gate marker comment not found in mock GitHub state");
    process.exit(1);
  }
});
'

  info "Scenario 3: manual close action -> bot closes PR + timeout comment"
  cat <<SQL | psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 >/dev/null
insert into bot_actions (
  id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name, github_pr_number,
  payload, status, claimed_at, completed_at, created_at, updated_at, claimed_by, failure_code, failure_reason, attempts
)
values (
  '00000000-0000-0000-0000-000000000071',
  'CLOSE_PR_WITH_COMMENT',
  null,
  123,
  999,
  'owner/repo',
  8,
  '{"comment_markdown":"Stake verification timed out.","comment_marker":"sitg:timeout:manual","reason":"CHALLENGE_TIMEOUT"}'::jsonb,
  'PENDING',
  null,
  null,
  now(),
  now(),
  null,
  null,
  null,
  0
)
on conflict (id) do update set
  status = 'PENDING',
  claimed_at = null,
  completed_at = null,
  claimed_by = null,
  failure_code = null,
  failure_reason = null,
  attempts = 0,
  updated_at = now();
SQL

  wait_nonempty_query "select 1 from bot_actions where id = '00000000-0000-0000-0000-000000000071'::uuid and status = 'DONE'" 60 >/dev/null || fail "close action was not completed"

  curl -fsS "$MOCK_GITHUB_URL/_state" | node -e '
let s="";
process.stdin.on("data", (d) => s += d).on("end", () => {
  const st = JSON.parse(s);
  const closed = st.pulls.some((p) => p.key === "owner/repo#8" && p.state === "closed");
  const timeout = st.comments.some((c) => c.thread === "owner/repo#8" && c.comments.some((m) => String(m.body).includes("sitg:timeout:manual")));
  if (!closed) {
    console.error("expected PR #8 to be closed by bot");
    process.exit(1);
  }
  if (!timeout) {
    console.error("expected timeout marker comment on PR #8");
    process.exit(1);
  }
});
'

  info "Local integration flow passed"
}

down_stack() {
  info "Stopping docker compose stack"
  dc down
}

logs_stack() {
  dc logs -f --tail=200 "${1:-}"
}

status_stack() {
  dc ps
}

usage() {
  cat <<EOF
Usage: scripts/e2e/local-loop.sh <command>

Commands:
  up         Start local stack (postgres + backend + bot + mock-github)
  seed       Seed DB for centralized v2 integration scenarios
  test       Run end-to-end v2 integration scenarios (requires stack up)
  run        up + seed + test
  restart    Restart backend and bot containers
  logs [svc] Tail compose logs (optionally for one service)
  ps         Show compose service status
  down       Stop stack
  nuke       Stop stack and remove volumes
EOF
}

main() {
  require_cmd docker
  require_cmd psql
  require_cmd curl
  require_cmd openssl
  require_cmd node

  local cmd="${1:-}"
  case "$cmd" in
    up)
      up_stack
      ;;
    seed)
      wait_db 60 || fail "Postgres is not ready"
      seed_db
      ;;
    test)
      wait_http "$BACKEND_URL/healthz" 30 || fail "Backend is not ready"
      wait_http "$BOT_URL/healthz" 30 || fail "Bot is not ready"
      wait_http "$MOCK_GITHUB_URL/healthz" 30 || fail "Mock GitHub is not ready"
      run_test_flow
      ;;
    run)
      up_stack
      seed_db
      run_test_flow
      ;;
    restart)
      dc restart backend bot
      ;;
    logs)
      logs_stack "${2:-}"
      ;;
    ps)
      status_stack
      ;;
    down)
      down_stack
      ;;
    nuke)
      info "Stopping stack and removing volumes"
      dc down -v
      ;;
    *)
      usage
      [[ -n "$cmd" ]] && exit 1
      ;;
  esac
}

main "$@"
