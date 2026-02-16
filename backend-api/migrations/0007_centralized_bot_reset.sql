create table if not exists service_bot_keys (
  key_id text primary key,
  secret_hash text not null,
  active boolean not null default true,
  last_used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null
);

create table if not exists github_installation_repositories (
  installation_id bigint not null references github_installations(installation_id),
  github_repo_id bigint not null,
  full_name text not null,
  active boolean not null default true,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (installation_id, github_repo_id)
);

create index if not exists github_installation_repositories_repo_lookup_idx
  on github_installation_repositories (github_repo_id, active, updated_at desc);

create table if not exists github_event_deliveries (
  delivery_id text not null,
  event_name text not null,
  first_seen_at timestamptz not null,
  primary key (delivery_id, event_name)
);

alter table github_installations
  add column if not exists active boolean not null default true,
  add column if not exists suspended_at timestamptz null,
  add column if not exists deleted_at timestamptz null;

alter table bot_actions
  add column if not exists installation_id bigint,
  add column if not exists repo_full_name text,
  add column if not exists failure_code text;

update bot_actions a
set installation_id = r.installation_id,
    repo_full_name = r.full_name
from repo_configs r
where a.github_repo_id = r.github_repo_id
  and (a.installation_id is null or a.repo_full_name is null);

alter table bot_actions
  alter column installation_id set not null,
  alter column repo_full_name set not null;

alter table bot_actions
  drop constraint if exists bot_actions_installation_id_fkey;

alter table bot_actions
  add constraint bot_actions_installation_id_fkey
  foreign key (installation_id) references github_installations(installation_id);

update bot_actions
set action_type = 'CLOSE_PR_WITH_COMMENT'
where action_type = 'CLOSE_PR';

alter table bot_actions
  drop constraint if exists bot_actions_status_check;

alter table bot_actions
  add constraint bot_actions_status_check
  check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED'));

alter table bot_actions
  drop constraint if exists bot_actions_action_type_check;

alter table bot_actions
  add constraint bot_actions_action_type_check
  check (action_type in ('UPSERT_PR_COMMENT', 'CLOSE_PR_WITH_COMMENT'));

drop index if exists bot_actions_pending_unique;

create unique index if not exists bot_actions_pending_unique
  on bot_actions (action_type, challenge_id)
  where status = 'PENDING' and challenge_id is not null;

alter table if exists pr_challenges
  drop column if exists created_by_bot_client_id;

drop table if exists bot_installation_bindings;
drop table if exists bot_client_keys;
drop table if exists bot_clients;
