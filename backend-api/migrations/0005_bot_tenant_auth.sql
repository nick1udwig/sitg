create table if not exists bot_clients (
  id uuid primary key,
  owner_user_id uuid not null references users(id),
  name text not null,
  status text not null check (status in ('ACTIVE','DISABLED')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists bot_client_keys (
  key_id text primary key,
  bot_client_id uuid not null references bot_clients(id),
  secret_hash text not null,
  active boolean not null default true,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null
);

create index if not exists bot_client_keys_bot_active_idx
  on bot_client_keys (bot_client_id, active);

create table if not exists bot_installation_bindings (
  bot_client_id uuid not null references bot_clients(id),
  installation_id bigint not null references github_installations(installation_id),
  created_at timestamptz not null,
  primary key (bot_client_id, installation_id)
);

create unique index if not exists bot_installation_bindings_installation_unique
  on bot_installation_bindings (installation_id);

alter table pr_challenges
  add column if not exists created_by_bot_client_id uuid null references bot_clients(id);
