#!/usr/bin/env bash
set -euo pipefail

DB_NAME="sitg"
DB_USER="sitg"
DB_PASSWORD=""
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"
PGHOST_VALUE="${PGHOST_VALUE:-}"
PGPORT_VALUE="${PGPORT_VALUE:-}"

usage() {
  cat <<'EOF'
Usage:
  bootstrap-postgres.sh --password <db_password> [options]

Options:
  --db <name>           Database name (default: sitg)
  --user <name>         Database user/role (default: sitg)
  --password <value>    Database user password (required)
  --superuser <name>    Postgres admin role used by psql (default: postgres)
  --host <host>         Optional Postgres host
  --port <port>         Optional Postgres port
  -h, --help            Show this help

Examples:
  sudo -u postgres ./deploy/scripts/bootstrap-postgres.sh --superuser postgres --password 'change_me'
  PGPASSWORD='postgres_admin_password' ./deploy/scripts/bootstrap-postgres.sh --host 127.0.0.1 --port 5432 --superuser postgres --password 'change_me'
  PGPASSWORD='postgres' ./deploy/scripts/bootstrap-postgres.sh --host 127.0.0.1 --port 55432 --superuser postgres --password 'change_me'
  ./deploy/scripts/bootstrap-postgres.sh --superuser "$USER" --password 'change_me'
EOF
}

fail() {
  printf '[pg-bootstrap] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB_NAME="${2:-}"
      shift 2
      ;;
    --user)
      DB_USER="${2:-}"
      shift 2
      ;;
    --password)
      DB_PASSWORD="${2:-}"
      shift 2
      ;;
    --superuser)
      PG_SUPERUSER="${2:-}"
      shift 2
      ;;
    --host)
      PGHOST_VALUE="${2:-}"
      shift 2
      ;;
    --port)
      PGPORT_VALUE="${2:-}"
      shift 2
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

[[ -n "$DB_PASSWORD" ]] || fail "--password is required"

require_cmd psql

PSQL_COMMON=(--set=ON_ERROR_STOP=1 --username "$PG_SUPERUSER")
if [[ -n "$PGHOST_VALUE" ]]; then
  PSQL_COMMON+=(--host "$PGHOST_VALUE")
fi
if [[ -n "$PGPORT_VALUE" ]]; then
  PSQL_COMMON+=(--port "$PGPORT_VALUE")
fi

printf '[pg-bootstrap] Ensuring role/database exist: role=%s db=%s\n' "$DB_USER" "$DB_NAME"

psql "${PSQL_COMMON[@]}" --dbname postgres \
  --set=db_name="$DB_NAME" \
  --set=db_user="$DB_USER" \
  --set=db_password="$DB_PASSWORD" <<'SQL'
select format('create role %I login password %L', :'db_user', :'db_password')
where not exists (select 1 from pg_roles where rolname = :'db_user')
\gexec

select format('alter role %I with login password %L', :'db_user', :'db_password')
\gexec

select format('create database %I owner %I', :'db_name', :'db_user')
where not exists (select 1 from pg_database where datname = :'db_name')
\gexec

select format('alter database %I owner to %I', :'db_name', :'db_user')
\gexec

select format('grant all privileges on database %I to %I', :'db_name', :'db_user')
\gexec
SQL

psql "${PSQL_COMMON[@]}" --dbname "$DB_NAME" -c 'create extension if not exists "pgcrypto";' >/dev/null

printf '[pg-bootstrap] Done. Connection URL template:\n'
printf 'postgres://%s:***@127.0.0.1:5432/%s\n' "$DB_USER" "$DB_NAME"
