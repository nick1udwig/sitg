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
    pool.execute(include_str!("../migrations/0004_bot_action_results.sql"))
        .await
        .expect("apply 0004");
    pool.execute(include_str!("../migrations/0005_bot_tenant_auth.sql"))
        .await
        .expect("apply 0005");
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

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_action_result_lifecycle() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let id = Uuid::new_v4();
    sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, github_repo_id, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at, claimed_by, failure_reason, attempts) values ($1, 'CLOSE_PR', null, 9, 42, '{}'::jsonb, 'CLAIMED', now(), null, now(), now(), 'worker-a', null, 1)",
    )
    .bind(id)
    .execute(&pool)
    .await
    .expect("insert action");

    let done = sqlx::query(
        "update bot_actions set status = 'DONE', completed_at = now(), failure_reason = null, updated_at = now() where id = $1 and status = 'CLAIMED' and claimed_by = $2",
    )
    .bind(id)
    .bind("worker-a")
    .execute(&pool)
    .await
    .expect("mark done");
    assert_eq!(done.rows_affected(), 1);

    let status: String = sqlx::query_scalar("select status from bot_actions where id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("get status");
    assert_eq!(status, "DONE");
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_action_claim_filters_by_installation_binding() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let user_id = Uuid::new_v4();
    sqlx::query(
        "insert into users (id, github_user_id, github_login, created_at, updated_at) values ($1, 100, 'owner', now(), now())",
    )
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert owner");

    sqlx::query(
        "insert into github_installations (installation_id, account_login, account_type, created_at, updated_at) values (101, 'org1', 'Organization', now(), now()), (202, 'org2', 'Organization', now(), now())",
    )
    .execute(&pool)
    .await
    .expect("insert installations");

    let client_a = Uuid::new_v4();
    let client_b = Uuid::new_v4();
    sqlx::query(
        "insert into bot_clients (id, owner_user_id, name, status, created_at, updated_at) values ($1, $3, 'a', 'ACTIVE', now(), now()), ($2, $3, 'b', 'ACTIVE', now(), now())",
    )
    .bind(client_a)
    .bind(client_b)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert clients");

    sqlx::query(
        "insert into bot_installation_bindings (bot_client_id, installation_id, created_at) values ($1, 101, now()), ($2, 202, now())",
    )
    .bind(client_a)
    .bind(client_b)
    .execute(&pool)
    .await
    .expect("insert bindings");

    sqlx::query(
        r#"
        insert into repo_configs (
          github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
          spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache, created_at, updated_at
        )
        values
          (1, 101, 'org1/repo1', true, 1, 'ETH', 1, 2000, 'coingecko', now(), null, false, now(), now()),
          (2, 202, 'org2/repo2', true, 1, 'ETH', 1, 2000, 'coingecko', now(), null, false, now(), now())
        "#,
    )
    .execute(&pool)
    .await
    .expect("insert repos");

    let a1 = Uuid::new_v4();
    let a2 = Uuid::new_v4();
    sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, github_repo_id, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at) values ($1, 'CLOSE_PR', null, 1, 10, '{}'::jsonb, 'PENDING', null, null, now(), now()), ($2, 'CLOSE_PR', null, 2, 20, '{}'::jsonb, 'PENDING', null, null, now(), now())",
    )
    .bind(a1)
    .bind(a2)
    .execute(&pool)
    .await
    .expect("insert actions");

    let claimed: Vec<(Uuid, i64)> = sqlx::query_as(
        r#"
        update bot_actions a
        set status = 'CLAIMED', claimed_at = now(), claimed_by = 'worker-a', attempts = attempts + 1, updated_at = now()
        from repo_configs r
        where a.github_repo_id = r.github_repo_id
          and exists (
            select 1 from bot_installation_bindings b
            where b.bot_client_id = $1 and b.installation_id = r.installation_id
          )
          and a.id in (
            select a2.id from bot_actions a2
            join repo_configs r2 on r2.github_repo_id = a2.github_repo_id
            where a2.status = 'PENDING'
              and exists (
                select 1 from bot_installation_bindings b2
                where b2.bot_client_id = $1 and b2.installation_id = r2.installation_id
              )
            order by a2.created_at asc
            limit 50
            for update skip locked
          )
        returning a.id, a.github_repo_id
        "#,
    )
    .bind(client_a)
    .fetch_all(&pool)
    .await
    .expect("claim");

    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].1, 1);
}

