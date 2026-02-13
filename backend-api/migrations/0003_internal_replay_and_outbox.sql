create table if not exists internal_request_replays (
  id uuid primary key,
  signature text not null unique,
  timestamp_unix bigint not null,
  created_at timestamptz not null
);

create index if not exists internal_request_replays_created_at_idx
  on internal_request_replays (created_at);

create table if not exists bot_actions (
  id uuid primary key,
  action_type text not null,
  challenge_id uuid null references pr_challenges(id),
  github_repo_id bigint not null,
  github_pr_number int not null,
  payload jsonb not null,
  status text not null check (status in ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),
  claimed_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists bot_actions_pending_idx
  on bot_actions (status, created_at);

create unique index if not exists bot_actions_pending_unique
  on bot_actions (action_type, challenge_id)
  where status = 'PENDING' and challenge_id is not null;
