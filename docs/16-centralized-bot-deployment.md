# 16 Centralized Bot Deployment

Purpose: production deployment guide for the centralized `bot-worker` fleet.

Reference contracts:
- `docs/14-centralized-bot-interfaces.md`
- `bot-worker/OPERATIONS.md`

## 1. Topology

- Run one shared SITG-managed bot fleet for all installations.
- GitHub App has one webhook URL: `https://<bot-domain>/webhooks/github`.
- Run at least 2 worker replicas in production.
- Workers are stateless for correctness; no shared disk/state required.

## 2. Required Environment Variables

Set these on every worker replica:

- `PORT`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `BACKEND_BASE_URL`
- `BACKEND_BOT_KEY_ID`
- `BACKEND_INTERNAL_HMAC_SECRET`

How to get each required value:

| Variable | Where it comes from | How to obtain it |
| --- | --- | --- |
| `PORT` | Host/runtime config | Choose an unused port per replica (`3101`, `3102`, etc). |
| `GITHUB_WEBHOOK_SECRET` | GitHub App settings | GitHub -> Settings -> Developer settings -> GitHub Apps -> your app -> Webhook -> Secret. Use this exact value in worker env. |
| `GITHUB_APP_ID` | GitHub App settings | GitHub -> Settings -> Developer settings -> GitHub Apps -> your app -> App ID. |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key | GitHub -> Settings -> Developer settings -> GitHub Apps -> your app -> Private keys -> Generate a private key. Store PEM securely. |
| `BACKEND_BASE_URL` | SITG infra/backend deployment | Use the externally reachable backend URL that serves `internal/v2` routes (example: `https://sitg.io`). |
| `BACKEND_BOT_KEY_ID` | backend-api internal auth | Create/provision a service bot key in backend-api and copy the returned key id. |
| `BACKEND_INTERNAL_HMAC_SECRET` | backend-api internal auth | Copy the secret paired with `BACKEND_BOT_KEY_ID` at key creation/rotation time. |

Optional:

- `BACKEND_SERVICE_TOKEN`
- `GITHUB_API_BASE_URL` (default `https://api.github.com`)
- `WORKER_ID` (recommended: unique per replica)
- `OUTBOX_POLLING_ENABLED` (default `true`)
- `OUTBOX_POLL_INTERVAL_MS` (default `5000`)
- `OUTBOX_CLAIM_LIMIT` (default `25`)

Reference env template:
- `bot-worker/.env.example`
- `deploy/env/bot-worker.env.example`

Provisioning helper:
- `deploy/scripts/provision-service-bot-key.sh`
- Generates/rotates `service_bot_keys` row and prints:
  - `BACKEND_BOT_KEY_ID`
  - `BACKEND_INTERNAL_HMAC_SECRET`
  - `BACKEND_SERVICE_TOKEN` placeholder

Example:

```bash
DATABASE_URL='postgres://sitg:***@127.0.0.1:5432/sitg' ./deploy/scripts/provision-service-bot-key.sh
```

## 3. Build And Release

From repo root on build host:

```bash
cd /opt/sitg/bot-worker
npm ci
npm run build
```

Release artifact:
- `bot-worker/dist/*`
- `bot-worker/package.json`
- `bot-worker/package-lock.json`

## 4. Systemd Deployment (Single Host, Multiple Replicas)

Use templated unit instances to run multiple replicas on one host.

### 4.1 Service template

Create `/etc/systemd/system/sitg-bot-worker@.service`:

```ini
[Unit]
Description=SITG centralized bot-worker instance %i
After=network.target
Wants=network.target

[Service]
Type=simple
User=sitg
Group=sitg
WorkingDirectory=/opt/sitg/bot-worker
EnvironmentFile=/etc/sitg/bot-worker-%i.env
ExecStart=/usr/bin/node /opt/sitg/bot-worker/dist/src/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/sitg/bot-worker

[Install]
WantedBy=multi-user.target
```

### 4.2 Per-replica env files

Example `/etc/sitg/bot-worker-1.env`:

```bash
PORT=3101
WORKER_ID=bot-worker-prod-1
GITHUB_WEBHOOK_SECRET=...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"
BACKEND_BASE_URL=https://sitg.io
BACKEND_BOT_KEY_ID=bck_live_...
BACKEND_INTERNAL_HMAC_SECRET=...
OUTBOX_POLLING_ENABLED=true
OUTBOX_POLL_INTERVAL_MS=5000
OUTBOX_CLAIM_LIMIT=50
```

Example `/etc/sitg/bot-worker-2.env` should only differ by `PORT` and `WORKER_ID`.

### 4.3 Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sitg-bot-worker@1.service
sudo systemctl enable --now sitg-bot-worker@2.service
sudo systemctl status sitg-bot-worker@1.service --no-pager
sudo systemctl status sitg-bot-worker@2.service --no-pager
```

## 5. Ingress / Load Balancing

- Put replicas behind a load balancer/reverse proxy.
- Route `POST /webhooks/github` to all healthy replicas.
- Health endpoint: `GET /healthz`.
- Metrics endpoint: `GET /metrics`.

Caddy/Nginx/ALB can be used; sticky sessions are not required.

## 6. GitHub App Configuration

In GitHub App settings:

- Webhook URL: `https://<bot-domain>/webhooks/github`
- Webhook secret: must match `GITHUB_WEBHOOK_SECRET`
- Subscribe to events:
  - Pull requests
  - Installation
  - Installation repositories

## 7. Rollout Procedure

1. Deploy new worker build to all bot hosts.
2. Restart one replica first (`canary`).
3. Verify:
   - `/healthz` returns `200`.
   - webhook forwarding metrics increase.
   - outbox claim/result metrics increase without error spikes.
4. Restart remaining replicas.

Commands:

```bash
sudo systemctl restart sitg-bot-worker@1.service
sudo journalctl -u sitg-bot-worker@1.service -f
```

Then rollout to remaining instances.

## 8. Production Verification Checklist

- `POST /webhooks/github` accepted by ingress.
- `sitg_bot_webhook_pull_request_forwarded_total` increasing.
- `sitg_bot_webhook_installation_sync_forwarded_total` increasing.
- `sitg_bot_outbox_actions_success_total` increasing.
- `sitg_bot_errors_total` stable.
- No sustained growth in:
  - `sitg_bot_outbox_actions_retryable_failure_total`
  - `sitg_bot_outbox_actions_failed_total`

## 9. Scaling Guidance

- Scale replicas based on outbox lag and processing latency.
- Increase `OUTBOX_CLAIM_LIMIT` cautiously (start at `25` or `50`).
- Keep poll interval at `5000ms` initially.
- Horizontal scaling is safe because backend owns claim locking and dedup.

## 10. Incident Notes

- If webhook delivery failures spike: verify LB route and `GITHUB_WEBHOOK_SECRET`.
- If all outbox actions fail auth: verify `BACKEND_BOT_KEY_ID` and `BACKEND_INTERNAL_HMAC_SECRET`.
- If GitHub API failures spike: inspect installation token mint path and GitHub status.
