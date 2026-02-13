# backend-api

Rust backend for Stake-to-Contribute MVP.

## Stack

- `axum`
- `sqlx` + Postgres
- `tokio`

## Run

1. Set env vars:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/stake_to_contribute
export HOST=0.0.0.0
export PORT=8080
export APP_BASE_URL=https://app.example.com
export API_BASE_URL=http://localhost:8080
export GITHUB_CLIENT_ID=...
export GITHUB_CLIENT_SECRET=...
export INTERNAL_HMAC_SECRET=...
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
- `x-stc-timestamp`: unix seconds
- `x-stc-signature`: `sha256=<hex-hmac>`

Signature payload format:

```text
{timestamp}.{message}
```

Where message is:
- `/internal/v1/pr-events`: `delivery_id`
- `/internal/v1/challenges/{id}/deadline-check`: `challenge_id`
