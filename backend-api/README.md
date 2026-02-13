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
```

2. Apply SQL migration `migrations/0001_init.sql` to Postgres.

3. Start server:

```bash
cargo run
```

## Test

```bash
cargo test
```
