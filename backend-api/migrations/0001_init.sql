create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key,
  github_user_id bigint not null unique,
  github_login text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists wallet_links (
  id uuid primary key,
  user_id uuid not null references users(id),
  wallet_address text not null,
  chain_id int not null default 8453,
  linked_at timestamptz not null,
  unlinked_at timestamptz null
);

create unique index if not exists wallet_links_one_active_wallet_per_user
  on wallet_links (user_id)
  where unlinked_at is null;

create unique index if not exists wallet_links_one_active_user_per_wallet
  on wallet_links (wallet_address)
  where unlinked_at is null;

create table if not exists github_installations (
  installation_id bigint primary key,
  account_login text not null,
  account_type text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists spot_quotes (
  id uuid primary key,
  source text not null,
  pair text not null,
  price numeric(20,8) not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null
);

create index if not exists spot_quotes_latest_lookup
  on spot_quotes (source, pair, fetched_at desc);

create table if not exists repo_configs (
  github_repo_id bigint primary key,
  installation_id bigint not null references github_installations(installation_id),
  full_name text not null,
  draft_prs_gated boolean not null default true,
  threshold_wei numeric(78,0) not null,
  input_mode text not null check (input_mode in ('ETH', 'USD')),
  input_value numeric(38,18) not null,
  spot_price_usd numeric(20,8) not null,
  spot_source text not null,
  spot_at timestamptz not null,
  spot_quote_id uuid null references spot_quotes(id),
  spot_from_cache boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists repo_whitelist (
  id uuid primary key,
  github_repo_id bigint not null references repo_configs(github_repo_id),
  github_user_id bigint not null,
  github_login text not null,
  created_at timestamptz not null,
  unique (github_repo_id, github_user_id)
);

create table if not exists pr_challenges (
  id uuid primary key,
  gate_token text not null unique,
  github_repo_id bigint not null,
  github_repo_full_name text not null,
  github_pr_number int not null,
  github_pr_author_id bigint not null,
  github_pr_author_login text not null,
  head_sha char(40) not null,
  threshold_wei_snapshot numeric(78,0) not null,
  draft_at_creation boolean not null,
  deadline_at timestamptz not null,
  status text not null check (status in ('PENDING', 'VERIFIED', 'EXEMPT', 'TIMED_OUT_CLOSED', 'CANCELED')),
  verified_wallet_address text null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create unique index if not exists pr_challenges_one_active_per_pr
  on pr_challenges (github_repo_id, github_pr_number)
  where status in ('PENDING', 'VERIFIED', 'EXEMPT');

create table if not exists challenge_nonces (
  nonce uuid primary key,
  challenge_id uuid not null unique references pr_challenges(id),
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null
);

create table if not exists pr_confirmations (
  id uuid primary key,
  challenge_id uuid not null unique references pr_challenges(id),
  signature text not null,
  signer_address text not null,
  typed_data jsonb not null,
  created_at timestamptz not null
);

create table if not exists audit_events (
  id uuid primary key,
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  payload jsonb not null,
  created_at timestamptz not null
);
