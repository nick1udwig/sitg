alter table bot_actions
  add column if not exists available_at timestamptz;

update bot_actions
set available_at = coalesce(updated_at, created_at, now())
where available_at is null;

alter table bot_actions
  alter column available_at set default now(),
  alter column available_at set not null;

drop index if exists bot_actions_pending_idx;

create index if not exists bot_actions_available_idx
  on bot_actions (status, available_at, created_at)
  where status = 'PENDING';

create index if not exists bot_actions_claim_lease_idx
  on bot_actions (claimed_at)
  where status = 'CLAIMED';
