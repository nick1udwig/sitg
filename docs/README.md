# Stake-to-Contribute Docs

This folder is the top-level product and engineering spec for MVP.

## MVP decisions locked so far

- Stake is global per contributor wallet.
- Repo requirements are per-repo and enforced in ETH.
- Repo owner can input ETH or USD; backend stores ETH only, using CoinGecko spot at save time.
- PR challenges are strict close after 30 minutes if not verified.
- Whitelist supported per repo. If user is whitelisted at deadline, do not close.
- Whitelist management is restricted to the repo owner through the SaaS site.
- Wallet mapping is one active wallet per GitHub account and one active GitHub account per wallet.
- Wallet unlink is blocked while that wallet has non-zero staked balance.
- Draft PR gating is configurable per repo, default `true`.
- No mobile support (desktop only).
- Public repos only in MVP.
- Launch scope is global for MVP.
- Sanctions screening/geoblocking is deferred for MVP.
- Smart contract is minimal and fixed 30-day lock duration, no `extendLock()`.
- Backend stack: Rust.
- Frontend stack: TypeScript + Vite.
- Bot stack: TypeScript.
- DB: Postgres.
- USD-input conversion uses CoinGecko spot with 5-minute cache TTL.
- If CoinGecko is unavailable at save time, backend uses last cached spot.
- Verification is point-in-time: later stake changes do not retroactively invalidate an already-verified PR challenge.
- Retention policy: keep `audit_events` and signature records for 12 months.
- Deployment model: many repo owners can run their own bot workers.
- Bot auth model: tenant-scoped bot credentials (`key_id` + HMAC secret), not a single global internal secret.
- Backend authorizes bot requests by installation/repo binding to prevent cross-tenant actions.
- Installation binding model: exactly one active bot client per GitHub installation.

## Document index

- `docs/01-overview.md`
- `docs/02-architecture.md`
- `docs/03-smart-contract.md`
- `docs/04-database-schema.md`
- `docs/05-backend-api.md`
- `docs/06-github-bot.md`
- `docs/07-frontend.md`
- `docs/08-post-mvp.md`
- `docs/09-open-questions.md`
- `docs/10-plan-changes-summary.md`
- `docs/11-e2e-harness.md`
- `docs/12-test-coverage-checklist.md`
