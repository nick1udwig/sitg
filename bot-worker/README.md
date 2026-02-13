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
- `GET /healthz`

## Runtime state

Bot state is persisted to `BOT_STATE_FILE`:

- idempotency keys (delivery/action/repo/pr),
- pending deadline jobs,
- repository installation mapping (`repo_id -> installation_id/full_name`).

This allows restart-safe dedup and deadline recovery.

## Setup

1. Copy `.env.example` to your environment.
2. Install dependencies:
   - `npm install`
3. Build:
   - `npm run build`
4. Run:
   - `npm start`

## Test

- `npm test`
