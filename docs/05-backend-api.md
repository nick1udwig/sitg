# 05 Backend API Contract (Rust)

## Protocol

- JSON over HTTPS.
- Session auth via secure HTTP-only cookie for user-facing endpoints.
- Service auth (HMAC or mTLS) for internal bot endpoints.

## Error format

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable message"
  }
}
```

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
- `name`: `StakeToContribute`
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

- `POST /internal/v1/pr-events`
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
    "gate_url": "https://app.example.com/g/abc",
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
