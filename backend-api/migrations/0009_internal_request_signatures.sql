alter table service_bot_keys
  add column if not exists public_key text,
  alter column secret_hash drop not null;

update service_bot_keys
set active = false,
    revoked_at = coalesce(revoked_at, now())
where public_key is null and active = true;

alter table internal_request_replays
  add column if not exists key_id text,
  add column if not exists request_nonce uuid;

update internal_request_replays
set key_id = coalesce(key_id, 'legacy'),
    request_nonce = coalesce(request_nonce, id)
where key_id is null or request_nonce is null;

alter table internal_request_replays
  alter column key_id set not null,
  alter column request_nonce set not null;

create unique index if not exists internal_request_replays_key_nonce_idx
  on internal_request_replays (key_id, request_nonce);
