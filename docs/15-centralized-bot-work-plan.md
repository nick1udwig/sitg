# 15 Centralized Bot Work Plan (Parallel Execution)

Reference contract: `docs/14-centralized-bot-interfaces.md`

No backward compatibility is required. Delete old paths and old behavior directly.

## Part 1: backend-api

### BA-1 Schema And State Model Reset

Owner: backend-api

Deliverables:

- Remove owner-bot tenant tables and dependencies:
  - `bot_clients`
  - `bot_client_keys`
  - `bot_installation_bindings`
- Add/expand installation source-of-truth tables:
  - `github_installations` (active lifecycle fields)
  - `github_installation_repositories`
- Add durable webhook dedup table keyed by delivery id + event name.
- Update `bot_actions` schema to carry full execution payload:
  - `installation_id`
  - `repo_full_name`
  - v2 action type enums and payload fields from canonical doc.

Parallelization:

- Can start immediately.
- Unblocks BA-2, BA-3, BA-4, BA-5.

### BA-2 Installation Sync Ingest Endpoint

Owner: backend-api

Deliverables:

- Implement `POST /internal/v2/github/events/installation-sync`.
- Support events listed in canonical doc:
  - `installation` (`created`, `deleted`, `suspend`, `unsuspend`)
  - `installation_repositories` (`added`, `removed`)
- Upsert installation account metadata and repo membership.
- Enforce delivery dedup (`ACCEPTED|DUPLICATE|IGNORED`).

Parallelization:

- Depends on BA-1 schema.
- Can run in parallel with BA-3 and BA-4 once schema exists.

### BA-3 Pull Request Ingest Endpoint

Owner: backend-api

Deliverables:

- Implement `POST /internal/v2/github/events/pull-request`.
- Move webhook idempotency to backend dedup table.
- Keep challenge decision logic (draft rules, whitelist, verified/no-op).
- Enqueue outbox actions for gate/exempt comments as `UPSERT_PR_COMMENT`.
- Return canonical ingest response shape.

Parallelization:

- Depends on BA-1 schema.
- Can run in parallel with BA-2.

### BA-4 Outbox Claim/Result v2

Owner: backend-api

Deliverables:

- Replace v1 claim/result with:
  - `POST /internal/v2/bot-actions/claim`
  - `POST /internal/v2/bot-actions/{action_id}/result`
- Return action payloads with all execution fields so bot is stateless.
- Implement result outcomes:
  - `SUCCEEDED`
  - `RETRYABLE_FAILURE`
  - `FAILED`
- Keep atomic claim semantics (`FOR UPDATE SKIP LOCKED` style behavior).

Parallelization:

- Depends on BA-1 schema.
- Can run in parallel with BA-2 and BA-3.
- Unblocks bot workstream BOT-3.

### BA-5 Deadline And Action Producer Update

Owner: backend-api

Deliverables:

- Update deadline sweeper and challenge timeout paths to enqueue v2 `CLOSE_PR_WITH_COMMENT`.
- Remove legacy direct-close/manual `deadline-check` endpoint behavior from runtime contract.
- Ensure all bot side effects are represented as outbox actions.

Parallelization:

- Depends on BA-4 action schema/types.
- Can run in parallel with BA-6 and BA-7.

### BA-6 Required Bugfixes (Owner API + Repo Install Status)

Owner: backend-api

Deliverables:

- Implement `GET /api/v1/repos/{repo_id}/github-app-status`.
- Remove dead/missing endpoint mismatch with frontend (`/api/v1/github/installations/status?repo_id=...`).
- Ensure repo install status resolves from installation sync tables, not guessed owner-login mapping.

Parallelization:

- Depends on BA-1 schema.
- Independent of BA-4.

### BA-7 Required Bugfixes (Old Bot API Removal)

Owner: backend-api

Deliverables:

- Remove old bot client/key/binding routes and service logic.
- Remove strict `account_login == github_login` binding check path entirely.
- Remove no-longer-used internal auth tenant-binding checks tied to old tables.

Parallelization:

- Can start immediately after BA-1 planning.
- Can run in parallel with BA-2/BA-3/BA-4.

### BA-8 Test Plan

Owner: backend-api

Required tests:

- Installation sync ingest:
  - `installation created/deleted/suspend/unsuspend`
  - `installation_repositories added/removed`
  - duplicate delivery handling
- Pull request ingest:
  - `ACCEPTED`, `DUPLICATE`, `IGNORED`
  - draft gating rules
  - whitelist/exempt rules
