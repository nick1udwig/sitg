#!/usr/bin/env bash
set -euo pipefail

PG_CONTAINER="stc-e2e-postgres"
POSTGRES_PORT="55432"
POSTGRES_USER="postgres"
POSTGRES_PASSWORD="postgres"
POSTGRES_DB="stake_to_contribute"
POSTGRES_IMAGE="postgres:16-alpine"

usage() {
  cat <<'EOF'
Usage:
  postgres-docker.sh [options] up
  postgres-docker.sh [options] wait-ready [timeout_seconds]
  postgres-docker.sh [options] down

Options:
  --container <name>   Container name (default: stc-e2e-postgres)
  --port <port>        Host port mapped to 5432 (default: 55432)
  --user <user>        Postgres user (default: postgres)
  --password <pass>    Postgres password (default: postgres)
  --db <name>          Postgres database name (default: stake_to_contribute)
  --image <image>      Docker image (default: postgres:16-alpine)
EOF
}

fail() {
  printf '[pg-docker] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container)
      PG_CONTAINER="${2:-}"
      shift 2
      ;;
    --port)
      POSTGRES_PORT="${2:-}"
      shift 2
      ;;
    --user)
      POSTGRES_USER="${2:-}"
      shift 2
      ;;
    --password)
      POSTGRES_PASSWORD="${2:-}"
      shift 2
      ;;
    --db)
      POSTGRES_DB="${2:-}"
      shift 2
      ;;
    --image)
      POSTGRES_IMAGE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    up|wait-ready|down)
      break
      ;;
    *)
      fail "Unknown option or command: $1"
      ;;
  esac
done

command_name="${1:-}"
[[ -n "$command_name" ]] || fail "Missing command"
shift || true

require_cmd docker

case "$command_name" in
  up)
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    docker run -d \
      --name "$PG_CONTAINER" \
      -e POSTGRES_USER="$POSTGRES_USER" \
      -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
      -e POSTGRES_DB="$POSTGRES_DB" \
      -p "${POSTGRES_PORT}:5432" \
      "$POSTGRES_IMAGE" >/dev/null
    ;;
  wait-ready)
    timeout="${1:-60}"
    for _ in $(seq 1 "$timeout"); do
      if docker exec -i "$PG_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        exit 0
      fi
      sleep 1
    done
    fail "Postgres did not become ready within ${timeout}s"
    ;;
  down)
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    ;;
  *)
    fail "Unknown command: $command_name"
    ;;
esac
