# backend-api

Rust backend for SITG MVP.

Production runbook: `docs/13-production-runbook.md`

## Stack

- `axum`
- `sqlx` + Postgres
- `tokio`

## Run

1. Set env vars:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/sitg
export HOST=0.0.0.0
export PORT=8080
export APP_BASE_URL=https://sitg.io
export API_BASE_URL=http://localhost:8080
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export GITHUB_OWNER_CHECK_TOKEN=... # token used for repo permission checks
export BASE_RPC_URL=https://mainnet.base.org
export STAKING_CONTRACT_ADDRESS=0x...
# optional: comma-separated wallets for local unlink stake-block simulation
export BLOCKED_UNLINK_WALLETS=0xabc...,0xdef...
# optional: when set, internal bot endpoints require this shared token
export INTERNAL_HMAC_SECRET=replace_me
```

2. Apply SQL migrations in order:
- `migrations/0001_init.sql`
- `migrations/0002_auth_wallet.sql`
- `migrations/0003_internal_replay_and_outbox.sql`
- `migrations/0004_bot_action_results.sql`
- `migrations/0005_bot_tenant_auth.sql`

Note: service startup also runs embedded migrations automatically.

3. Start server:

```bash
cargo run
```

## Test

```bash
cargo test
```

## Internal Endpoint Auth

Internal endpoints require:
- `x-sitg-key-id`: bot key id
- `x-sitg-timestamp`: unix seconds
- `x-sitg-signature`: `sha256=<hex-hmac>`

Signature payload format:

```text
{timestamp}.{message}
```

Where message is:
- `/internal/v1/pr-events`: `delivery_id`
- `/internal/v1/challenges/{id}/deadline-check`: `challenge_id`
- `/internal/v1/bot-actions/claim`: `bot-actions-claim:{worker_id}`
- `/internal/v1/bot-actions/{action_id}/result`: `bot-action-result:{action_id}:{worker_id}:{success}`

Internal replay protection:
- Signatures are single-use and persisted in `internal_request_replays`.

Tenant auth model:
- `x-sitg-key-id` resolves to `bot_client_keys`.
- Requests are authorized against `bot_installation_bindings`.

## Background Jobs

- Deadline sweeper: marks stale `PENDING` challenges and enqueues `bot_actions`.
- Retention cleanup: deletes `audit_events` + `pr_confirmations` older than 12 months.
