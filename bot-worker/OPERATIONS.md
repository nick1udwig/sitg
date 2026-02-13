# bot-worker Operations Runbook

## Observability

- Health endpoint: `GET /healthz`
- Metrics endpoint: `GET /metrics`
- Logs: JSON lines with `event`, `ts`, and context fields.

Key counters:

- `stc_bot_webhook_events_total`
- `stc_bot_webhook_ignored_total`
- `stc_bot_webhook_duplicate_total`
- `stc_bot_webhook_decision_require_stake_total`
- `stc_bot_deadline_run_total`
- `stc_bot_deadline_close_total`
- `stc_bot_deadline_noop_total`
- `stc_bot_errors_total`

Suggested alerts:

- sustained increase in `stc_bot_errors_total`
- `stc_bot_deadline_run_total` increases while `stc_bot_deadline_close_total` is unexpectedly zero
- webhook total drops to zero during expected traffic windows

## Retry and idempotency

- Webhook dedup key: `delivery_id:action:repo_id:pr_number`
- Dedup keys persist to `BOT_STATE_FILE`
- Backend and GitHub HTTP calls use exponential backoff retries
- Comment posting is marker-based upsert, safe on retries
- Close PR operation is safe if PR is already closed

## Failure handling

- If deadline action resolves to `NOOP`, local deadline state is removed
- If close action fails, request returns `500`; retry the internal deadline run endpoint:
  - `POST /internal/v1/deadlines/{challenge_id}/run`
  - include `x-internal-token` when configured
- On process restart, persisted deadlines are rescheduled automatically

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
