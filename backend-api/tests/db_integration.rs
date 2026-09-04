use chrono::{Duration, Utc};
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
    pool.execute(include_str!("../migrations/0008_bot_action_reliability.sql"))
        .await
        .expect("apply 0008");
    pool.execute(include_str!("../migrations/0009_internal_request_signatures.sql"))
        .await
        .expect("apply 0009");
    pool.execute(include_str!("../migrations/0010_quote_cache_lookup.sql"))
        .await
        .expect("apply 0010");
    pool.execute(include_str!(
        "../migrations/0011_pending_challenge_deadlines.sql"
    ))
    .await
    .expect("apply 0011");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn replay_nonce_is_unique_per_key() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let request_nonce = Uuid::new_v4();
    sqlx::query(
        "insert into internal_request_replays (id, key_id, request_nonce, signature, timestamp_unix, created_at) values ($1, 'test-key', $2, $3, $4, now())",
    )
    .bind(Uuid::new_v4())
    .bind(request_nonce)
    .bind(format!("sig-{}", Uuid::new_v4()))
    .bind(1_i64)
    .execute(&pool)
    .await
    .expect("first insert");

    let second = sqlx::query(
        "insert into internal_request_replays (id, key_id, request_nonce, signature, timestamp_unix, created_at) values ($1, 'test-key', $2, $3, $4, now())",
    )
    .bind(Uuid::new_v4())
    .bind(request_nonce)
    .bind(format!("sig-{}", Uuid::new_v4()))
    .bind(2_i64)
    .execute(&pool)
    .await;

    assert!(second.is_err(), "duplicate request nonce should fail");
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

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_action_claim_reclaims_expired_leases_and_respects_backoff() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let installation_id = 90_001_i64;
    sqlx::query(
        "insert into github_installations (installation_id, account_login, account_type, active, created_at, updated_at) values ($1, 'lease-org', 'Organization', true, now(), now()) on conflict (installation_id) do nothing",
    )
    .bind(installation_id)
    .execute(&pool)
    .await
    .expect("installation");
    sqlx::query("delete from bot_actions where installation_id = $1")
        .bind(installation_id)
        .execute(&pool)
        .await
        .expect("clear prior lease-test actions");

    let stale_claim = Uuid::new_v4();
    let fresh_claim = Uuid::new_v4();
    let ready_pending = Uuid::new_v4();
    let delayed_pending = Uuid::new_v4();
    let now = Utc::now();

    for (id, status, claimed_at, available_at) in [
        (
            stale_claim,
            "CLAIMED",
            Some(now - Duration::minutes(10)),
            now,
        ),
        (fresh_claim, "CLAIMED", Some(now), now),
        (
            ready_pending,
            "PENDING",
            None,
            now - Duration::minutes(1),
        ),
        (
            delayed_pending,
            "PENDING",
            None,
            now + Duration::hours(1),
        ),
    ] {
        sqlx::query(
            r#"
            insert into bot_actions (
              id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name,
              github_pr_number, payload, status, claimed_by, claimed_at, completed_at,
              failure_reason, attempts, available_at, created_at, updated_at
            )
            values ($1, 'UPSERT_PR_COMMENT', null, $2, $2, 'lease-org/repo', 1, '{}'::jsonb,
                    $3, $4, $5, null, null, 1, $6, $7, $7)
            "#,
        )
        .bind(id)
        .bind(installation_id)
        .bind(status)
        .bind(if status == "CLAIMED" {
            Some("old-worker")
        } else {
            None
        })
        .bind(claimed_at)
        .bind(available_at)
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert action");
    }

    let claimed: Vec<Uuid> = sqlx::query_scalar(
        r#"
        update bot_actions a
        set status = 'CLAIMED', claimed_at = $2, claimed_by = $3, attempts = attempts + 1, updated_at = $2
        where a.id in (
          select a2.id from bot_actions a2
          where (a2.status = 'PENDING' and a2.available_at <= $2)
             or (a2.status = 'CLAIMED' and (a2.claimed_at is null or a2.claimed_at <= $4))
          order by case when a2.status = 'CLAIMED' then a2.claimed_at else a2.available_at end asc,
                   a2.created_at asc
          limit $1
          for update skip locked
        )
        returning a.id
        "#,
    )
    .bind(100_i64)
    .bind(now)
    .bind("new-worker")
    .bind(now - Duration::minutes(5))
    .fetch_all(&pool)
    .await
    .expect("claim actions");

    assert!(claimed.contains(&stale_claim));
    assert!(claimed.contains(&ready_pending));
    assert!(!claimed.contains(&fresh_claim));
    assert!(!claimed.contains(&delayed_pending));
}
