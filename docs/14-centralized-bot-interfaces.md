# 14 Centralized Bot Interfaces (Canonical)

Status: authoritative contract for the beta reset.

This document replaces prior owner-run bot assumptions. Backward compatibility is not required.

## 1. Deployment Model

- SITG runs a centralized bot-worker fleet.
- Repo owners do not run their own bot processes.
- GitHub App uses one webhook URL owned by SITG.
- Bot workers are stateless and horizontally scalable.

## 2. Versioning And Removal Policy

- All `internal/v1` bot endpoints are removed.
- New bot/backend contract lives under `internal/v2`.
- Legacy owner bot APIs are removed:
  - `GET /api/v1/bot-clients`
  - `POST /api/v1/bot-clients`
  - `GET /api/v1/bot-clients/{bot_client_id}`
  - `POST /api/v1/bot-clients/{bot_client_id}/keys`
  - `POST /api/v1/bot-clients/{bot_client_id}/keys/{key_id}/revoke`
  - `PUT /api/v1/bot-clients/{bot_client_id}/installation-bindings`

## 3. Internal Auth (Bot -> Backend)

Required headers for all `/internal/v2/*` endpoints:

- `x-sitg-key-id`
- `x-sitg-timestamp` (unix seconds)
- `x-sitg-signature` (`sha256=<hex_hmac>`)

Signature input format:

```text
{timestamp}.{message}
```

Rules:

- Timestamp skew must be within 5 minutes.
- Signature is single-use (replay protected).
- `x-sitg-key-id` resolves to an active SITG service bot key.

Message strings by endpoint:

- `POST /internal/v2/github/events/pull-request`: `github-event:pull_request:{delivery_id}`
- `POST /internal/v2/github/events/installation-sync`: `github-event:installation-sync:{delivery_id}`
- `POST /internal/v2/bot-actions/claim`: `bot-actions-claim:{worker_id}`
- `POST /internal/v2/bot-actions/{action_id}/result`: `bot-action-result:{action_id}:{worker_id}:{outcome}`

## 4. Event Ingest Interfaces

### 4.1 `POST /internal/v2/github/events/pull-request`

Purpose:

- Ingest normalized pull request webhook events from bot-worker.
- Perform challenge decisioning.
- Enqueue bot actions (gate/exempt comments) as outbox work.

Request:

```json
{
  "delivery_id": "string",
  "event_time": "2026-02-16T12:34:56Z",
  "installation_id": 123,
  "action": "opened",
  "repository": {
    "id": 999,
    "full_name": "org/repo"
  },
  "pull_request": {
    "number": 42,
    "id": 1001,
    "html_url": "https://github.com/org/repo/pull/42",
    "is_draft": false,
    "user": {
      "id": 2002,
      "login": "contrib"
    },
    "head_sha": "abc123abc123abc123abc123abc123abc123abcd"
  }
}
```

Response:

```json
{
  "ingest_status": "ACCEPTED",
  "challenge_id": "uuid-or-null",
  "enqueued_actions": 1
}
```

`ingest_status` enum:

- `ACCEPTED`
- `DUPLICATE`
- `IGNORED`

### 4.2 `POST /internal/v2/github/events/installation-sync`

Purpose:

- Keep installation and repository mapping data current from GitHub App installation events.

Request:

```json
{
  "delivery_id": "string",
  "event_time": "2026-02-16T12:34:56Z",
  "event_name": "installation",
  "action": "created",
  "installation": {
    "id": 123,
    "account_login": "org",
    "account_type": "Organization"
  },
  "repositories_added": [],
  "repositories_removed": [],
  "repositories": [
    { "id": 999, "full_name": "org/repo" }
  ]
}
```

Response:

```json
{
  "ingest_status": "ACCEPTED",
  "updated_installation_id": 123,
  "updated_repositories": 1
}
```

Accepted event set:

- `installation` actions: `created`, `deleted`, `suspend`, `unsuspend`
- `installation_repositories` actions: `added`, `removed`

## 5. Bot Action Outbox Interfaces

### 5.1 `POST /internal/v2/bot-actions/claim`

Request:

```json
{
  "worker_id": "bot-worker-prod-1",
  "limit": 50
}
```

Response:

```json
{
  "actions": [
    {
      "id": "uuid",
      "action_type": "UPSERT_PR_COMMENT",
      "installation_id": 123,
      "github_repo_id": 999,
      "repo_full_name": "org/repo",
      "github_pr_number": 42,
      "challenge_id": "uuid-or-null",
      "payload": {
        "comment_markdown": "This repository requires stake verification...",
        "comment_marker": "sitg:gate:uuid",
        "reason": "REQUIRE_STAKE"
      },
      "attempts": 0,
      "created_at": "2026-02-16T12:34:56Z"
    }
  ]
}
```

`action_type` enum:

- `UPSERT_PR_COMMENT`
- `CLOSE_PR_WITH_COMMENT`

Payload requirements:

- `UPSERT_PR_COMMENT`:
  - `comment_markdown` required
  - `comment_marker` required
- `CLOSE_PR_WITH_COMMENT`:
  - `comment_markdown` required
  - `comment_marker` required

### 5.2 `POST /internal/v2/bot-actions/{action_id}/result`

Request:

```json
{
  "worker_id": "bot-worker-prod-1",
  "outcome": "SUCCEEDED",
  "failure_code": null,
  "failure_message": null
}
```

`outcome` enum:

- `SUCCEEDED`
- `RETRYABLE_FAILURE`
- `FAILED`

Response:

```json
{
  "id": "uuid",
  "status": "DONE"
}
```

`status` enum:

- `DONE`
- `PENDING`
- `FAILED`

## 6. Owner-Facing API Changes

### 6.1 New/Required

- `GET /api/v1/repos/{repo_id}/github-app-status`

Response:

```json
{
  "installed": true,
  "installation_id": 123,
  "installation_account_login": "org",
  "installation_account_type": "Organization",
  "repo_connected": true
}
```

### 6.2 Removed

- All owner bot client/key/binding endpoints listed in section 2.

## 7. Data Contract Requirements

- `github_installations` must be written from installation webhook events.
- Add repository-level installation mapping table:
  - `github_installation_repositories(installation_id, github_repo_id, full_name, active, updated_at, ...)`
- Add durable delivery dedup table for GitHub deliveries:
  - unique key on `(delivery_id, event_name)`.
- `bot_actions` rows must include:
  - `installation_id`
  - `repo_full_name`
  - action payload sufficient for execution without local bot state.

## 8. Runtime Invariants

- Bot workers do not rely on local files for dedup, deadline scheduling, or repo-installation mapping.
- Backend is the source of truth for:
  - webhook deduplication
  - challenge state
  - installation/repository mapping
  - outbox lifecycle
- Any claimed outbox action can be executed by any worker replica.
