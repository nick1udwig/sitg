#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -gt 0 ]]; then
  cat <<'EOF'
Usage: scripts/e2e/run.sh

Starts, seeds, and tests the maintained centralized-bot E2E stack.
For individual lifecycle commands, use scripts/e2e/local-loop.sh.
EOF
  if [[ "$1" == "--help" || "$1" == "-h" ]]; then
    exit 0
  fi
  exit 1
fi

exec "$ROOT_DIR/scripts/e2e/local-loop.sh" run
