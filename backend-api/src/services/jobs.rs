use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Duration as ChronoDuration, Utc};

use crate::{app::AppState, error::ApiResult};

const DEADLINE_SWEEP_BATCH_SIZE: i64 = 500;
const RETENTION_BATCH_SIZE: i64 = 10_000;
const CONFIRMATION_RETENTION_DAYS: i64 = 365;
const REPLAY_RETENTION_DAYS: i64 = 2;
const DELIVERY_RETENTION_DAYS: i64 = 30;
const BOT_ACTION_RETENTION_DAYS: i64 = 90;
const QUOTE_RETENTION_HOURS: i64 = 24;
const TIMEOUT_COMMENT: &str =
    "Stake verification was not completed within 30 minutes, so this PR has been closed.";

#[derive(sqlx::FromRow)]
struct RetentionCounts {
    oauth_states: i64,
    user_sessions: i64,
    wallet_link_challenges: i64,
    challenge_nonces: i64,
    pr_confirmations: i64,
    audit_events: i64,
    internal_request_replays: i64,
    github_event_deliveries: i64,
    bot_actions: i64,
    spot_quotes: i64,
}

impl RetentionCounts {
    fn hit_batch_limit(&self) -> bool {
        [
            self.oauth_states,
            self.user_sessions,
            self.wallet_link_challenges,
            self.challenge_nonces,
            self.pr_confirmations,
            self.audit_events,
            self.internal_request_replays,
            self.github_event_deliveries,
            self.bot_actions,
            self.spot_quotes,
        ]
        .contains(&RETENTION_BATCH_SIZE)
    }
}

pub fn start_background_jobs(state: Arc<AppState>) {
    let state_for_deadlines = state.clone();
    tokio::spawn(async move {
        run_deadline_loop(state_for_deadlines).await;
    });

    tokio::spawn(async move {
        run_retention_loop(state).await;
    });
}

async fn run_deadline_loop(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;
        if let Err(err) = process_due_challenges(&state).await {
            tracing::error!(error = %err, "deadline loop iteration failed");
        }
    }
}

