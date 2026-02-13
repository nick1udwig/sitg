# 04 Database Schema (Postgres)

## Conventions

- All timestamps are `timestamptz`.
- Monetary ETH values are stored in wei using `numeric(78,0)`.
- IDs are UUID except GitHub IDs which remain numeric.

## Tables

### `users`

- `id uuid pk`
- `github_user_id bigint not null unique`
- `github_login text not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

### `wallet_links`

- `id uuid pk`
- `user_id uuid not null references users(id)`
- `wallet_address text not null`
- `chain_id int not null default 8453`
- `linked_at timestamptz not null`
- `unlinked_at timestamptz null`

Constraints:
- One active wallet per user: unique index on `(user_id)` where `unlinked_at is null`.
- One active user per wallet: unique index on `(wallet_address)` where `unlinked_at is null`.

### `github_installations`

- `installation_id bigint pk`
- `account_login text not null`
- `account_type text not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

### `repo_configs`

- `github_repo_id bigint pk`
- `installation_id bigint not null references github_installations(installation_id)`
- `full_name text not null` (e.g. `org/repo`)
- `draft_prs_gated boolean not null default true`
- `threshold_wei numeric(78,0) not null`
- `input_mode text not null check (input_mode in ('ETH','USD'))`
- `input_value numeric(38,18) not null`
- `spot_price_usd numeric(20,8) not null`
- `spot_source text not null` (for MVP: `coingecko`)
- `spot_at timestamptz not null`
- `spot_quote_id uuid null references spot_quotes(id)`
- `spot_from_cache boolean not null default false`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

### `repo_whitelist`

- `id uuid pk`
- `github_repo_id bigint not null references repo_configs(github_repo_id)`
- `github_user_id bigint not null`
- `github_login text not null`
- `created_at timestamptz not null`
- unique `(github_repo_id, github_user_id)`

### `pr_challenges`

- `id uuid pk`
- `gate_token text not null unique`
- `github_repo_id bigint not null`
- `github_repo_full_name text not null`
- `github_pr_number int not null`
- `github_pr_author_id bigint not null`
- `github_pr_author_login text not null`
- `head_sha char(40) not null`
- `threshold_wei_snapshot numeric(78,0) not null`
- `draft_at_creation boolean not null`
- `deadline_at timestamptz not null`
- `status text not null check (status in ('PENDING','VERIFIED','EXEMPT','TIMED_OUT_CLOSED','CANCELED'))`
- `verified_wallet_address text null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`

Indexes/constraints:
- Unique active challenge per PR: partial unique on `(github_repo_id, github_pr_number)` where `status in ('PENDING','VERIFIED','EXEMPT')`.

### `challenge_nonces`

- `nonce uuid pk`
- `challenge_id uuid not null unique references pr_challenges(id)`
- `expires_at timestamptz not null`
- `used_at timestamptz null`
- `created_at timestamptz not null`

### `pr_confirmations`

- `id uuid pk`
- `challenge_id uuid not null unique references pr_challenges(id)`
- `signature text not null`
- `signer_address text not null`
- `typed_data jsonb not null`
- `created_at timestamptz not null`

### `audit_events`

- `id uuid pk`
- `event_type text not null`
- `entity_type text not null`
- `entity_id text not null`
- `payload jsonb not null`
- `created_at timestamptz not null`

### `spot_quotes`

- `id uuid pk`
- `source text not null` (for MVP: `coingecko`)
- `pair text not null` (for MVP: `ETH_USD`)
- `price numeric(20,8) not null`
- `fetched_at timestamptz not null`
- `expires_at timestamptz not null` (`fetched_at + 5 minutes`)
- `created_at timestamptz not null`

Indexes:
- `(source, pair, fetched_at desc)` for latest quote lookup.

## Important constraints

1. Wallet unlink
- API must reject unlink when on-chain `stakedBalance(wallet) > 0`.

2. Threshold updates
- Updating `repo_configs.threshold_wei` affects only new challenges.
- `pr_challenges.threshold_wei_snapshot` remains immutable after challenge creation.

3. Whitelist timing
- Auto-close job checks whitelist at deadline time.
- If author is whitelisted at deadline, do not close.

4. USD input conversion caching
- On USD mode save, backend should try live CoinGecko quote first.
- If live fetch fails, backend uses latest cached quote if available (even if stale).
- Selected quote should be linked via `repo_configs.spot_quote_id`.

5. Retention
- Retain rows in `audit_events` and `pr_confirmations` for 12 months.
- After 12 months, delete or anonymize per ops policy.
