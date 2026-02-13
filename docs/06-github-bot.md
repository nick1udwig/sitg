# 06 GitHub Bot Contract

## Implementation

- Language/runtime: TypeScript (Node.js).
- Deployment model: repo owners run their own bot worker(s).
- Each owner uses one webhook URL; multi-replica deployments sit behind that URL.

## App permissions (MVP)

- Repository permissions:
- Pull requests: Read and write
- Issues: Read and write
- Metadata: Read

## Events consumed

- `pull_request` actions:
- `opened`
- `reopened`
- `synchronize`

## Bot behavior

1. On PR event:
- Verify webhook signature.
- Normalize payload and send to backend `/internal/v1/pr-events`.
- Apply backend decision.
- Sign backend internal requests using `x-sitg-key-id`, `x-sitg-timestamp`, and `x-sitg-signature` HMAC.

2. If `REQUIRE_STAKE`:
- Post gate comment with unique gate URL and deadline.
- No local deadline timer is required when outbox polling mode is enabled.

3. If `EXEMPT`:
- Optionally comment that user is exempt (configurable, likely off by default).

4. On deadline job:
- Primary mode: poll backend `/internal/v1/bot-actions/claim`.
- For each claimed `CLOSE_PR` action, close PR and post timeout comment, then ack via `/internal/v1/bot-actions/{action_id}/result`.
- Optional/manual fallback: call `/internal/v1/challenges/{challenge_id}/deadline-check`.

## Draft PR rule

- Bot follows repo config `draft_prs_gated`.
- If draft and setting is false, bot ignores gating and returns no-op.

## Idempotency

- Use GitHub delivery ID + action + PR number keys to deduplicate retries.
- Internal backend HMAC signatures are single-use; retried calls must be re-signed with a fresh timestamp.
- Re-running close command should be safe if PR is already closed.
- If running multiple replicas for one owner, dedup/deadline state must be shared or delegated to backend outbox mode.

## Comment template (MVP)

```md
This repository requires stake verification to keep this PR open.

Please verify within **30 minutes**:
{gate_url}

If verification is not completed in time, this PR will be automatically closed.
```

## Out of scope (MVP)

- Reopen closed PRs after late verification.
- Slash/penalty actions.
- Label automation beyond minimal status tagging.