async fn run_retention_loop(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(Duration::from_secs(60 * 60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;
        if let Err(err) = cleanup_retention(&state).await {
            tracing::error!(error = %err, "retention cleanup iteration failed");
        }
    }
}

async fn process_due_challenges(state: &AppState) -> ApiResult<()> {
    let now = Utc::now();
    let (transitioned, audits_inserted, actions_inserted): (i64, i64, i64) = sqlx::query_as(
        r#"
        with due as materialized (
          select c.id
          from pr_challenges c
          where c.status = 'PENDING' and c.deadline_at <= $1
          order by c.deadline_at asc, c.id asc
          limit $2
          for update skip locked
        ),
        transitioned as (
          update pr_challenges c
          set status = case
                         when exists (
                           select 1
                           from repo_whitelist w
                           where w.github_repo_id = c.github_repo_id
                             and w.github_user_id = c.github_pr_author_id
                         ) then 'EXEMPT'
                         else 'TIMED_OUT_CLOSED'
                       end,
              updated_at = $1
          from due
          where c.id = due.id and c.status = 'PENDING'
          returning c.id, c.github_repo_id, c.github_pr_number, c.status
        ),
        inserted_audits as (
          insert into audit_events (id, event_type, entity_type, entity_id, payload, created_at)
          select gen_random_uuid(), 'CHALLENGE_DEADLINE_SWEEP', 'challenge', t.id::text,
                 jsonb_build_object('job', 'deadline_sweeper', 'status', t.status), $1
          from transitioned t
          returning 1
        ),
        inserted_actions as (
          insert into bot_actions (
            id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name,
            github_pr_number, payload, status, claimed_at, completed_at, available_at,
            created_at, updated_at
          )
          select gen_random_uuid(), 'CLOSE_PR_WITH_COMMENT', t.id, r.installation_id,
                 t.github_repo_id, r.full_name, t.github_pr_number,
                 jsonb_build_object(
                   'comment_markdown', $3::text,
                   'comment_marker', 'sitg:timeout:' || t.id::text,
                   'reason', 'CHALLENGE_TIMEOUT',
                   'extra', jsonb_build_object('source', 'deadline_sweeper')
                 ),
                 'PENDING', null, null, $1, $1, $1
          from transitioned t
          join repo_configs r on r.github_repo_id = t.github_repo_id
          where t.status = 'TIMED_OUT_CLOSED'
          on conflict do nothing
          returning 1
        )
        select (select count(*) from transitioned),
               (select count(*) from inserted_audits),
               (select count(*) from inserted_actions)
        "#,
    )
    .bind(now)
    .bind(DEADLINE_SWEEP_BATCH_SIZE)
    .bind(TIMEOUT_COMMENT)
    .fetch_one(&state.pool)
    .await?;

    if transitioned > 0 {
        tracing::info!(
            transitioned,
            audits_inserted,
            actions_inserted,
            "deadline sweep completed"
        );
    }

    Ok(())
}

async fn cleanup_retention(state: &AppState) -> ApiResult<()> {
    let now = Utc::now();
    let counts = cleanup_retention_at(state, now).await?;

    if counts.hit_batch_limit() {
        tracing::warn!(
            batch_size = RETENTION_BATCH_SIZE,
            "retention cleanup reached a batch limit; more expired rows remain for a later run"
        );
    }

    tracing::info!(
        oauth_states = counts.oauth_states,
        user_sessions = counts.user_sessions,
        wallet_link_challenges = counts.wallet_link_challenges,
        challenge_nonces = counts.challenge_nonces,
        pr_confirmations = counts.pr_confirmations,
        audit_events = counts.audit_events,
        internal_request_replays = counts.internal_request_replays,
        github_event_deliveries = counts.github_event_deliveries,
        bot_actions = counts.bot_actions,
        spot_quotes = counts.spot_quotes,
        "retention cleanup completed"
    );

    Ok(())
}

async fn cleanup_retention_at(state: &AppState, now: DateTime<Utc>) -> ApiResult<RetentionCounts> {
    let counts = sqlx::query_as(
        r#"
        with stale_oauth_states as materialized (
          select id
          from oauth_states
          where expires_at <= $1
          order by expires_at, id
          limit $2
          for update skip locked
        ),
        deleted_oauth_states as (
          delete from oauth_states target
          using stale_oauth_states stale
          where target.id = stale.id
          returning 1
        ),
        stale_user_sessions as materialized (
          select id
          from user_sessions
          where least(expires_at, coalesce(revoked_at, expires_at)) <= $1
          order by least(expires_at, coalesce(revoked_at, expires_at)), id
          limit $2
          for update skip locked
        ),
        deleted_user_sessions as (
          delete from user_sessions target
          using stale_user_sessions stale
          where target.id = stale.id
          returning 1
        ),
        stale_wallet_link_challenges as materialized (
          select id
          from wallet_link_challenges
          where least(expires_at, coalesce(used_at, expires_at)) <= $1
          order by least(expires_at, coalesce(used_at, expires_at)), id
          limit $2
          for update skip locked
        ),
        deleted_wallet_link_challenges as (
          delete from wallet_link_challenges target
          using stale_wallet_link_challenges stale
          where target.id = stale.id
          returning 1
        ),
        stale_challenge_nonces as materialized (
          select nonce
          from challenge_nonces
          where least(expires_at, coalesce(used_at, expires_at)) <= $1
          order by least(expires_at, coalesce(used_at, expires_at)), nonce
          limit $2
          for update skip locked
        ),
        deleted_challenge_nonces as (
          delete from challenge_nonces target
          using stale_challenge_nonces stale
          where target.nonce = stale.nonce
          returning 1
        ),
        stale_pr_confirmations as materialized (
          select id
          from pr_confirmations
          where created_at <= $3
          order by created_at, id
          limit $2
          for update skip locked
        ),
        deleted_pr_confirmations as (
          delete from pr_confirmations target
          using stale_pr_confirmations stale
          where target.id = stale.id
          returning 1
        ),
        stale_audit_events as materialized (
          select id
          from audit_events
          where created_at <= $3
          order by created_at, id
          limit $2
          for update skip locked
        ),
        deleted_audit_events as (
          delete from audit_events target
          using stale_audit_events stale
          where target.id = stale.id
          returning 1
        ),
        stale_internal_request_replays as materialized (
          select id
          from internal_request_replays
          where created_at <= $4
          order by created_at, id
          limit $2
          for update skip locked
        ),
        deleted_internal_request_replays as (
          delete from internal_request_replays target
          using stale_internal_request_replays stale
          where target.id = stale.id
          returning 1
        ),
        stale_github_event_deliveries as materialized (
          select delivery_id, event_name
          from github_event_deliveries
          where first_seen_at <= $5
          order by first_seen_at, delivery_id, event_name
          limit $2
          for update skip locked
        ),
        deleted_github_event_deliveries as (
          delete from github_event_deliveries target
          using stale_github_event_deliveries stale
          where target.delivery_id = stale.delivery_id
            and target.event_name = stale.event_name
          returning 1
        ),
        stale_bot_actions as materialized (
          select id
          from bot_actions
          where status in ('DONE', 'FAILED')
            and coalesce(completed_at, updated_at) <= $6
          order by coalesce(completed_at, updated_at), id
          limit $2
          for update skip locked
        ),
        deleted_bot_actions as (
          delete from bot_actions target
          using stale_bot_actions stale
          where target.id = stale.id
          returning 1
        ),
        stale_spot_quotes as materialized (
          select q.id
          from spot_quotes q
          where q.fetched_at <= $7
            and not exists (
              select 1 from repo_configs r where r.spot_quote_id = q.id
            )
          order by q.fetched_at, q.id
          limit $2
          for update skip locked
        ),
        deleted_spot_quotes as (
          delete from spot_quotes target
          using stale_spot_quotes stale
          where target.id = stale.id
            and not exists (
              select 1 from repo_configs r where r.spot_quote_id = target.id
            )
          returning 1
        )
        select (select count(*) from deleted_oauth_states) as oauth_states,
               (select count(*) from deleted_user_sessions) as user_sessions,
               (select count(*) from deleted_wallet_link_challenges) as wallet_link_challenges,
               (select count(*) from deleted_challenge_nonces) as challenge_nonces,
               (select count(*) from deleted_pr_confirmations) as pr_confirmations,
               (select count(*) from deleted_audit_events) as audit_events,
               (select count(*) from deleted_internal_request_replays) as internal_request_replays,
               (select count(*) from deleted_github_event_deliveries) as github_event_deliveries,
               (select count(*) from deleted_bot_actions) as bot_actions,
               (select count(*) from deleted_spot_quotes) as spot_quotes
        "#,
    )
    .bind(now)
    .bind(RETENTION_BATCH_SIZE)
    .bind(days_before(now, CONFIRMATION_RETENTION_DAYS))
    .bind(days_before(now, REPLAY_RETENTION_DAYS))
    .bind(days_before(now, DELIVERY_RETENTION_DAYS))
    .bind(days_before(now, BOT_ACTION_RETENTION_DAYS))
    .bind(now - ChronoDuration::hours(QUOTE_RETENTION_HOURS))
    .fetch_one(&state.pool)
    .await?;

    Ok(counts)
}

fn days_before(now: DateTime<Utc>, days: i64) -> DateTime<Utc> {
    now - ChronoDuration::days(days)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use sqlx::PgPool;
    use uuid::Uuid;

    fn test_state(pool: PgPool, database_url: String) -> AppState {
        AppState::new(
            pool,
            Config {
                host: "127.0.0.1".to_string(),
                port: 8080,
                database_url,
                db_max_connections: 10,
                app_base_url: "https://sitg.io".to_string(),
                api_base_url: "https://sitg.io".to_string(),
                github_client_id: None,
                github_client_secret: None,
                token_encryption_key: crate::config::TokenEncryptionKey::from_bytes([7_u8; 32]),
                session_cookie_name: "sitg_session".to_string(),
                blocked_unlink_wallets: vec![],
                base_rpc_url: "https://mainnet.base.org".to_string(),
                staking_contract_address: "0x1111111111111111111111111111111111111111".to_string(),
            },
        )
    }

    #[test]
    fn computes_one_year_cutoff() {
        let now_unix = 1_800_000_000i64;
        let now = DateTime::from_timestamp(now_unix, 0).expect("valid test timestamp");
        let cutoff = days_before(now, CONFIRMATION_RETENTION_DAYS);
        assert_eq!(cutoff.timestamp(), now_unix - 365 * 24 * 60 * 60);
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL postgres"]
    async fn concurrent_deadline_sweeps_transition_and_enqueue_exactly_once() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set for the deadline sweep integration test");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to deadline sweep test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let repo_id = 8_000_000_000_i64 + i64::from(rand::random::<u32>());
        let installation_id = repo_id;
        let repo_full_name = format!("deadline-test-{repo_id}/repo");
        let timed_out_id = Uuid::new_v4();
        let exempt_id = Uuid::new_v4();
        let now = Utc::now();

        sqlx::query(
            "insert into github_installations (installation_id, account_login, account_type, active, created_at, updated_at) values ($1, $2, 'Organization', true, $3, $3)",
        )
        .bind(installation_id)
        .bind(format!("deadline-test-{repo_id}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert installation");
        sqlx::query(
            r#"
            insert into repo_configs (
              github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei,
              input_mode, input_value, spot_price_usd, spot_source, spot_at, spot_quote_id,
              spot_from_cache, created_at, updated_at
            )
            values ($1, $2, $3, true, 1, 'ETH', 1, 2000, 'test', $4, null, false, $4, $4)
            "#,
        )
        .bind(repo_id)
        .bind(installation_id)
        .bind(&repo_full_name)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert repo config");
        sqlx::query(
            "insert into repo_whitelist (id, github_repo_id, github_user_id, github_login, created_at) values ($1, $2, 2002, 'exempt-user', $3)",
        )
        .bind(Uuid::new_v4())
        .bind(repo_id)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert whitelist entry");

        for (challenge_id, pr_number, author_id, author_login) in [
            (timed_out_id, 1, 2001_i64, "timed-out-user"),
            (exempt_id, 2, 2002_i64, "exempt-user"),
        ] {
            sqlx::query(
                r#"
                insert into pr_challenges (
                  id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
                  github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
                  draft_at_creation, deadline_at, status, verified_wallet_address, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7,
                        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, false,
                        $8, 'PENDING', null, $9, $9)
                "#,
            )
            .bind(challenge_id)
            .bind(format!("deadline-test-{challenge_id}"))
            .bind(repo_id)
            .bind(&repo_full_name)
            .bind(pr_number)
            .bind(author_id)
            .bind(author_login)
            .bind(now - chrono::Duration::minutes(1))
            .bind(now)
            .execute(&pool)
            .await
            .expect("insert challenge");
        }

        let state = Arc::new(test_state(pool.clone(), database_url));
        let first_state = Arc::clone(&state);
        let second_state = Arc::clone(&state);
        let (first, second) = tokio::join!(
            tokio::spawn(async move { process_due_challenges(&first_state).await }),
            tokio::spawn(async move { process_due_challenges(&second_state).await }),
        );
        first.expect("first sweep task").expect("first sweep");
        second.expect("second sweep task").expect("second sweep");

        let timed_out_status: String =
            sqlx::query_scalar("select status from pr_challenges where id = $1")
                .bind(timed_out_id)
                .fetch_one(&pool)
                .await
                .expect("timed-out status");
        let exempt_status: String =
            sqlx::query_scalar("select status from pr_challenges where id = $1")
                .bind(exempt_id)
                .fetch_one(&pool)
                .await
                .expect("exempt status");
        assert_eq!(timed_out_status, "TIMED_OUT_CLOSED");
        assert_eq!(exempt_status, "EXEMPT");

        let audit_count: i64 = sqlx::query_scalar(
            "select count(*) from audit_events where event_type = 'CHALLENGE_DEADLINE_SWEEP' and entity_id in ($1, $2)",
        )
        .bind(timed_out_id.to_string())
        .bind(exempt_id.to_string())
        .fetch_one(&pool)
        .await
        .expect("audit count");
        assert_eq!(audit_count, 2);

        let action_count: i64 =
            sqlx::query_scalar("select count(*) from bot_actions where challenge_id in ($1, $2)")
                .bind(timed_out_id)
                .bind(exempt_id)
                .fetch_one(&pool)
                .await
                .expect("action count");
        assert_eq!(action_count, 1);
        let action_marker: String = sqlx::query_scalar(
            "select payload->>'comment_marker' from bot_actions where challenge_id = $1",
        )
        .bind(timed_out_id)
        .fetch_one(&pool)
        .await
        .expect("action marker");
        assert_eq!(action_marker, format!("sitg:timeout:{timed_out_id}"));

        sqlx::query("delete from bot_actions where challenge_id in ($1, $2)")
            .bind(timed_out_id)
            .bind(exempt_id)
            .execute(&pool)
            .await
            .expect("clean actions");
        sqlx::query("delete from audit_events where entity_id in ($1, $2)")
            .bind(timed_out_id.to_string())
            .bind(exempt_id.to_string())
            .execute(&pool)
            .await
            .expect("clean audits");
        sqlx::query("delete from repo_whitelist where github_repo_id = $1")
            .bind(repo_id)
            .execute(&pool)
            .await
            .expect("clean whitelist");
        sqlx::query("delete from pr_challenges where id in ($1, $2)")
            .bind(timed_out_id)
            .bind(exempt_id)
            .execute(&pool)
            .await
            .expect("clean challenges");
        sqlx::query("delete from repo_configs where github_repo_id = $1")
            .bind(repo_id)
            .execute(&pool)
            .await
            .expect("clean repo config");
        sqlx::query("delete from github_installations where installation_id = $1")
            .bind(installation_id)
            .execute(&pool)
            .await
            .expect("clean installation");
    }

    #[tokio::test]
    #[ignore = "requires a disposable DATABASE_URL postgres"]
    async fn retention_cleanup_removes_only_expired_unreferenced_rows() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set for the retention integration test");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to retention test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let scope = Uuid::new_v4().simple().to_string();
        let now = Utc::now();
        let old_year = now - ChronoDuration::days(366);
        let user_id = Uuid::new_v4();
        let old_oauth_id = Uuid::new_v4();
        let fresh_oauth_id = Uuid::new_v4();
        let old_session_id = Uuid::new_v4();
        let fresh_session_id = Uuid::new_v4();
        let old_wallet_challenge_id = Uuid::new_v4();
        let fresh_wallet_challenge_id = Uuid::new_v4();
        let old_challenge_id = Uuid::new_v4();
        let fresh_challenge_id = Uuid::new_v4();
        let old_nonce = Uuid::new_v4();
        let fresh_nonce = Uuid::new_v4();
        let old_confirmation_id = Uuid::new_v4();
        let fresh_confirmation_id = Uuid::new_v4();
        let old_audit_id = Uuid::new_v4();
        let fresh_audit_id = Uuid::new_v4();
        let old_replay_id = Uuid::new_v4();
        let fresh_replay_id = Uuid::new_v4();
        let old_action_id = Uuid::new_v4();
        let fresh_action_id = Uuid::new_v4();
        let pending_action_id = Uuid::new_v4();
        let old_quote_id = Uuid::new_v4();
        let referenced_quote_id = Uuid::new_v4();
        let fresh_quote_id = Uuid::new_v4();
        let github_user_id = 8_000_000_000_i64 + i64::from(rand::random::<u32>());
        let installation_id = github_user_id;
        let repo_id = github_user_id;

        sqlx::query(
            r#"
            insert into oauth_states (id, state, expires_at, redirect_after, created_at)
            values ($1, $2, $3, null, $4), ($5, $6, $7, null, $4)
            "#,
        )
        .bind(old_oauth_id)
        .bind(format!("old-oauth-{scope}"))
        .bind(now - ChronoDuration::minutes(1))
        .bind(now)
        .bind(fresh_oauth_id)
        .bind(format!("fresh-oauth-{scope}"))
        .bind(now + ChronoDuration::hours(1))
        .execute(&pool)
        .await
        .expect("insert oauth states");

        sqlx::query(
            "insert into users (id, github_user_id, github_login, created_at, updated_at) values ($1, $2, $3, $4, $4)",
        )
        .bind(user_id)
        .bind(github_user_id)
        .bind(format!("retention-user-{scope}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert retention user");
        sqlx::query(
            r#"
            insert into user_sessions
              (id, user_id, session_token, github_access_token, expires_at, created_at, revoked_at)
            values ($1, $2, $3, null, $4, $5, $6),
                   ($7, $2, $8, null, $4, $5, null)
            "#,
        )
        .bind(old_session_id)
        .bind(user_id)
        .bind(crate::services::token_service::digest_session_token(&format!(
            "old-session-{scope}"
        )))
        .bind(now + ChronoDuration::hours(1))
        .bind(now)
        .bind(now - ChronoDuration::minutes(1))
        .bind(fresh_session_id)
        .bind(crate::services::token_service::digest_session_token(&format!(
            "fresh-session-{scope}"
        )))
        .execute(&pool)
        .await
        .expect("insert sessions");
        sqlx::query(
            r#"
            insert into wallet_link_challenges (id, user_id, nonce, expires_at, used_at, created_at)
            values ($1, $2, $3, $4, $5, $6), ($7, $2, $8, $4, null, $6)
            "#,
        )
        .bind(old_wallet_challenge_id)
        .bind(user_id)
        .bind(Uuid::new_v4())
        .bind(now + ChronoDuration::hours(1))
        .bind(now - ChronoDuration::minutes(1))
        .bind(now)
        .bind(fresh_wallet_challenge_id)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("insert wallet-link challenges");

        for (challenge_id, gate_prefix, pr_number) in [
            (old_challenge_id, "old", 1),
            (fresh_challenge_id, "fresh", 2),
        ] {
            sqlx::query(
                r#"
                insert into pr_challenges (
                  id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
                  github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
                  draft_at_creation, deadline_at, status, verified_wallet_address, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7,
                        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, false,
                        $8, 'CANCELED', null, $9, $9)
                "#,
            )
            .bind(challenge_id)
            .bind(format!("{gate_prefix}-retention-gate-{scope}"))
            .bind(repo_id)
            .bind(format!("retention-{scope}/repo"))
            .bind(pr_number)
            .bind(github_user_id)
            .bind(format!("retention-user-{scope}"))
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .expect("insert challenge");
        }
        sqlx::query(
            r#"
            insert into challenge_nonces (nonce, challenge_id, expires_at, used_at, created_at)
            values ($1, $2, $3, $4, $5), ($6, $7, $3, null, $5)
            "#,
        )
        .bind(old_nonce)
        .bind(old_challenge_id)
        .bind(now + ChronoDuration::hours(1))
        .bind(now - ChronoDuration::minutes(1))
        .bind(now)
        .bind(fresh_nonce)
        .bind(fresh_challenge_id)
        .execute(&pool)
        .await
        .expect("insert challenge nonces");
        sqlx::query(
            r#"
            insert into pr_confirmations
              (id, challenge_id, signature, signer_address, typed_data, created_at)
            values ($1, $2, $3, '0x1111111111111111111111111111111111111111', '{}'::jsonb, $4),
                   ($5, $6, $7, '0x1111111111111111111111111111111111111111', '{}'::jsonb, $8)
            "#,
        )
        .bind(old_confirmation_id)
        .bind(old_challenge_id)
        .bind(format!("old-signature-{scope}"))
        .bind(old_year)
        .bind(fresh_confirmation_id)
        .bind(fresh_challenge_id)
        .bind(format!("fresh-signature-{scope}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert confirmations");

        sqlx::query(
            r#"
            insert into audit_events (id, event_type, entity_type, entity_id, payload, created_at)
            values ($1, 'RETENTION_TEST', 'test', $2, '{}'::jsonb, $3),
                   ($4, 'RETENTION_TEST', 'test', $5, '{}'::jsonb, $6)
            "#,
        )
        .bind(old_audit_id)
        .bind(format!("old-{scope}"))
        .bind(old_year)
        .bind(fresh_audit_id)
        .bind(format!("fresh-{scope}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert audit events");
        sqlx::query(
            r#"
            insert into internal_request_replays
              (id, key_id, request_nonce, signature, timestamp_unix, created_at)
            values ($1, $2, $3, $4, $5, $6), ($7, $2, $8, $9, $10, $11)
            "#,
        )
        .bind(old_replay_id)
        .bind(format!("retention-key-{scope}"))
        .bind(Uuid::new_v4())
        .bind(format!("old-replay-signature-{scope}"))
        .bind((now - ChronoDuration::days(3)).timestamp())
        .bind(now - ChronoDuration::days(3))
        .bind(fresh_replay_id)
        .bind(Uuid::new_v4())
        .bind(format!("fresh-replay-signature-{scope}"))
        .bind(now.timestamp())
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert replay rows");
        sqlx::query(
            r#"
            insert into github_event_deliveries (delivery_id, event_name, first_seen_at)
            values ($1, 'retention_test', $2), ($3, 'retention_test', $4)
            "#,
        )
        .bind(format!("old-delivery-{scope}"))
        .bind(now - ChronoDuration::days(31))
        .bind(format!("fresh-delivery-{scope}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert delivery rows");

        sqlx::query(
            "insert into github_installations (installation_id, account_login, account_type, active, created_at, updated_at) values ($1, $2, 'Organization', true, $3, $3)",
        )
        .bind(installation_id)
        .bind(format!("retention-installation-{scope}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert installation");
        sqlx::query(
            r#"
            insert into spot_quotes (id, source, pair, price, fetched_at, expires_at, created_at)
            values ($1, 'test', $2, 2000, $3, $3, $4),
                   ($5, 'test', $2, 2001, $3, $3, $4),
                   ($6, 'test', $2, 2002, $4, $4, $4)
            "#,
        )
        .bind(old_quote_id)
        .bind(format!("RETENTION_{scope}"))
        .bind(now - ChronoDuration::hours(25))
        .bind(now)
        .bind(referenced_quote_id)
        .bind(fresh_quote_id)
        .execute(&pool)
        .await
        .expect("insert quote rows");
        sqlx::query(
            r#"
            insert into repo_configs (
              github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei,
              input_mode, input_value, spot_price_usd, spot_source, spot_at, spot_quote_id,
              spot_from_cache, created_at, updated_at
            )
            values ($1, $2, $3, true, 1, 'USD', 1, 2001, 'test', $4, $5, false, $4, $4)
            "#,
        )
        .bind(repo_id)
        .bind(installation_id)
        .bind(format!("retention-{scope}/repo"))
        .bind(now)
        .bind(referenced_quote_id)
        .execute(&pool)
        .await
        .expect("insert repo config");
        sqlx::query(
            r#"
            insert into bot_actions (
              id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name,
              github_pr_number, payload, status, claimed_at, completed_at, available_at,
              created_at, updated_at
            )
            values ($1, 'UPSERT_PR_COMMENT', null, $2, $3, $4, 1, '{}'::jsonb,
                    'DONE', null, $5, $5, $5, $5),
                   ($6, 'UPSERT_PR_COMMENT', null, $2, $3, $4, 2, '{}'::jsonb,
                    'DONE', null, $7, $7, $7, $7),
                   ($8, 'UPSERT_PR_COMMENT', null, $2, $3, $4, 3, '{}'::jsonb,
                    'PENDING', null, null, $5, $5, $5)
            "#,
        )
        .bind(old_action_id)
        .bind(installation_id)
        .bind(repo_id)
        .bind(format!("retention-{scope}/repo"))
        .bind(now - ChronoDuration::days(91))
        .bind(fresh_action_id)
        .bind(now)
        .bind(pending_action_id)
        .execute(&pool)
        .await
        .expect("insert bot actions");

        let state = test_state(pool.clone(), database_url);
        let counts = cleanup_retention_at(&state, now)
            .await
            .expect("run retention cleanup");
        assert_eq!(counts.oauth_states, 1);
        assert_eq!(counts.user_sessions, 1);
        assert_eq!(counts.wallet_link_challenges, 1);
        assert_eq!(counts.challenge_nonces, 1);
        assert_eq!(counts.pr_confirmations, 1);
        assert_eq!(counts.audit_events, 1);
        assert_eq!(counts.internal_request_replays, 1);
        assert_eq!(counts.github_event_deliveries, 1);
        assert_eq!(counts.bot_actions, 1);
        assert_eq!(counts.spot_quotes, 1);

        for (table, id) in [
            ("oauth_states", fresh_oauth_id),
            ("user_sessions", fresh_session_id),
            ("wallet_link_challenges", fresh_wallet_challenge_id),
            ("pr_confirmations", fresh_confirmation_id),
            ("audit_events", fresh_audit_id),
            ("internal_request_replays", fresh_replay_id),
            ("bot_actions", fresh_action_id),
            ("bot_actions", pending_action_id),
            ("spot_quotes", referenced_quote_id),
            ("spot_quotes", fresh_quote_id),
        ] {
            let query = format!("select exists(select 1 from {table} where id = $1)");
            let exists: bool = sqlx::query_scalar(&query)
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("query retained fixture");
            assert!(exists, "expected {table} fixture {id} to be retained");
        }
        let fresh_nonce_exists: bool =
            sqlx::query_scalar("select exists(select 1 from challenge_nonces where nonce = $1)")
                .bind(fresh_nonce)
                .fetch_one(&pool)
                .await
                .expect("query retained challenge nonce");
        assert!(fresh_nonce_exists);
        let fresh_delivery_exists: bool = sqlx::query_scalar(
            "select exists(select 1 from github_event_deliveries where delivery_id = $1)",
        )
        .bind(format!("fresh-delivery-{scope}"))
        .fetch_one(&pool)
        .await
        .expect("query retained delivery");
        assert!(fresh_delivery_exists);

        sqlx::query("delete from bot_actions where id in ($1, $2, $3)")
            .bind(old_action_id)
            .bind(fresh_action_id)
            .bind(pending_action_id)
            .execute(&pool)
            .await
            .expect("clean bot actions");
        sqlx::query("delete from repo_configs where github_repo_id = $1")
            .bind(repo_id)
            .execute(&pool)
            .await
            .expect("clean repo config");
        sqlx::query("delete from spot_quotes where id in ($1, $2, $3)")
            .bind(old_quote_id)
            .bind(referenced_quote_id)
            .bind(fresh_quote_id)
            .execute(&pool)
            .await
            .expect("clean quote rows");
        sqlx::query("delete from pr_confirmations where id in ($1, $2)")
            .bind(old_confirmation_id)
            .bind(fresh_confirmation_id)
            .execute(&pool)
            .await
            .expect("clean confirmations");
        sqlx::query("delete from challenge_nonces where nonce in ($1, $2)")
            .bind(old_nonce)
            .bind(fresh_nonce)
            .execute(&pool)
            .await
            .expect("clean challenge nonces");
        sqlx::query("delete from pr_challenges where id in ($1, $2)")
            .bind(old_challenge_id)
            .bind(fresh_challenge_id)
            .execute(&pool)
            .await
            .expect("clean challenges");
        sqlx::query("delete from wallet_link_challenges where id in ($1, $2)")
            .bind(old_wallet_challenge_id)
            .bind(fresh_wallet_challenge_id)
            .execute(&pool)
            .await
            .expect("clean wallet-link challenges");
        sqlx::query("delete from user_sessions where id in ($1, $2)")
            .bind(old_session_id)
            .bind(fresh_session_id)
            .execute(&pool)
            .await
            .expect("clean sessions");
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("clean user");
        sqlx::query("delete from oauth_states where id in ($1, $2)")
            .bind(old_oauth_id)
            .bind(fresh_oauth_id)
            .execute(&pool)
            .await
            .expect("clean oauth states");
        sqlx::query("delete from audit_events where id in ($1, $2)")
            .bind(old_audit_id)
            .bind(fresh_audit_id)
            .execute(&pool)
            .await
            .expect("clean audit rows");
        sqlx::query("delete from internal_request_replays where id in ($1, $2)")
            .bind(old_replay_id)
            .bind(fresh_replay_id)
            .execute(&pool)
            .await
            .expect("clean replay rows");
        sqlx::query("delete from github_event_deliveries where delivery_id in ($1, $2)")
            .bind(format!("old-delivery-{scope}"))
            .bind(format!("fresh-delivery-{scope}"))
            .execute(&pool)
            .await
            .expect("clean delivery rows");
        sqlx::query("delete from github_installations where installation_id = $1")
            .bind(installation_id)
            .execute(&pool)
            .await
            .expect("clean installation");
    }
}
