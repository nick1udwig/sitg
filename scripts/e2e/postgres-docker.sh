#!/usr/bin/env bash
set -euo pipefail

PG_CONTAINER="sitg-e2e-postgres"
LEGACY_PG_CONTAINER="stc-e2e-postgres"
POSTGRES_PORT="55432"
POSTGRES_USER="postgres"
POSTGRES_PASSWORD="postgres"
POSTGRES_DB="sitg"
POSTGRES_IMAGE="postgres:16-alpine"

usage() {
  cat <<'EOF'
Usage:
  postgres-docker.sh [options] up
  postgres-docker.sh [options] wait-ready [timeout_seconds]
  postgres-docker.sh [options] down

Options:
  --container <name>   Container name (default: sitg-e2e-postgres)
  --port <port>        Host port mapped to 5432 (default: 55432)
  --user <user>        Postgres user (default: postgres)
  --password <pass>    Postgres password (default: postgres)
  --db <name>          Postgres database name (default: sitg)
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

container_exists() {
  local name="$1"
  docker container inspect "$name" >/dev/null 2>&1
}

remove_container_if_exists() {
  local name="$1"
  if container_exists "$name"; then
    docker rm -f "$name"
  fi
}

validate_port_conflicts() {
  local name
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ "$name" == "$PG_CONTAINER" || "$name" == "$LEGACY_PG_CONTAINER" ]]; then
      continue
    fi
    fail "Port ${POSTGRES_PORT} is already used by container '${name}'. Stop/remove it or use --port."
  done < <(docker ps -a --filter "publish=${POSTGRES_PORT}" --format '{{.Names}}')
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
    remove_container_if_exists "$PG_CONTAINER"
    # Backward-compat cleanup for previous default name.
    if [[ "$PG_CONTAINER" == "sitg-e2e-postgres" ]]; then
      remove_container_if_exists "$LEGACY_PG_CONTAINER"
    fi
    validate_port_conflicts
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
    removed="0"
    if container_exists "$PG_CONTAINER"; then
      docker rm -f "$PG_CONTAINER"
      removed="1"
    fi
    # Backward-compat cleanup for previous default name.
    if [[ "$PG_CONTAINER" == "sitg-e2e-postgres" ]] && container_exists "$LEGACY_PG_CONTAINER"; then
      docker rm -f "$LEGACY_PG_CONTAINER"
      removed="1"
    fi
    if [[ "$removed" == "0" ]]; then
      printf '[pg-docker] Container not found, nothing to remove: %s\n' "$PG_CONTAINER"
    fi
    ;;
  *)
    fail "Unknown command: $command_name"
    ;;
esac
