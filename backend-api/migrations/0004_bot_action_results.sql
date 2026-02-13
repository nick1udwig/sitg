alter table bot_actions
  add column if not exists claimed_by text null,
  add column if not exists failure_reason text null,
  add column if not exists attempts int not null default 0;

create index if not exists bot_actions_claimed_by_idx
  on bot_actions (claimed_by, status, updated_at);
