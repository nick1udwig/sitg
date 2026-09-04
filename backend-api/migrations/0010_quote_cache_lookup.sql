drop index if exists spot_quotes_latest_lookup;

create index spot_quotes_latest_lookup
  on spot_quotes (pair, fetched_at desc);
