# deploy

Production deployment templates:

- `deploy/env/backend.env.example`: backend env file template.
- `deploy/env/bot-worker.env.example`: bot env file template.
- `deploy/systemd/sitg-backend.service`: backend systemd unit.
- `deploy/systemd/sitg-bot-worker.service`: bot systemd unit.
- `deploy/caddy/Caddyfile`: Caddy config for serving frontend + proxying `/api`.

See `docs/13-production-runbook.md` for the full production flow.
