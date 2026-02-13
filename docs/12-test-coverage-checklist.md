# 12 Test Coverage Checklist

This checklist tracks what is currently covered by automated tests and what is still intentionally out of scope.

## Covered by automated tests

- Backend route logic:
  - `internal_pr_events` require-stake happy path (through bot webhook ingestion).
  - `internal_deadline_check` close path (`CLOSE_PR`) and whitelist no-op path (`NOOP` + status transition to `EXEMPT`).
  - `internal_bot_actions_claim` happy path (bot outbox polling).
  - `internal_bot_action_result` done path (bot ack), retryable path (`PENDING`), failed path (`FAILED`), and conflict path (`BOT_ACTION_NOT_CLAIMED_BY_WORKER`).
  - Internal replay protection (`internal_request_replays`) duplicate-signature rejection (`403`).
  - Gate APIs: `GET /api/v1/gate/{token}`, typed data fetch, and confirm signature flow to `VERIFIED`.
  - Wallet APIs: link challenge, link confirm (personal sign), unlink conflict while stake is present, unlink success after stake removal.
  - Session behavior: `/api/v1/me` unauthenticated and authenticated.

- Bot worker:
  - Webhook parsing/signature checks.
  - `REQUIRE_STAKE` decision handling and gate comment upsert.
  - Outbox polling, claim, execute close, and result ack.
  - Deadline recovery from persisted state and direct deadline-run endpoint auth rejection.
  - HMAC internal signing logic for backend calls.

- Smart contract:
  - Stake, lock reset behavior, unlock boundary checks.
  - Withdraw and withdraw-to flows.
  - Reentrancy resistance behavior.
  - Accounting views (`totalStaked`, `excessBalance`) under forced ETH and withdrawals.
  - Fuzz coverage for stake/withdraw behavior.

- Frontend:
  - API client request/response/error mapping coverage.
  - Owner setup interactions: repo selection, config save, whitelist flow, bot client/key/bindings actions.
  - Wallet page interactions: link flow (including chain switch) and unlink action.
  - Gate page interactions: link wallet + typed-data confirmation flow, wrong-account blocking behavior.
  - State context behavior and basic page smoke coverage.

## Still not fully covered (known gaps)

- Real GitHub OAuth provider integration (`/auth/github/callback` token exchange + user fetch against live GitHub).
- Real GitHub API side effects (live PR comments/close) beyond local mock API behavior.
- Real CoinGecko quote retrieval path and cache fallback behavior under live outage conditions.
- Browser-level E2E in a real headless browser engine for full rendering/network stack validation.
  - Current FE coverage uses Vitest + jsdom interaction tests (high-value logic coverage, not full browser engine).
- Multi-replica/distributed bot-worker behavior under concurrent claims and restarts.
- Non-public/private-repo behavior (MVP is public-only).

## Recommended next coverage increments

1. Add browser-engine E2E (Playwright) for Owner/Wallet/Gate journeys against local harness stack.
2. Add fault-injection tests for quote service fallback and GitHub API transient failures.
3. Add concurrent worker claim tests against one shared backend database.
