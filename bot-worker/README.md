# bot-worker

TypeScript GitHub App worker for Stake-to-Contribute.

## Endpoints

- `POST /webhooks/github`:
  - Verifies GitHub webhook signature (`X-Hub-Signature-256`).
  - Handles `pull_request` actions: `opened`, `reopened`, `synchronize`.
  - Forwards normalized payload to backend `POST /internal/v1/pr-events`.
  - Applies backend decision (`REQUIRE_STAKE`, `EXEMPT`, `ALREADY_VERIFIED`, `IGNORE`).
- `POST /internal/v1/deadlines/{challenge_id}/run`:
  - Runs backend deadline check (`POST /internal/v1/challenges/{challenge_id}/deadline-check`).
  - If backend returns `action: CLOSE_PR`, closes PR and posts timeout comment.
  - Intended as optional/manual fallback.
- `GET /healthz`
- `GET /metrics`:
  - Prometheus-style counters for webhook/deadline/error paths.

Primary deadline mode:

- Bot polls backend outbox via `POST /internal/v1/bot-actions/claim`.
- For each `CLOSE_PR`, bot executes GitHub close/comment and acks via `POST /internal/v1/bot-actions/{action_id}/result`.

## Runtime state

Bot state is persisted to `BOT_STATE_FILE`:

- idempotency keys (delivery/action/repo/pr),
- pending deadline jobs,
- repository installation mapping (`repo_id -> installation_id/full_name`).

This allows restart-safe dedup and deadline recovery.

Note: file-based state is single-instance only. For horizontal scaling, move state to a shared store.

## Setup

1. Copy `.env.example` to your environment.
   - Set `BACKEND_BOT_KEY_ID` and `BACKEND_INTERNAL_HMAC_SECRET` from bot key provisioning in SaaS.
   - Backend internal auth uses `x-stc-key-id`, `x-stc-timestamp`, and `x-stc-signature`.
   - `BACKEND_SERVICE_TOKEN` is optional and only used if your backend also accepts bearer auth.
   - Optional: set `GITHUB_API_BASE_URL` to a mock API for local E2E.
   - Set `WORKER_ID` to a stable identifier per running worker instance.
   - Keep `OUTBOX_POLLING_ENABLED=true` for normal operation.
   - `ENABLE_LOCAL_DEADLINE_TIMERS` should usually remain `false`.
2. Install dependencies:
   - `npm install`
3. Build:
   - `npm run build`
4. Run:
   - `npm start`

## Test

- `npm test`

## Operations

- See `bot-worker/OPERATIONS.md` for alerting, retry/idempotency behavior, and key rotation steps.