#[tokio::test]
#[ignore = "requires DATABASE_URL postgres"]
async fn bot_action_result_requires_correct_tenant_binding() {
    let Some(pool) = maybe_pool().await else {
        return;
    };
    apply_migrations(&pool).await;

    let user_id = Uuid::new_v4();
    sqlx::query(
        "insert into users (id, github_user_id, github_login, created_at, updated_at) values ($1, 100, 'owner', now(), now())",
    )
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert owner");

    sqlx::query(
        "insert into github_installations (installation_id, account_login, account_type, created_at, updated_at) values (909, 'org9', 'Organization', now(), now())",
    )
    .execute(&pool)
    .await
    .expect("insert installations");

    let client_a = Uuid::new_v4();
    let client_b = Uuid::new_v4();
    sqlx::query(
        "insert into bot_clients (id, owner_user_id, name, status, created_at, updated_at) values ($1, $3, 'a', 'ACTIVE', now(), now()), ($2, $3, 'b', 'ACTIVE', now(), now())",
    )
    .bind(client_a)
    .bind(client_b)
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("insert clients");

    sqlx::query(
        "insert into bot_installation_bindings (bot_client_id, installation_id, created_at) values ($1, 909, now())",
    )
    .bind(client_a)
    .execute(&pool)
    .await
    .expect("insert binding");

    sqlx::query(
        r#"
        insert into repo_configs (
          github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
          spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache, created_at, updated_at
        )
        values (9, 909, 'org9/repo', true, 1, 'ETH', 1, 2000, 'coingecko', now(), null, false, now(), now())
        "#,
    )
    .execute(&pool)
    .await
    .expect("insert repo");

    let action_id = Uuid::new_v4();
    sqlx::query(
        "insert into bot_actions (id, action_type, challenge_id, github_repo_id, github_pr_number, payload, status, claimed_by, claimed_at, completed_at, created_at, updated_at, attempts) values ($1, 'CLOSE_PR', null, 9, 1, '{}'::jsonb, 'CLAIMED', 'worker-a', now(), null, now(), now(), 1)",
    )
    .bind(action_id)
    .execute(&pool)
    .await
    .expect("insert action");

    let wrong_tenant = sqlx::query(
        r#"
        update bot_actions a
        set status = 'DONE', completed_at = now(), failure_reason = null, updated_at = now()
        from repo_configs r
        where a.github_repo_id = r.github_repo_id
          and a.id = $1 and a.status = 'CLAIMED' and a.claimed_by = 'worker-a'
          and exists (
            select 1 from bot_installation_bindings b
            where b.bot_client_id = $2 and b.installation_id = r.installation_id
          )
        "#,
    )
    .bind(action_id)
    .bind(client_b)
    .execute(&pool)
    .await
    .expect("wrong tenant update");
    assert_eq!(wrong_tenant.rows_affected(), 0);

    let right_tenant = sqlx::query(
        r#"
        update bot_actions a
        set status = 'DONE', completed_at = now(), failure_reason = null, updated_at = now()
        from repo_configs r
        where a.github_repo_id = r.github_repo_id
          and a.id = $1 and a.status = 'CLAIMED' and a.claimed_by = 'worker-a'
          and exists (
            select 1 from bot_installation_bindings b
            where b.bot_client_id = $2 and b.installation_id = r.installation_id
          )
        "#,
    )
    .bind(action_id)
    .bind(client_a)
    .execute(&pool)
    .await
    .expect("right tenant update");
    assert_eq!(right_tenant.rows_affected(), 1);
}
