# 11 E2E Harness

This project includes a local, deterministic E2E harness that runs the full system without cloud deployment.

## What it runs

- `postgres` (Docker container)
- `anvil` local chain (chain id `8453`)
- real staking contract deployed to Anvil
- real `backend-api`
- real `bot-worker`
- real `frontend-web`
- local `mock-github` API used by bot for comment/close operations

## Entry point

- `scripts/e2e/run.sh`
- `scripts/e2e/postgres-docker.sh` (Postgres Docker lifecycle helper)
- `scripts/e2e/local-loop.sh` (centralized-bot local loop harness)

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
- `BOT_RAW_SECRET`
- `WEBHOOK_SECRET`

Scenarios covered by `test`:
- installation sync webhook forwarded through bot and persisted by backend
- PR opened webhook forwarded through bot, challenge created, gate comment action executed
- manual `CLOSE_PR_WITH_COMMENT` outbox action claimed/executed by bot and acknowledged

Troubleshooting:
- If `backend` health check does not come up quickly on first run, wait for Rust compile inside container and watch `scripts/e2e/local-loop.sh logs backend`.
- If webhooks appear ignored, verify `WEBHOOK_SECRET` in test runner matches bot env (`GITHUB_WEBHOOK_SECRET`).
- If internal auth fails, ensure `service_bot_keys.secret_hash` matches `BOT_RAW_SECRET` (seed step handles this).
- If compose startup fails due to host port collisions, use the port override env vars above.

## Prerequisites

- `docker`
- `psql` (PostgreSQL client)
- `node`, `npm`
- `cargo`
- `anvil`, `forge`, `cast`
- `openssl`

## Run

```bash
scripts/e2e/postgres-docker.sh up
scripts/e2e/postgres-docker.sh wait-ready 60
scripts/e2e/run.sh
```

If your user cannot access `/var/run/docker.sock`, run only the Postgres helper via `sudo`:

```bash
sudo scripts/e2e/postgres-docker.sh up
sudo scripts/e2e/postgres-docker.sh wait-ready 60
scripts/e2e/run.sh
```

Cleanup:

```bash
scripts/e2e/postgres-docker.sh down
```

The script:
- starts all services,
- seeds required DB data (users/sessions/repo/bot key/bindings),
- sends PR webhooks to the bot,
- stakes on-chain,
- signs and confirms EIP-712 payload via backend,
- validates timeout close via bot outbox polling,
- validates auth/session behavior (`/api/v1/me` with and without session),
- validates wallet link challenge/confirm and unlink guard behavior,
- validates replay protection on internal signed endpoints,
- validates whitelist-at-deadline exemption behavior,
- validates draft-PR ignore behavior when draft gating is disabled,
- validates invalid webhook signature ignore behavior,
- validates bot action result branches (`PENDING` retry, `FAILED`, `409` conflict),
- checks final DB and mock-GitHub state.

## Covered scenarios

1. `/api/v1/me` auth/session checks and basic frontend route reachability.
2. PR opened -> gate comment posted -> contributor stakes and signs -> challenge becomes `VERIFIED`.
3. PR opened -> deadline check triggers close action -> bot claims outbox action -> PR closed + timeout comment.
4. Duplicate signed internal request replay is rejected.
5. Wallet link challenge -> personal-sign confirm -> unlink blocked while stake active -> unlock/withdraw -> unlink succeeds.
6. Whitelist added after PR open -> deadline check returns `NOOP` and challenge moves to `EXEMPT`.
7. Draft PR ignored when `draft_prs_gated=false`.
8. Invalid webhook signature is ignored (`202`).
9. Internal bot action result endpoint: retryable failure (`PENDING`), non-retry failure (`FAILED`), and worker mismatch conflict (`409`).

## Notes

- The harness bypasses GitHub OAuth by seeding a contributor session directly in Postgres.
- `bot-worker` supports `GITHUB_API_BASE_URL` for local mock operation.
- `scripts/e2e/run.sh` does not start/stop Postgres; it expects Postgres to already be reachable at `POSTGRES_URL`.
- By default, cleanup runs automatically for non-Postgres services. Set `KEEP_E2E_STACK=1` to keep services up for debugging.
- Logs are written to `.e2e/logs/`.
