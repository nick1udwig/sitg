#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL_VALUE="${DATABASE_URL:-}"
KEY_ID=""
PRIVATE_KEY_FILE=""
ONLY_PRINT="false"

usage() {
  cat <<'USAGE'
Usage:
  provision-service-bot-key.sh [options]

Creates or rotates a centralized bot service key in backend-api table `service_bot_keys`.
Prints `BACKEND_BOT_KEY_ID` and `BACKEND_INTERNAL_SIGNING_KEY` for bot-worker env.

Options:
  --database-url <url>   Postgres connection URL (default: $DATABASE_URL)
  --key-id <id>          Key id to create/rotate (default: generated bck_live_<hex>)
  --private-key-file <path>
                         Existing Ed25519 private key PEM (default: generate a new key)
  --only-print           Do not write to DB; only print generated env values
  -h, --help             Show this help

Examples:
  DATABASE_URL='postgres://sitg:***@127.0.0.1:5432/sitg' ./deploy/scripts/provision-service-bot-key.sh
  ./deploy/scripts/provision-service-bot-key.sh --database-url 'postgres://sitg:***@127.0.0.1:5432/sitg' --key-id bck_live_prod_01
  ./deploy/scripts/provision-service-bot-key.sh --only-print
USAGE
}

fail() {
  printf '[bot-key] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

generate_key_id() {
  printf 'bck_live_%s' "$(openssl rand -hex 8)"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url)
      DATABASE_URL_VALUE="${2:-}"
      shift 2
      ;;
    --key-id)
      KEY_ID="${2:-}"
      shift 2
      ;;
    --private-key-file)
      PRIVATE_KEY_FILE="${2:-}"
      shift 2
      ;;
    --only-print)
      ONLY_PRINT="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

require_cmd openssl

if [[ -z "$KEY_ID" ]]; then
  KEY_ID="$(generate_key_id)"
fi
if [[ -n "$PRIVATE_KEY_FILE" ]]; then
  [[ -f "$PRIVATE_KEY_FILE" ]] || fail "Private key file does not exist: $PRIVATE_KEY_FILE"
  PRIVATE_KEY_PEM="$(<"$PRIVATE_KEY_FILE")"
else
  PRIVATE_KEY_PEM="$(openssl genpkey -algorithm ED25519 2>/dev/null)"
fi

[[ "$KEY_ID" =~ ^[A-Za-z0-9._:-]{8,128}$ ]] || fail "--key-id must be 8-128 chars from [A-Za-z0-9._:-]"
[[ -n "$PRIVATE_KEY_PEM" ]] || fail "Private key must not be empty"

PUBLIC_KEY_BASE64="$(printf '%s\n' "$PRIVATE_KEY_PEM" | openssl pkey -pubout -outform DER 2>/dev/null | openssl base64 -A)"
[[ -n "$PUBLIC_KEY_BASE64" ]] || fail "Unable to derive Ed25519 public key"

if [[ "$ONLY_PRINT" != "true" ]]; then
  require_cmd psql
  [[ -n "$DATABASE_URL_VALUE" ]] || fail "--database-url (or DATABASE_URL) is required unless --only-print is used"

  psql "$DATABASE_URL_VALUE" \
    --set=ON_ERROR_STOP=1 \
    --set=key_id="$KEY_ID" \
    --set=public_key="$PUBLIC_KEY_BASE64" <<'SQL' >/dev/null
insert into service_bot_keys (key_id, public_key, secret_hash, active, revoked_at, created_at)
values (:'key_id', :'public_key', null, true, null, now())
on conflict (key_id) do update set
  public_key = excluded.public_key,
  secret_hash = null,
  active = true,
  revoked_at = null;
SQL

  printf '[bot-key] Upserted active key in service_bot_keys: %s\n' "$KEY_ID" >&2
else
  printf '[bot-key] --only-print enabled; no DB write performed\n' >&2
fi

PRIVATE_KEY_ESCAPED="${PRIVATE_KEY_PEM//$'\n'/\\n}"
cat <<EOF2
# Set these in bot-worker env
BACKEND_BOT_KEY_ID=$KEY_ID
BACKEND_INTERNAL_SIGNING_KEY="$PRIVATE_KEY_ESCAPED"

# Optional. Keep empty unless your ingress/proxy enforces bearer auth for internal bot calls.
BACKEND_SERVICE_TOKEN=
EOF2
