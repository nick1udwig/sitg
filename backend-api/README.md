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
# GitHub OAuth callback URL: {API_BASE_URL}/api/v1/auth/github/callback
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export BASE_RPC_URL=https://mainnet.base.org
export STAKING_CONTRACT_ADDRESS=0x...
# optional: comma-separated wallets for local unlink stake-block simulation
export BLOCKED_UNLINK_WALLETS=0xabc...,0xdef...
```

GitHub OAuth notes:
- OAuth authorize scope includes `read:user public_repo`.
- Repo-owner authorization checks use the logged-in user's OAuth access token from session.

2. Apply SQL migrations in order:
- `migrations/0001_init.sql`
- `migrations/0002_auth_wallet.sql`
- `migrations/0003_internal_replay_and_outbox.sql`
- `migrations/0004_bot_action_results.sql`
- `migrations/0005_bot_tenant_auth.sql`
- `migrations/0006_user_sessions_github_access_token.sql`
- `migrations/0007_centralized_bot_reset.sql`
- `migrations/0008_bot_action_reliability.sql`
- `migrations/0009_internal_request_signatures.sql`
- `migrations/0010_quote_cache_lookup.sql`

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
- `x-sitg-nonce`: unique UUID for this HTTP attempt
- `x-sitg-signature`: `ed25519=<hex-signature>`

Signature payload format:

```text
{timestamp}.{nonce}.{message}.{sha256_hex(raw_request_body)}
```

Message values are documented in `docs/14-centralized-bot-interfaces.md`.

Internal replay protection:
- `(key_id, nonce)` pairs are single-use and persisted in `internal_request_replays`.
- Each retry must use a fresh nonce and signature.

Service auth model:
- `x-sitg-key-id` resolves to an active Ed25519 public key in `service_bot_keys`.
- Private signing keys exist only in bot-worker secret storage.

## Background Jobs

- Deadline sweeper: marks stale `PENDING` challenges and enqueues `bot_actions`.
- Retention cleanup: deletes `audit_events` + `pr_confirmations` older than 12 months.
