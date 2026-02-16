# deploy

Production deployment templates:

- `deploy/env/backend.env.example`: backend env file template.
- `deploy/env/bot-worker.env.example`: bot env file template.
- `deploy/scripts/bootstrap-postgres.sh`: idempotent Postgres role/db bootstrap.
- `deploy/scripts/provision-service-bot-key.sh`: create/rotate centralized bot service key and print worker env values.
- `deploy/systemd/sitg-backend.service`: backend systemd unit.
- `deploy/systemd/sitg-bot-worker.service`: bot systemd unit (single instance).
- `deploy/systemd/sitg-bot-worker@.service`: bot systemd template for multi-replica instances.
- `deploy/caddy/Caddyfile`: Caddy config for serving frontend + proxying `/api`.

See:
- `docs/16-centralized-bot-deployment.md` for centralized bot-worker production rollout.
- `docs/13-production-runbook.md` for legacy/full-stack deployment reference.
