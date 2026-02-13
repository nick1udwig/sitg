use sqlx::{Executor, PgPool};
use uuid::Uuid;

async fn maybe_pool() -> Option<PgPool> {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return None;
    };
    PgPool::connect(&url).await.ok()
}

async fn apply_migrations(pool: &PgPool) {
    pool.execute(include_str!("../migrations/0001_init.sql"))
        .await
        .expect("apply 0001");
    pool.execute(include_str!("../migrations/0002_auth_wallet.sql"))
        .await
        .expect("apply 0002");
    pool.execute(include_str!("../migrations/0003_internal_replay_and_outbox.sql"))
        .await
        .expect("apply 0003");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn replay_signature_is_unique() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let sig = format!("sig-{}", Uuid::new_v4());
    sqlx::query(
        "insert into internal_request_replays (id, signature, timestamp_unix, created_at) values ($1, $2, $3, now())",
    )
    .bind(Uuid::new_v4())
    .bind(&sig)
    .bind(1_i64)
    .execute(&pool)
    .await
    .expect("first insert");

    let second = sqlx::query(
        "insert into internal_request_replays (id, signature, timestamp_unix, created_at) values ($1, $2, $3, now())",
    )
    .bind(Uuid::new_v4())
    .bind(&sig)
    .bind(2_i64)
    .execute(&pool)
    .await;

    assert!(second.is_err(), "duplicate signature should fail");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_actions_pending_unique_for_challenge() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let challenge_id = Uuid::new_v4();
    sqlx::query(
        r#"
        insert into pr_challenges (
          id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
          github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
          draft_at_creation, deadline_at, status, verified_wallet_address, created_at, updated_at
        )
        values ($1, $2, 1, 'org/repo', 1, 1, 'alice', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, false, now(), 'PENDING', null, now(), now())
        "#,
    )
    .bind(challenge_id)
    .bind(format!("tok-{}", Uuid::new_v4()))
    .execute(&pool)
    .await
    .expect("insert challenge");

    sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, github_repo_id, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at) values ($1, 'CLOSE_PR', $2, 1, 1, '{}'::jsonb, 'PENDING', null, null, now(), now())",
    )
    .bind(Uuid::new_v4())
    .bind(challenge_id)
    .execute(&pool)
    .await
    .expect("first action");

    let second = sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, github_repo_id, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at) values ($1, 'CLOSE_PR', $2, 1, 1, '{}'::jsonb, 'PENDING', null, null, now(), now())",
    )
    .bind(Uuid::new_v4())
    .bind(challenge_id)
    .execute(&pool)
    .await;

    assert!(second.is_err(), "duplicate pending close action should fail");
}
