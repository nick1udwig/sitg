create index if not exists oauth_states_retention_idx
  on oauth_states (expires_at, id);

create index if not exists user_sessions_retention_idx
  on user_sessions (
    least(expires_at, coalesce(revoked_at, expires_at)),
    id
  );

create index if not exists wallet_link_challenges_retention_idx
  on wallet_link_challenges (
    least(expires_at, coalesce(used_at, expires_at)),
    id
  );

create index if not exists challenge_nonces_retention_idx
  on challenge_nonces (
    least(expires_at, coalesce(used_at, expires_at)),
    nonce
  );

create index if not exists pr_confirmations_retention_idx
  on pr_confirmations (created_at, id);

create index if not exists audit_events_retention_idx
  on audit_events (created_at, id);

drop index if exists internal_request_replays_created_at_idx;

create index if not exists internal_request_replays_retention_idx
  on internal_request_replays (created_at, id);

create index if not exists github_event_deliveries_retention_idx
  on github_event_deliveries (first_seen_at, delivery_id, event_name);

create index if not exists bot_actions_retention_idx
  on bot_actions (coalesce(completed_at, updated_at), id)
  where status in ('DONE', 'FAILED');

create index if not exists spot_quotes_retention_idx
  on spot_quotes (fetched_at, id);
