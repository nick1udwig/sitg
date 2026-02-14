alter table if exists user_sessions
  add column if not exists github_access_token text;
