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
    pool.execute(include_str!(
        "../migrations/0003_internal_replay_and_outbox.sql"
    ))
    .await
    .expect("apply 0003");
    pool.execute(include_str!("../migrations/0004_bot_action_results.sql"))
        .await
        .expect("apply 0004");
    pool.execute(include_str!("../migrations/0005_bot_tenant_auth.sql"))
        .await
        .expect("apply 0005");
    pool.execute(include_str!(
        "../migrations/0006_user_sessions_github_access_token.sql"
    ))
    .await
    .expect("apply 0006");
    pool.execute(include_str!("../migrations/0007_centralized_bot_reset.sql"))
        .await
        .expect("apply 0007");
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
async fn github_delivery_is_unique_by_event_name() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let delivery = format!("delivery-{}", Uuid::new_v4());
    sqlx::query(
        "insert into github_event_deliveries (delivery_id, event_name, first_seen_at) values ($1, 'pull_request', now())",
    )
    .bind(&delivery)
    .execute(&pool)
    .await
    .expect("first insert");

    let duplicate = sqlx::query(
        "insert into github_event_deliveries (delivery_id, event_name, first_seen_at) values ($1, 'pull_request', now())",
    )
    .bind(&delivery)
    .execute(&pool)
    .await;
    assert!(duplicate.is_err(), "same delivery+event should fail");

    sqlx::query(
        "insert into github_event_deliveries (delivery_id, event_name, first_seen_at) values ($1, 'installation', now())",
    )
    .bind(&delivery)
    .execute(&pool)
    .await
    .expect("same delivery id with different event is allowed");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_actions_pending_unique_for_challenge() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    sqlx::query(
        "insert into github_installations (installation_id, account_login, account_type, active, created_at, updated_at) values (1, 'org', 'Organization', true, now(), now()) on conflict (installation_id) do nothing",
    )
    .execute(&pool)
    .await
    .expect("installation");

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
        "insert into bot_actions (id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at) values ($1, 'CLOSE_PR_WITH_COMMENT', $2, 1, 1, 'org/repo', 1, '{}'::jsonb, 'PENDING', null, null, now(), now())",
    )
    .bind(Uuid::new_v4())
    .bind(challenge_id)
    .execute(&pool)
    .await
    .expect("first action");

    let second = sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at) values ($1, 'CLOSE_PR_WITH_COMMENT', $2, 1, 1, 'org/repo', 1, '{}'::jsonb, 'PENDING', null, null, now(), now())",
    )
    .bind(Uuid::new_v4())
    .bind(challenge_id)
    .execute(&pool)
    .await;

    assert!(
        second.is_err(),
        "duplicate pending close action should fail"
    );
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_action_claim_and_result_v2_lifecycle() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    sqlx::query(
        "insert into github_installations (installation_id, account_login, account_type, active, created_at, updated_at) values (9, 'org9', 'Organization', true, now(), now()) on conflict (installation_id) do nothing",
    )
    .execute(&pool)
    .await
    .expect("installation");

    let action_id = Uuid::new_v4();
    sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at, claimed_by, failure_reason, attempts) values ($1, 'UPSERT_PR_COMMENT', null, 9, 9, 'org9/repo', 1, '{}'::jsonb, 'PENDING', null, null, now(), now(), null, null, 0)",
    )
    .bind(action_id)
    .execute(&pool)
    .await
    .expect("insert action");

    let claimed: Vec<(Uuid, i32)> = sqlx::query_as(
        r#"
        update bot_actions
        set status = 'CLAIMED', claimed_at = now(), claimed_by = 'worker-a', attempts = attempts + 1, updated_at = now()
        where id in (
            select id from bot_actions
            where status = 'PENDING'
            order by created_at asc
            limit 50
            for update skip locked
        )
        returning id, attempts
        "#,
    )
    .fetch_all(&pool)
    .await
    .expect("claim");

    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].0, action_id);
    assert_eq!(claimed[0].1, 1);

    let done = sqlx::query(
        "update bot_actions set status = 'DONE', completed_at = now(), failure_code = null, failure_reason = null, updated_at = now() where id = $1 and status = 'CLAIMED' and claimed_by = 'worker-a'",
    )
    .bind(action_id)
    .execute(&pool)
    .await
    .expect("mark done");
    assert_eq!(done.rows_affected(), 1);

    let status: String = sqlx::query_scalar("select status from bot_actions where id = $1")
        .bind(action_id)
        .fetch_one(&pool)
        .await
        .expect("get status");
    assert_eq!(status, "DONE");
}
