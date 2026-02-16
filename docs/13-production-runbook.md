# 13 Production Runbook

> The bot deployment sections in this runbook are superseded by `docs/14-centralized-bot-interfaces.md` and `docs/15-centralized-bot-work-plan.md` for the beta reset.
> Use this file for legacy reference until a centralized-bot runbook revision lands.

This is the production deployment/run guide for SITG.

## What "production" means here

There are two deployment planes:

1. SITG SaaS plane (you run):
- `backend-api` (Rust)
- `frontend-web` static assets
- Postgres
- Reverse proxy/TLS

2. Owner bot plane (repo owner runs):
- `bot-worker` per owner deployment
- bound to that owner's GitHub installation via SaaS

## Fast path: single-VM SaaS deployment (copy/paste)

Assumptions:
- Ubuntu 22.04+ VM
- domain `sitg.io`
- backend and frontend served from the same origin (`https://sitg.io`)
- Postgres installed on same VM

### 1. Build artifacts

```bash
cd /opt
sudo mkdir -p sitg
sudo chown -R "$USER:$USER" /opt/sitg
git clone <your-repo-url> /opt/sitg

cd /opt/sitg/backend-api
cargo build --release

cd /opt/sitg/frontend-web
npm ci
npm run build
```

### 2. Start Postgres service

System service path (recommended on single VM):

```bash
sudo apt-get update && sudo apt-get install -y postgresql postgresql-contrib
```

```bash
sudo systemctl enable --now postgresql
```

```bash
sudo systemctl status postgresql --no-pager
```

```bash
ss -ltn | grep ':5432'
```

Quick-start Docker path:

```bash
sudo /opt/sitg/scripts/e2e/postgres-docker.sh up
```

```bash
sudo /opt/sitg/scripts/e2e/postgres-docker.sh wait-ready
```

### 3. Create Postgres DB/user

System service default (peer auth on local socket, no default password):

```bash
sudo install -m 755 /opt/sitg/deploy/scripts/bootstrap-postgres.sh /usr/local/bin/sitg-bootstrap-postgres
```

```bash
sudo -u postgres /usr/local/bin/sitg-bootstrap-postgres --superuser postgres --db sitg --user sitg --password 'change_me'
```

If using TCP/password auth on local Postgres:

```bash
PGPASSWORD='postgres_admin_password' /opt/sitg/deploy/scripts/bootstrap-postgres.sh --host 127.0.0.1 --port 5432 --superuser postgres --db sitg --user sitg --password 'change_me'
```

If using the SITG Docker Postgres defaults:

```bash
PGPASSWORD='postgres' /opt/sitg/deploy/scripts/bootstrap-postgres.sh --host 127.0.0.1 --port 55432 --superuser postgres --db sitg --user sitg --password 'change_me'
```

Notes:
- This command is idempotent. Re-running updates role password and keeps the DB.
- System service installs usually create DB role `postgres` with no default password (peer auth by OS user).
- SITG Docker defaults are DB user `postgres`, password `postgres`, DB `sitg`, host port `55432`.
- If you see `sudo: unable to execute ... Permission denied`, your script path is not traversable/readable by Linux user `postgres` (common under `/root/...`); use the `/usr/local/bin` install step above.
- Replace `postgres_admin_password` with your actual admin password (it is a placeholder).
- If your admin role is different, change `--superuser`.
- If you use peer auth with your current Linux user, you can omit host/port and use `--superuser "$USER"`.
- If Postgres runs in Docker and maps to host `55432`, use `--host 127.0.0.1 --port 55432` (and matching admin password).

### 4. Configure backend env

```bash
sudo mkdir -p /etc/sitg
sudo cp /opt/sitg/deploy/env/backend.env.example /etc/sitg/backend.env
sudo chmod 600 /etc/sitg/backend.env
sudoedit /etc/sitg/backend.env
```

Required values in `/etc/sitg/backend.env`:
- `DATABASE_URL`
- `APP_BASE_URL` (for production: `https://sitg.io`)
- `API_BASE_URL` (for same-origin: `https://sitg.io`)
- GitHub OAuth callback URL must be `{API_BASE_URL}/api/v1/auth/github/callback` (example: `https://sitg.io/api/v1/auth/github/callback`).
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `BASE_RPC_URL`
- `STAKING_CONTRACT_ADDRESS`

GitHub OAuth notes:
- Backend requests OAuth scope `read:user public_repo`.
- Repo-owner checks use each logged-in owner's OAuth token from their session.

### 5. Install backend systemd service

```bash
sudo cp /opt/sitg/deploy/systemd/sitg-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sitg-backend.service
sudo systemctl status sitg-backend.service
```

### 6. Serve frontend + API through Caddy

```bash
sudo cp /opt/sitg/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy manages TLS certificates automatically when DNS points to the host and ports `80/443` are open.

### 7. Verify

```bash
curl -fsS https://sitg.io/healthz
curl -I https://sitg.io/
```

## Owner bot deployment (one per owner)

Each owner deployment needs:
- a public HTTPS webhook URL
- bot key pair from SaaS (`BACKEND_BOT_KEY_ID` + secret)
- GitHub App credentials and webhook secret

### 1. Build bot

```bash
cd /opt/sitg/bot-worker
npm ci
npm run build
```

### 2. Configure env + state dir

```bash
sudo mkdir -p /etc/sitg /var/lib/sitg-bot-owner
sudo cp /opt/sitg/deploy/env/bot-worker.env.example /etc/sitg/bot-worker.env
sudo chmod 600 /etc/sitg/bot-worker.env
sudo chown -R sitg:sitg /var/lib/sitg-bot-owner
sudoedit /etc/sitg/bot-worker.env
```

Required values in `/etc/sitg/bot-worker.env`:
- `GITHUB_WEBHOOK_SECRET`
- `BACKEND_BASE_URL` (for production SaaS: `https://sitg.io`)
- `BACKEND_BOT_KEY_ID`
- `BACKEND_INTERNAL_HMAC_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`

### 3. Install bot systemd service

```bash
sudo cp /opt/sitg/deploy/systemd/sitg-bot-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sitg-bot-worker.service
sudo systemctl status sitg-bot-worker.service
```

### 4. Webhook URL

Expose `POST /webhooks/github` to the internet for the bot host and set that URL in GitHub App settings.

Health checks:

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/metrics
```

## Multi-owner operations

- Run one bot service per owner deployment.
- Use distinct env files, `WORKER_ID`, and `BOT_STATE_FILE` per bot.
- Bind each GitHub installation to exactly one active bot client in SaaS.

## Upgrade workflow

```bash
cd /opt/sitg
git pull

cd backend-api && cargo build --release
cd ../frontend-web && npm ci && npm run build
cd ../bot-worker && npm ci && npm run build

sudo systemctl restart sitg-backend.service
sudo systemctl restart sitg-bot-worker.service
```

## Troubleshooting

- Backend logs:
```bash
journalctl -u sitg-backend.service -f
```
- Bot logs:
```bash
journalctl -u sitg-bot-worker.service -f
```
- If bot auth fails, verify `x-sitg-*` key/secret pair and installation binding in SaaS.
