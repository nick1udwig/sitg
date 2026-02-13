# 05 Backend API Contract (Rust)

## Protocol

- JSON over HTTPS.
- Session auth via secure HTTP-only cookie for user-facing endpoints.
- Internal bot endpoints require HMAC auth headers.

## Error format

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable message"
  }
}
```

## Internal request auth (`/internal/v1/*`)

Required headers:
- `x-sitg-key-id`: bot key identifier.
- `x-sitg-timestamp`: unix epoch seconds.
- `x-sitg-signature`: `sha256=<hex_hmac_sha256(secret, "{timestamp}.{message}")>`.

Rules:
- Secret is resolved from `x-sitg-key-id` (`bot_client_keys`).
- Timestamp skew must be within 5 minutes.
- Signatures are single-use (replay-protected). Reusing the same signature returns `403 FORBIDDEN`.
- Every retry attempt must generate a fresh timestamp + signature.
- Key must be active and not revoked.
- Resolved bot client must be active.

Message per endpoint:
- `POST /internal/v1/pr-events`: `{delivery_id}`
- `POST /internal/v1/challenges/{challenge_id}/deadline-check`: `{challenge_id}`
- `POST /internal/v1/bot-actions/claim`: `bot-actions-claim:{worker_id}`
- `POST /internal/v1/bot-actions/{action_id}/result`: `bot-action-result:{action_id}:{worker_id}:{success}`

Tenant authorization rules:
- `/internal/v1/pr-events`: `installation_id` must be bound to authenticated bot client.
- `/internal/v1/challenges/{challenge_id}/deadline-check`: challenge repo installation must be bound to authenticated bot client.
- `/internal/v1/bot-actions/claim`: return only actions whose repo installation is bound to authenticated bot client.
- `/internal/v1/bot-actions/{action_id}/result`: action must be currently claimed by provided worker and belong to authenticated bot client.

## Public endpoints

### Auth

- `GET /api/v1/auth/github/start`
- `GET /api/v1/auth/github/callback`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me`

### Repo owner config

- `GET /api/v1/repos/{repo_id}/config`

- `PUT /api/v1/repos/{repo_id}/config`

Request:
```json
{
  "input_mode": "ETH",
  "input_value": "0.10",
  "draft_prs_gated": true
}
```

Request (USD mode):
```json
{
  "input_mode": "USD",
  "input_value": "250.00",
  "draft_prs_gated": true
}
```

Behavior:
- If `USD`, backend fetches CoinGecko spot ETH/USD and computes `threshold_wei`.
- CoinGecko spot cache TTL is `5 minutes`.
- If live fetch fails, backend uses the last cached spot price.
- If live fetch fails and no cached quote exists, config save fails with `503 PRICE_UNAVAILABLE`.
- Backend stores both original input and computed ETH threshold.

Response:
```json
{
  "github_repo_id": 123,
  "threshold": {
    "wei": "100000000000000000",
    "eth": "0.1",
    "usd_estimate": "266.42",
    "input_mode": "ETH",
    "input_value": "0.10",
    "spot_price_usd": "2664.2",
    "spot_source": "coingecko",
    "spot_at": "2026-02-13T00:00:00Z",
    "spot_from_cache": false,
    "spot_quote_id": "uuid",
    "message": "Enforced in ETH. USD is an estimate."
  },
  "draft_prs_gated": true
}
```

### Whitelist

- `POST /api/v1/repos/{repo_id}/whitelist/resolve-logins`

Request:
```json
{
  "logins": ["alice", "bob"]
}
```

Response:
```json
{
  "resolved": [
    {"github_user_id": 1001, "github_login": "alice"}
  ],
  "unresolved": ["bob"]
}
```

- `PUT /api/v1/repos/{repo_id}/whitelist`

Request:
```json
{
  "entries": [
    {"github_user_id": 1001, "github_login": "alice"}
  ]
}
```

- `DELETE /api/v1/repos/{repo_id}/whitelist/{github_user_id}`

### Bot client management (repo owner only)

- `GET /api/v1/bot-clients`
- `POST /api/v1/bot-clients`
- `GET /api/v1/bot-clients/{bot_client_id}`
- `POST /api/v1/bot-clients/{bot_client_id}/keys`
- `POST /api/v1/bot-clients/{bot_client_id}/keys/{key_id}/revoke`
- `PUT /api/v1/bot-clients/{bot_client_id}/installation-bindings`

Create bot client request:
```json
{
  "name": "acme-prod-bot"
}
```

Create bot key response (secret shown once):
```json
{
  "key_id": "bck_live_abc123",
  "secret": "sitgbs_live_...",
  "created_at": "2026-02-13T00:00:00Z"
}
```

Set installation bindings request:
```json
{
  "installation_ids": [100, 101]
}
```

Binding rules:
- Caller must own the bot client.
- Caller must have repo-owner/admin rights for each target installation account.
- Backend replaces the full binding set atomically (upsert + delete removed bindings).
- Each `installation_id` can be bound to only one active bot client.
- If any requested installation is already bound to another active bot client, return `409 INSTALLATION_ALREADY_BOUND`.

### Gate + wallet link

- `GET /api/v1/gate/{gate_token}`
- `POST /api/v1/wallet/link/challenge`
- `POST /api/v1/wallet/link/confirm`
- `DELETE /api/v1/wallet/link`

`DELETE /wallet/link` failure case:
- `409 WALLET_HAS_STAKE` if current linked wallet has non-zero on-chain balance.

### PR confirmation

- `GET /api/v1/gate/{gate_token}/confirm-typed-data`
- `POST /api/v1/gate/{gate_token}/confirm`

Request:
```json
{
  "signature": "0x..."
}
```

Response:
```json
{
  "status": "VERIFIED"
}
```

## EIP-712 contract for PR confirmation

Domain:
- `name`: `SITG`
- `version`: `1`
- `chainId`: `8453`
- `verifyingContract`: staking contract address

Type:

```text
PRGateConfirmation(
  uint256 githubUserId,
  uint256 githubRepoId,
  uint256 pullRequestNumber,
  string headSha,
  bytes32 challengeId,
  uint256 nonce,
  uint256 expiresAt
)
```

Validation rules:
- Signature recovers linked wallet.
- Nonce unused and unexpired.
- Challenge is `PENDING`.
- Author matches challenge.
- On-chain stake >= threshold snapshot.
- Lock is active (`now < unlockTime`).
- If already `VERIFIED`, endpoint is idempotent and returns success.
- Verification is point-in-time; later stake changes do not retroactively invalidate an already verified challenge.

## Internal endpoints (bot integration)

Webhook-driven endpoint:
- `POST /internal/v1/pr-events`

Queue/outbox endpoints (primary deadline execution path):
- `POST /internal/v1/bot-actions/claim`
- `POST /internal/v1/bot-actions/{action_id}/result`

Legacy/manual endpoint (optional):
- `POST /internal/v1/challenges/{challenge_id}/deadline-check`

`/pr-events` request:
```json
{
  "delivery_id": "uuid",
  "installation_id": 100,
  "action": "opened",
  "repository": {"id": 1, "full_name": "org/repo"},
  "pull_request": {
    "number": 42,
    "id": 999,
    "html_url": "https://github.com/org/repo/pull/42",
    "user": {"id": 2001, "login": "contrib"},
    "head_sha": "abc123abc123abc123abc123abc123abc123abcd",
    "is_draft": false
  },
  "event_time": "2026-02-13T00:00:00Z"
}
```

`/pr-events` response:
```json
{
  "decision": "REQUIRE_STAKE",
  "challenge": {
    "id": "uuid",
    "gate_url": "https://sitg.io/g/abc",
    "deadline_at": "2026-02-13T00:30:00Z",
    "comment_markdown": "Please verify stake within 30 minutes..."
  }
}
```

Decision enum:
- `IGNORE`
- `EXEMPT`
- `ALREADY_VERIFIED`
- `REQUIRE_STAKE`

`/bot-actions/claim` request:
```json
{
  "worker_id": "owner-bot-1",
  "limit": 25
}
```

`/bot-actions/claim` response:
```json
{
  "actions": [
    {
      "id": "uuid",
      "action_type": "CLOSE_PR",
      "challenge_id": "uuid",
      "github_repo_id": 1,
      "github_pr_number": 42,
      "payload": {
        "comment_markdown": "Stake verification was not completed within 30 minutes, so this PR has been closed."
      }
    }
  ]
}
```

`/bot-actions/{action_id}/result` request:
```json
{
  "worker_id": "owner-bot-1",
  "success": true,
  "failure_reason": null,
  "retryable": null
}
```

`/bot-actions/{action_id}/result` response:
```json
{
  "id": "uuid",
  "status": "DONE"
}
```

Bot action result status enum:
- `DONE`
- `PENDING`
- `FAILED`

`/deadline-check` response (`NOOP`):
```json
{
  "action": "NOOP",
  "close": null
}
```

`/deadline-check` response (`CLOSE_PR`):
```json
{
  "action": "CLOSE_PR",
  "close": {
    "github_repo_id": 1,
    "github_pr_number": 42,
    "comment_markdown": "Stake verification was not completed within 30 minutes, so this PR has been closed."
  }
}
```

`/deadline-check` action enum:
- `NOOP`
- `CLOSE_PR`

Constraint:
- `close` must be present when `action = CLOSE_PR`.
