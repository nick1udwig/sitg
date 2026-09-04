#!/usr/bin/env bash

set -euo pipefail

readonly required_version="cccc 1.6.0"
repo_root=$(git rev-parse --show-toplevel)
cccc_bin=${CCCC_BIN:-cccc}

if ! command -v "$cccc_bin" >/dev/null 2>&1; then
  echo "Complexity check requires ${required_version}. Install it or set CCCC_BIN to its executable." >&2
  exit 127
fi

actual_version=$("$cccc_bin" --version 2>/dev/null || true)
if [[ "$actual_version" != "$required_version" ]]; then
  echo "Complexity check requires ${required_version}; found ${actual_version:-an unknown version}." >&2
  exit 2
fi

if "$cccc_bin" \
  --config "$repo_root/cccc.toml" \
  --no-cache \
  --min 21 \
  "$repo_root" >/dev/null; then
  echo "Complexity check passed: every supported function is at or below 20/20."
else
  status=$?
  echo "Complexity check failed: functions above the 20/20 limit follow." >&2
  "$cccc_bin" \
    --config "$repo_root/cccc.toml" \
    --no-cache \
    --min 21 \
    --table \
    "$repo_root" >&2 || true
  exit "$status"
fi
