create index if not exists pr_challenges_pending_deadline_idx
  on pr_challenges (deadline_at, id)
  where status = 'PENDING';
