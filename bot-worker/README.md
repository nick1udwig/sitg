# bot-worker

TypeScript GitHub App worker for SITG.

Production runbook: `docs/13-production-runbook.md`
Canonical interface contract: `docs/14-centralized-bot-interfaces.md`

## Endpoints

- `POST /webhooks/github`:
  - Verifies GitHub webhook signature (`X-Hub-Signature-256`).
  - Handles events:
    - `pull_request` actions: `opened`, `reopened`, `synchronize`
    - `installation` actions: `created`, `deleted`, `suspend`, `unsuspend`
    - `installation_repositories` actions: `added`, `removed`
  - Forwards normalized payloads to backend:
    - `POST /internal/v2/github/events/pull-request`
    - `POST /internal/v2/github/events/installation-sync`
- `GET /healthz`
- `GET /metrics`

## Runtime model

- Worker is stateless for correctness.
- No local file-backed dedup, deadline scheduling, or repo-install mapping is required.
- Backend is source of truth for deduplication, installation mappings, challenge state, and outbox lifecycle.

## Outbox execution

- Polls backend: `POST /internal/v2/bot-actions/claim`
- Executes action types:
  - `UPSERT_PR_COMMENT`
  - `CLOSE_PR_WITH_COMMENT`
- Reports result: `POST /internal/v2/bot-actions/{action_id}/result`
  - outcomes: `SUCCEEDED`, `RETRYABLE_FAILURE`, `FAILED`

## Setup

1. Set environment variables:
   - `GITHUB_WEBHOOK_SECRET`
   - `GITHUB_APP_ID`
   - `GITHUB_APP_PRIVATE_KEY`
   - `BACKEND_BASE_URL`
   - `BACKEND_BOT_KEY_ID`
   - `BACKEND_INTERNAL_HMAC_SECRET`
   - Optional: `BACKEND_SERVICE_TOKEN`
   - Optional: `GITHUB_API_BASE_URL` (for local mock API)
   - Optional: `WORKER_ID`
   - Optional: `OUTBOX_POLLING_ENABLED` (`true` by default)
   - Optional: `OUTBOX_POLL_INTERVAL_MS` (default `5000`)
   - Optional: `OUTBOX_CLAIM_LIMIT` (default `25`)
2. Install dependencies:
   - `npm install`
3. Build:
   - `npm run build`
4. Run:
   - `npm start`

## Test

- `npm test`

## Operations

- See `bot-worker/OPERATIONS.md` for alerting, retry behavior, and key rotation steps.
