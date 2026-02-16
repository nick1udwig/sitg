#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL_VALUE="${DATABASE_URL:-}"
KEY_ID=""
RAW_SECRET=""
ONLY_PRINT="false"

usage() {
  cat <<'USAGE'
Usage:
  provision-service-bot-key.sh [options]

Creates or rotates a centralized bot service key in backend-api table `service_bot_keys`.
Prints `BACKEND_BOT_KEY_ID` and `BACKEND_INTERNAL_HMAC_SECRET` for bot-worker env.

Options:
  --database-url <url>   Postgres connection URL (default: $DATABASE_URL)
  --key-id <id>          Key id to create/rotate (default: generated bck_live_<hex>)
  --secret <secret>      Raw secret to use (default: generated random secret)
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

sha256_hex() {
  local value="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$value" | shasum -a 256 | awk '{print $1}'
    return
  fi
  fail "Missing required command: sha256sum (or shasum)"
}

generate_key_id() {
  printf 'bck_live_%s' "$(openssl rand -hex 8)"
}

generate_secret() {
  openssl rand -base64 48 | tr -d '\n'
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
    --secret)
      RAW_SECRET="${2:-}"
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
if [[ -z "$RAW_SECRET" ]]; then
  RAW_SECRET="$(generate_secret)"
fi

[[ "$KEY_ID" =~ ^[A-Za-z0-9._:-]{8,128}$ ]] || fail "--key-id must be 8-128 chars from [A-Za-z0-9._:-]"
[[ -n "$RAW_SECRET" ]] || fail "Secret must not be empty"

SECRET_HASH="sha256:$(sha256_hex "$RAW_SECRET")"

if [[ "$ONLY_PRINT" != "true" ]]; then
  require_cmd psql
  [[ -n "$DATABASE_URL_VALUE" ]] || fail "--database-url (or DATABASE_URL) is required unless --only-print is used"

  psql "$DATABASE_URL_VALUE" \
    --set=ON_ERROR_STOP=1 \
    --set=key_id="$KEY_ID" \
    --set=secret_hash="$SECRET_HASH" <<'SQL' >/dev/null
insert into service_bot_keys (key_id, secret_hash, active, revoked_at, created_at)
values (:'key_id', :'secret_hash', true, null, now())
on conflict (key_id) do update set
  secret_hash = excluded.secret_hash,
  active = true,
  revoked_at = null;
SQL

  printf '[bot-key] Upserted active key in service_bot_keys: %s\n' "$KEY_ID" >&2
else
  printf '[bot-key] --only-print enabled; no DB write performed\n' >&2
fi

cat <<EOF2
# Set these in bot-worker env
BACKEND_BOT_KEY_ID=$KEY_ID
BACKEND_INTERNAL_HMAC_SECRET=$RAW_SECRET

# Optional. Keep empty unless your ingress/proxy enforces bearer auth for internal bot calls.
BACKEND_SERVICE_TOKEN=
EOF2
