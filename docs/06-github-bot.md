# 06 GitHub Bot Contract

## Implementation

- Language/runtime: TypeScript (Node.js).

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

2. If `REQUIRE_STAKE`:
- Post gate comment with unique gate URL and deadline.
- Ensure deadline job exists.

3. If `EXEMPT`:
- Optionally comment that user is exempt (configurable, likely off by default).

4. On deadline job:
- Call backend `/internal/v1/challenges/{challenge_id}/deadline-check`.
- If backend returns close action, close PR and add timeout comment.
- If backend says exempt/verified, do not close.

## Draft PR rule

- Bot follows repo config `draft_prs_gated`.
- If draft and setting is false, bot ignores gating and returns no-op.

## Idempotency

- Use GitHub delivery ID + action + PR number keys to deduplicate retries.
- Re-running close command should be safe if PR is already closed.

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
