# 13 Production Runbook

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

### 2. Create Postgres DB/user

```bash
sudo -u postgres /opt/sitg/deploy/scripts/bootstrap-postgres.sh \
  --db sitg \
  --user sitg \
  --password 'change_me'
```

Notes:
- This command is idempotent. Re-running updates role password and keeps the DB.
- If your Postgres superuser is not `postgres`, pass `--superuser <name>`.
- For TCP admin access, pass `--host` and `--port`.

### 3. Configure backend env

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
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_OWNER_CHECK_TOKEN`
- `BASE_RPC_URL`
- `STAKING_CONTRACT_ADDRESS`

### 4. Install backend systemd service

```bash
sudo cp /opt/sitg/deploy/systemd/sitg-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sitg-backend.service
sudo systemctl status sitg-backend.service
```

### 5. Serve frontend + API through Caddy

```bash
sudo cp /opt/sitg/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Caddy manages TLS certificates automatically when DNS points to the host and ports `80/443` are open.

### 6. Verify

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
