use std::{sync::Arc, time::Duration};

use chrono::Utc;

use crate::{app::AppState, error::ApiResult};

const DEADLINE_SWEEP_BATCH_SIZE: i64 = 500;
const TIMEOUT_COMMENT: &str =
    "Stake verification was not completed within 30 minutes, so this PR has been closed.";

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
    let mut ticker = tokio::time::interval(Duration::from_secs(60 * 60 * 24));
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
    let cutoff = retention_cutoff(Utc::now().timestamp());

    let deleted_confirmations = sqlx::query("delete from pr_confirmations where created_at < $1")
        .bind(cutoff)
        .execute(&state.pool)
        .await?
        .rows_affected();

    let deleted_audits = sqlx::query("delete from audit_events where created_at < $1")
        .bind(cutoff)
        .execute(&state.pool)
        .await?
        .rows_affected();
    let deleted_replays = sqlx::query("delete from internal_request_replays where created_at < $1")
        .bind(Utc::now() - chrono::Duration::days(2))
        .execute(&state.pool)
        .await?
        .rows_affected();

    tracing::info!(
        deleted_confirmations,
        deleted_audits,
        deleted_replays,
        cutoff = %cutoff,
        "retention cleanup completed"
    );

    Ok(())
}

fn retention_cutoff(now_unix: i64) -> chrono::DateTime<Utc> {
    chrono::DateTime::from_timestamp(now_unix, 0).expect("valid now timestamp")
        - chrono::Duration::days(365)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use sqlx::PgPool;
    use uuid::Uuid;

    #[test]
    fn computes_one_year_cutoff() {
        let now = 1_800_000_000i64;
        let cutoff = retention_cutoff(now);
        assert_eq!(cutoff.timestamp(), now - 365 * 24 * 60 * 60);
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

        let config = Config {
            host: "127.0.0.1".to_string(),
            port: 8080,
            database_url,
            db_max_connections: 10,
            app_base_url: "https://sitg.io".to_string(),
            api_base_url: "https://sitg.io".to_string(),
            github_client_id: None,
            github_client_secret: None,
            session_cookie_name: "sitg_session".to_string(),
            blocked_unlink_wallets: vec![],
            base_rpc_url: "https://mainnet.base.org".to_string(),
            staking_contract_address: "0x1111111111111111111111111111111111111111".to_string(),
        };
        let state = Arc::new(AppState::new(pool.clone(), config));
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

        let action_count: i64 = sqlx::query_scalar(
            "select count(*) from bot_actions where challenge_id in ($1, $2)",
        )
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
}