- Outbox:
  - claim concurrency correctness
  - result transition correctness (`DONE`, requeue `PENDING`, terminal `FAILED`)
- Deadline producer:
  - `PENDING` challenge -> `CLOSE_PR_WITH_COMMENT` action enqueued
- Owner API:
  - `GET /api/v1/repos/{repo_id}/github-app-status` correctness

Parallelization:

- Starts once BA-2/BA-3/BA-4/BA-6 have first complete implementations.

### backend-api File Touch Map

- `backend-api/migrations/*` (new migration set for reset)
- `backend-api/src/routes/mod.rs`
- `backend-api/src/models/api.rs`
- `backend-api/src/models/db.rs`
- `backend-api/src/services/internal_auth.rs`
- `backend-api/src/services/jobs.rs`
- `backend-api/tests/*`

## Part 2: bot-worker

### BOT-1 Stateless Runtime Reset

Owner: bot-worker

Deliverables:

- Remove local deadline scheduling behavior.
- Remove file-backed dedup dependency from control flow.
- Remove repo-installation lookup dependency from local state.
- Keep process-safe retries and execution idempotency at API/GitHub layer.

Parallelization:

- Can start immediately.
- Independent of backend implementation details.

### BOT-2 Webhook Event Router (GitHub -> Backend v2)

Owner: bot-worker

Deliverables:

- Accept GitHub webhook events:
  - `pull_request`
  - `installation`
  - `installation_repositories`
- Normalize and forward to:
  - `POST /internal/v2/github/events/pull-request`
  - `POST /internal/v2/github/events/installation-sync`
- Remove local webhook dedup as a correctness mechanism (backend is source of truth).

Parallelization:

- Depends on canonical request contracts.
- Can run in parallel with BOT-1.

### BOT-3 Action Executor v2

Owner: bot-worker

Deliverables:

- Consume new claim response action types:
  - `UPSERT_PR_COMMENT`
  - `CLOSE_PR_WITH_COMMENT`
- Execute using only action payload fields:
  - `installation_id`
  - `repo_full_name`
  - `github_pr_number`
  - marker/comment payload
- Remove `DEFAULT_INSTALLATION_ID` fallback logic from execution path.

Parallelization:

- Depends on BA-4 claim payload availability.

### BOT-4 Claim/Result Protocol v2

Owner: bot-worker

Deliverables:

- Switch poll loop to:
  - `POST /internal/v2/bot-actions/claim`
  - `POST /internal/v2/bot-actions/{action_id}/result`
- Send `outcome` values from canonical doc.
- Keep retry behavior with fresh signatures per request.

Parallelization:

- Depends on BA-4 endpoint availability.
- Can be developed alongside BOT-3.

### BOT-5 Metrics And Ops Contract Update

Owner: bot-worker

Deliverables:

- Update metrics names/counters to reflect new v2 event ingest and action types.
- Remove local deadline metrics and runbook references.
- Keep health endpoint and bot poll/error counters.

Parallelization:

- Can run in parallel with BOT-3/BOT-4.

### BOT-6 Test Plan

Owner: bot-worker

Required tests:

- Webhook routing:
  - pull_request forwarding
  - installation/installation_repositories forwarding
- Outbox execution:
  - `UPSERT_PR_COMMENT` success/idempotent upsert
  - `CLOSE_PR_WITH_COMMENT` success
- Result outcomes:
  - success, retryable failure, terminal failure
- Multi-replica behavior:
  - no duplicate action execution when two workers claim concurrently
- Restart behavior:
  - no dependence on local persistent state for correctness

Parallelization:

- Starts once BOT-2 and BOT-3 have first complete implementations.

### bot-worker File Touch Map

- `bot-worker/src/server.ts`
- `bot-worker/src/webhook.ts`
- `bot-worker/src/types.ts`
- `bot-worker/src/backend.ts`
- `bot-worker/src/persistence.ts` (delete or de-scope from core flow)
- `bot-worker/src/deadlines.ts` (remove from runtime path)
- `bot-worker/test/*`

## Cut Criteria (Both Parts)

- No runtime calls to any `internal/v1` bot endpoints.
- No runtime dependency on owner bot-client/key/binding APIs.
- Centralized bot can service multiple unrelated installations from one fleet.
- Full E2E passes with:
  - PR gate comment path
  - verification path
  - timeout close path
  - installation add/remove lifecycle updates.
