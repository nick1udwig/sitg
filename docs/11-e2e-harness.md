# 11 E2E Harness

This project includes a local, deterministic E2E harness for the centralized backend-to-bot workflow without cloud deployment.

## What it runs

- `postgres` (Docker container)
- real `backend-api`
- real `bot-worker`
- local `mock-github` API used by bot for comment/close operations

## Entry point

- `scripts/e2e/local-loop.sh` is the primary centralized-bot harness.
- `scripts/e2e/run.sh` is a compatibility shortcut for `scripts/e2e/local-loop.sh run`.
- `scripts/e2e/postgres-docker.sh` is a standalone Postgres lifecycle helper for focused database tests.

## Local loop harness (centralized v2)

Purpose:
- fast local backend+bot integration loop for coding/debugging
- no CI required
- uses Docker Compose and real services

Stack:
- `postgres`
- `backend-api`
- `bot-worker`
- `mock-github`

Compose file:
- `scripts/e2e/docker-compose.local.yml`

Default host ports:
- Postgres: `55432`
- Backend: `18080`
- Bot: `13000`
- Mock GitHub: `19010`

Quick start:

```bash
scripts/e2e/local-loop.sh run
```

This command performs:
- stack startup (`up`)
- DB seed (`seed`)
- scenario execution (`test`)

Day-to-day workflow:

1. Start stack once:

```bash
scripts/e2e/local-loop.sh up
```

2. After code changes, run seed + scenarios:

```bash
scripts/e2e/local-loop.sh seed
scripts/e2e/local-loop.sh test
```

3. If backend or bot code changed and process state looks stale:

```bash
scripts/e2e/local-loop.sh restart
scripts/e2e/local-loop.sh test
```

4. Inspect logs while reproducing:

```bash
scripts/e2e/local-loop.sh logs backend
scripts/e2e/local-loop.sh logs bot
scripts/e2e/local-loop.sh logs mock-github
```

5. Stop everything:

```bash
scripts/e2e/local-loop.sh down
```

6. Full cleanup (including volumes/cache):

```bash
scripts/e2e/local-loop.sh nuke
```

Command set:

```bash
scripts/e2e/local-loop.sh up
scripts/e2e/local-loop.sh seed
scripts/e2e/local-loop.sh test
scripts/e2e/local-loop.sh restart
scripts/e2e/local-loop.sh logs backend
scripts/e2e/local-loop.sh down
scripts/e2e/local-loop.sh nuke
```

Port overrides:

```bash
LOCAL_E2E_BACKEND_PORT=28080 \
LOCAL_E2E_BOT_PORT=23000 \
LOCAL_E2E_MOCK_GITHUB_PORT=29010 \
scripts/e2e/local-loop.sh run
```

Other useful overrides:
- `POSTGRES_URL`
- `BACKEND_URL`
- `BOT_URL`
- `MOCK_GITHUB_URL`
- `BOT_KEY_ID`
- `WEBHOOK_SECRET`

Scenarios covered by `test`:
- installation sync webhook forwarded through bot and persisted by backend
- PR opened webhook forwarded through bot, challenge created, gate comment action executed
- manual `CLOSE_PR_WITH_COMMENT` outbox action claimed/executed by bot and acknowledged

Troubleshooting:
- If `backend` health check does not come up quickly on first run, wait for Rust compile inside container and watch `scripts/e2e/local-loop.sh logs backend`.
- If webhooks appear ignored, verify `WEBHOOK_SECRET` in test runner matches bot env (`GITHUB_WEBHOOK_SECRET`).
- If internal auth fails, ensure the worker private key matches `service_bot_keys.public_key` (the seed step handles this).
- If compose startup fails due to host port collisions, use the port override env vars above.

## Prerequisites

- `docker` with Docker Compose
- `psql` (PostgreSQL client)
- `curl`
- `node`
- `openssl`

## Convenience entry point

```bash
scripts/e2e/run.sh
```

This is exactly equivalent to:

```bash
scripts/e2e/local-loop.sh run
```

Use `scripts/e2e/local-loop.sh down` when you are finished, or `nuke` to remove its volumes too.
