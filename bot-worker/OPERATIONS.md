# bot-worker Operations Runbook

## Observability

- Health endpoint: `GET /healthz`
- Metrics endpoint: `GET /metrics`
- Logs: JSON lines with `event`, `ts`, and context fields.

Key counters:

- `sitg_bot_webhook_events_total`
- `sitg_bot_webhook_ignored_total`
- `sitg_bot_webhook_pull_request_forwarded_total`
- `sitg_bot_webhook_installation_sync_forwarded_total`
- `sitg_bot_webhook_ingest_accepted_total`
- `sitg_bot_webhook_ingest_duplicate_total`
- `sitg_bot_webhook_ingest_ignored_total`
- `sitg_bot_outbox_claim_total`
- `sitg_bot_outbox_actions_claimed_total`
- `sitg_bot_outbox_actions_success_total`
- `sitg_bot_outbox_actions_retryable_failure_total`
- `sitg_bot_outbox_actions_failed_total`
- `sitg_bot_errors_total`

Suggested alerts:

- sustained increase in `sitg_bot_errors_total`
- sustained increase in `sitg_bot_outbox_actions_retryable_failure_total`
- sustained increase in `sitg_bot_outbox_actions_failed_total`
- webhook totals drop to zero during expected traffic windows

## Retry and idempotency

- Bot does not provide webhook dedup correctness.
- Backend v2 ingest endpoints own delivery dedup.
- Backend and GitHub HTTP calls use exponential backoff retries.
- Comment posting uses marker-based upsert and is safe to retry.
- Close PR operation is safe if PR is already closed.
- Outbox claim/result requests use fresh signatures for each request.

## Failure handling

Primary path:

- bot polls `/internal/v2/bot-actions/claim`
- executes actions
- posts outcome to `/internal/v2/bot-actions/{action_id}/result`

Outcome behavior:

- `SUCCEEDED`: action applied.
- `RETRYABLE_FAILURE`: transient execution failure; backend may requeue.
- `FAILED`: invalid/unsupported action payload; terminal.

## Secret rotation

Rotate `GITHUB_WEBHOOK_SECRET`:

1. Generate new secret.
2. Update GitHub App webhook secret and deploy bot with new value immediately.
3. Verify webhook deliveries are accepted.

Rotate `BACKEND_INTERNAL_HMAC_SECRET`:

1. Roll backend first to accept new secret.
2. Deploy bot with updated `BACKEND_INTERNAL_HMAC_SECRET`.
3. Confirm internal calls succeed (`/internal/v2/github/events/*`, `/internal/v2/bot-actions/*`).
4. Remove old secret from backend acceptance path.

Rotate bot key id/secret pair:

1. Create a new service bot key (`key_id` + secret shown once).
2. Deploy bot with new `BACKEND_BOT_KEY_ID` and `BACKEND_INTERNAL_HMAC_SECRET`.
3. Confirm internal calls succeed.
4. Revoke old key.

Rotate GitHub App private key:

1. Create new key in GitHub App settings.
2. Deploy bot with updated `GITHUB_APP_PRIVATE_KEY`.
3. Verify token mint and API actions succeed.
4. Revoke old key.
