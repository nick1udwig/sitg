update user_sessions
set session_token = 'sha256:' || encode(digest(session_token, 'sha256'), 'hex')
where session_token not like 'sha256:%';

alter table user_sessions
  add column if not exists github_access_token_encrypted text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_sessions_no_plaintext_oauth_tokens'
      and conrelid = 'user_sessions'::regclass
  ) then
    alter table user_sessions
      add constraint user_sessions_no_plaintext_oauth_tokens
      check (github_access_token is null) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_sessions_encrypted_oauth_token_format'
      and conrelid = 'user_sessions'::regclass
  ) then
    alter table user_sessions
      add constraint user_sessions_encrypted_oauth_token_format
      check (
        github_access_token_encrypted is null
        or github_access_token_encrypted ~ '^enc:v1:[A-Za-z0-9_-]+$'
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_sessions_session_token_digest_check'
      and conrelid = 'user_sessions'::regclass
  ) then
    alter table user_sessions
      add constraint user_sessions_session_token_digest_check
      check (session_token ~ '^sha256:[0-9a-f]{64}$');
  end if;
end
$$;

comment on column user_sessions.session_token is
  'SHA-256 digest of the bearer session token, prefixed with sha256:';

comment on column user_sessions.github_access_token is
  'Legacy plaintext OAuth token column; startup backfill clears this before serving requests.';

comment on column user_sessions.github_access_token_encrypted is
  'Versioned AES-256-GCM ciphertext of the GitHub OAuth access token.';
