# bot-worker Operations Runbook

## Observability

- Health endpoint: `GET /healthz`
- Metrics endpoint: `GET /metrics`
- Logs: JSON lines with `event`, `ts`, and context fields.

Key counters:

- `sitg_bot_webhook_events_total`
- `sitg_bot_webhook_ignored_total`
- `sitg_bot_webhook_duplicate_total`
- `sitg_bot_webhook_decision_require_stake_total`
- `sitg_bot_deadline_run_total`
- `sitg_bot_deadline_close_total`
- `sitg_bot_deadline_noop_total`
- `sitg_bot_outbox_claim_total`
- `sitg_bot_outbox_actions_claimed_total`
- `sitg_bot_outbox_actions_success_total`
- `sitg_bot_outbox_actions_failed_total`
- `sitg_bot_errors_total`

Suggested alerts:

- sustained increase in `sitg_bot_errors_total`
- `sitg_bot_deadline_run_total` increases while `sitg_bot_deadline_close_total` is unexpectedly zero
- webhook total drops to zero during expected traffic windows

## Retry and idempotency

- Webhook dedup key: `delivery_id:action:repo_id:pr_number`
- Dedup keys persist to `BOT_STATE_FILE`
- Backend and GitHub HTTP calls use exponential backoff retries
- Comment posting is marker-based upsert, safe on retries
- Close PR operation is safe if PR is already closed
- Outbox claim/ack requests are retried with fresh signatures on each request

## Failure handling

- If deadline action resolves to `NOOP`, local deadline state is removed
- Primary path:
  - bot polls `/internal/v1/bot-actions/claim`
  - executes actions
  - posts ack to `/internal/v1/bot-actions/{action_id}/result`
- If outbox action fails in bot:
  - bot sends failure ack with `retryable=true`
  - backend can requeue according to policy
- Manual fallback:
  - `POST /internal/v1/deadlines/{challenge_id}/run`
  - include `x-internal-token` when configured
- On process restart:
  - outbox polling resumes automatically
  - optional local timers are rescheduled only if `ENABLE_LOCAL_DEADLINE_TIMERS=true`

## Secret rotation

Rotate `GITHUB_WEBHOOK_SECRET`:

1. Generate new secret.
2. Update GitHub App webhook secret and deploy bot with new value immediately.
3. Verify webhook deliveries are accepted.

Rotate `INTERNAL_HMAC_SECRET` / `BACKEND_INTERNAL_HMAC_SECRET`:

1. Roll backend first to accept new secret.
2. Deploy bot with updated `BACKEND_INTERNAL_HMAC_SECRET`.
3. Confirm internal calls succeed (`/internal/v1/pr-events`, `/deadline-check`).
4. Remove old secret from backend acceptance path.

Rotate bot key id/secret pair:

1. Create a new key for the bot client in SaaS (`key_id` + secret shown once).
2. Deploy bot with new `BACKEND_BOT_KEY_ID` and `BACKEND_INTERNAL_HMAC_SECRET`.
3. Confirm internal calls succeed (`/internal/v1/pr-events`, `/bot-actions/claim`, `/result`).
4. Revoke old key in SaaS.

Rotate GitHub App private key:

1. Create new key in GitHub App settings.
2. Deploy bot with updated `GITHUB_APP_PRIVATE_KEY`.
3. Verify token mint and API actions succeed.
4. Revoke old key.

## Scaling note

Current `BOT_STATE_FILE` persistence is designed for a single bot instance.
For multi-instance deployment, use shared durable state for:

- dedup keys
- pending deadlines
- repo installation mapping
