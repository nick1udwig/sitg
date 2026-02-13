use std::{sync::Arc, time::Duration};

use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::{app::AppState, error::ApiResult};

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
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select id from pr_challenges where status = 'PENDING' and deadline_at <= $1 order by deadline_at asc limit 500",
    )
    .bind(Utc::now())
    .fetch_all(&state.pool)
    .await?;

    for challenge_id in due {
        let result = sqlx::query(
            r#"
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
                updated_at = $2
            where c.id = $1 and c.status = 'PENDING'
            "#,
        )
        .bind(challenge_id)
        .bind(Utc::now())
        .execute(&state.pool)
        .await?;

        if result.rows_affected() > 0 {
            sqlx::query(
                "insert into audit_events (id, event_type, entity_type, entity_id, payload, created_at) values ($1, 'CHALLENGE_DEADLINE_SWEEP', 'challenge', $2, $3, $4)",
            )
            .bind(Uuid::new_v4())
            .bind(challenge_id.to_string())
            .bind(json!({"job":"deadline_sweeper"}))
            .bind(Utc::now())
            .execute(&state.pool)
            .await?;
        }
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

    tracing::info!(
        deleted_confirmations,
        deleted_audits,
        cutoff = %cutoff,
        "retention cleanup completed"
    );

    Ok(())
}

fn retention_cutoff(now_unix: i64) -> chrono::DateTime<Utc> {
    chrono::DateTime::from_timestamp(now_unix, 0)
        .expect("valid now timestamp")
        - chrono::Duration::days(365)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_one_year_cutoff() {
        let now = 1_800_000_000i64;
        let cutoff = retention_cutoff(now);
        assert_eq!(cutoff.timestamp(), now - 365 * 24 * 60 * 60);
    }
}
