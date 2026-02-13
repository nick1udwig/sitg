# 10 Plan Changes Summary

This document summarizes how the plan evolved from the initial MVP outline to the current implementation-ready specification.

## Product-level changes

- Stake is global per contributor wallet, with per-repo thresholds.
- Enforcement is always in ETH.
- Repo owner can input threshold in ETH or USD; backend converts USD to ETH at save time.
- Threshold updates apply only to new PR challenges.
- Draft PR gating is configurable per repo (default `true`).
- Strict-close behavior for MVP remains in place.
- Whitelist is supported and checked again at deadline; if whitelisted at deadline, do not close.
- Whitelist management is repo-owner-only in SaaS.

## Smart contract changes

- Contract kept intentionally minimal:
- `stake() payable`
- `withdraw(uint256 amountWei)`
- view methods for `stakedBalance`, `unlockTime`, `isStakeActive`, `lockDuration`
- No `extendLock()`.
- Lock duration fixed at deployment to 30 days.
- Restaking resets unlock time to `now + 30 days`.
- Eligibility requires both sufficient balance and active lock.

## Frontend changes

- Desktop-only scope (no mobile support planned).
- Repo setup UX must clearly message:
- ETH is the enforcement unit.
- USD is informational/estimate.
- Repo-owner setup includes:
- threshold config (ETH/USD input),
- draft gating toggle,
- whitelist management,
- bot client credential management,
- installation binding management with conflict handling.

## Backend/API changes

- Backend stack fixed to Rust.
- Added USD conversion rules:
- CoinGecko spot source,
- 5-minute cache TTL,
- fallback to last cached quote,
- fail with `503 PRICE_UNAVAILABLE` if no quote exists.
- Verification semantics fixed as point-in-time for a PR challenge.
- Added stronger internal API contracts:
- HMAC auth headers for internal bot calls,
- replay protection with single-use signatures,
- explicit deadline-check response shape (`NOOP` / `CLOSE_PR`).

## Multi-tenant bot model changes

- Deployment model changed to many owner-run bot workers.
- Internal bot auth changed from one global secret to tenant-scoped credentials:
- `x-stc-key-id` + HMAC secret.
- Backend authorizes each internal request by bot-to-installation binding.
- Added owner-facing bot management APIs:
- create/list bot clients,
- create/revoke bot keys,
- manage installation bindings.

## Deadline execution model changes

- Backend outbox claim/ack is now the primary deadline-close path:
- backend enqueues `bot_actions`,
- bot polls `/internal/v1/bot-actions/claim`,
- bot executes GitHub action,
- bot posts `/result` ack.
- Legacy direct `deadline-check` endpoint remains as optional/manual fallback.

## Database/schema changes

- Added pricing persistence support:
- `spot_quotes`,
- `repo_configs.spot_*` metadata fields.
- Added tenant-scoped bot auth/binding tables:
- `bot_clients`,
- `bot_client_keys`,
- `bot_installation_bindings`.
- Added outbox + replay tables:
- `bot_actions`,
- `internal_request_replays`.
- Added `pr_challenges.created_by_bot_client_id` for traceability.
- Added retention policy requirements:
- keep `audit_events` and `pr_confirmations` for 12 months.

## Installation binding decision

- Final decision: exactly one active bot client per GitHub installation.
- This still allows that bot to handle multiple repos under that installation.
- Binding conflicts must return `409 INSTALLATION_ALREADY_BOUND`.

## Launch/compliance scope changes

- Launch scope set to global.
- Sanctions screening/geoblocking explicitly deferred for MVP.
- Public repos only in MVP.
- Private repos moved to post-MVP.

## Post-MVP updates

- Passkey-based embedded wallet is first post-MVP item.
- Add user-requested PR reopen flow after strict-close.

