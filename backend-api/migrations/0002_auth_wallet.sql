create table if not exists oauth_states (
  id uuid primary key,
  state text not null unique,
  expires_at timestamptz not null,
  redirect_after text null,
  created_at timestamptz not null
);

create table if not exists user_sessions (
  id uuid primary key,
  user_id uuid not null references users(id),
  session_token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  revoked_at timestamptz null
);

create index if not exists user_sessions_lookup_token
  on user_sessions (session_token)
  where revoked_at is null;

create table if not exists wallet_link_challenges (
  id uuid primary key,
  user_id uuid not null references users(id),
  nonce uuid not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null
);

create index if not exists wallet_link_challenges_user_active
  on wallet_link_challenges (user_id, expires_at desc)
  where used_at is null;
