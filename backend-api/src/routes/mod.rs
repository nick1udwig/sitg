use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect},
    routing::{delete, get, post, put},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{Duration, Utc};
use rand::{Rng, distributions::Alphanumeric};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use time::Duration as CookieDuration;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

use crate::{
    app::AppState,
    error::{ApiError, ApiResult},
    models::{
        api::{
            AuthCallbackQuery, AuthStartQuery, ConfirmRequest, ConfirmResponse,
            ConfirmTypedDataResponse, DeadlineCheckResponse, DeadlineCloseAction, GateResponse,
            InternalChallengePayload, InternalPrEventRequest, InternalPrEventResponse, MeResponse,
            RepoConfigPutRequest, RepoConfigResponse, ResolveLoginsRequest, ResolveLoginsResponse,
            ResolvedLogin, ThresholdResponse, TypedDataDomain, TypedDataMessage,
            WalletLinkChallengeResponse, WalletLinkConfirmRequest, WalletLinkConfirmResponse,
            WhitelistPutRequest,
        },
        db::{ChallengeRow, CurrentUserRow, RepoConfigRow, WalletLinkChallengeRow, WhitelistRow},
    },
};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/auth/github/start", get(auth_github_start))
        .route("/api/v1/auth/github/callback", get(auth_github_callback))
        .route("/api/v1/auth/logout", post(auth_logout))
        .route("/api/v1/me", get(me))
        .route(
            "/api/v1/repos/{repo_id}/config",
            get(get_repo_config).put(put_repo_config),
        )
        .route(
            "/api/v1/repos/{repo_id}/whitelist/resolve-logins",
            post(resolve_logins),
        )
        .route("/api/v1/repos/{repo_id}/whitelist", put(put_whitelist))
        .route(
            "/api/v1/repos/{repo_id}/whitelist/{github_user_id}",
            delete(delete_whitelist_entry),
        )
        .route("/api/v1/gate/{gate_token}", get(get_gate))
        .route(
            "/api/v1/gate/{gate_token}/confirm-typed-data",
            get(get_gate_confirm_typed_data),
        )
        .route("/api/v1/gate/{gate_token}/confirm", post(post_gate_confirm))
        .route("/api/v1/wallet/link/challenge", post(wallet_link_challenge))
        .route("/api/v1/wallet/link/confirm", post(wallet_link_confirm))
        .route("/api/v1/wallet/link", delete(wallet_unlink))
        .route("/internal/v1/pr-events", post(internal_pr_events))
        .route(
            "/internal/v1/challenges/{challenge_id}/deadline-check",
            post(internal_deadline_check),
        )
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
}

async fn healthz() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn auth_github_start(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthStartQuery>,
) -> ApiResult<Redirect> {
    let oauth_state = build_token(32);
    let now = Utc::now();

    sqlx::query(
        "insert into oauth_states (id, state, expires_at, redirect_after, created_at) values ($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(&oauth_state)
    .bind(now + Duration::minutes(10))
    .bind(query.redirect_after)
    .bind(now)
    .execute(&state.pool)
    .await?;

    let url = state
        .github_oauth_service
        .authorize_url(&state.config, &oauth_state)?;
    Ok(Redirect::temporary(&url))
}

async fn auth_github_callback(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthCallbackQuery>,
    jar: CookieJar,
) -> ApiResult<(CookieJar, Redirect)> {
    let redirect_after: Option<String> = sqlx::query_scalar(
        "delete from oauth_states where state = $1 and expires_at > $2 returning redirect_after",
    )
    .bind(&query.state)
    .bind(Utc::now())
    .fetch_optional(&state.pool)
    .await?;

    if redirect_after.is_none() {
        return Err(ApiError::validation("OAuth state is invalid or expired"));
    }

    let access_token = state
        .github_oauth_service
        .exchange_code_for_token(&state.config, &query.code)
        .await?;
    let gh_user = state.github_oauth_service.fetch_user(&access_token).await?;

    let now = Utc::now();
    let user_id = Uuid::new_v4();

    let current_user_id: Uuid = sqlx::query_scalar(
        r#"
        insert into users (id, github_user_id, github_login, created_at, updated_at)
        values ($1, $2, $3, $4, $4)
        on conflict (github_user_id) do update set
          github_login = excluded.github_login,
          updated_at = excluded.updated_at
        returning id
        "#,
    )
    .bind(user_id)
    .bind(gh_user.id)
    .bind(gh_user.login)
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    let session_token = build_token(64);
    sqlx::query(
        "insert into user_sessions (id, user_id, session_token, expires_at, created_at, revoked_at) values ($1, $2, $3, $4, $5, null)",
    )
    .bind(Uuid::new_v4())
    .bind(current_user_id)
    .bind(&session_token)
    .bind(now + Duration::days(30))
    .bind(now)
    .execute(&state.pool)
    .await?;

    let cookie = Cookie::build((state.config.session_cookie_name.clone(), session_token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(state.config.api_base_url.starts_with("https://"))
        .max_age(CookieDuration::days(30))
        .build();

    let redirect_to = sanitize_redirect_url(
        redirect_after,
        &state.config.app_base_url,
        &state.config.app_base_url,
    );

    Ok((jar.add(cookie), Redirect::temporary(&redirect_to)))
}

async fn auth_logout(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<(CookieJar, StatusCode)> {
    if let Some(token) = jar.get(&state.config.session_cookie_name) {
        sqlx::query("update user_sessions set revoked_at = $2 where session_token = $1 and revoked_at is null")
            .bind(token.value())
            .bind(Utc::now())
            .execute(&state.pool)
            .await?;
    }

    let delete_cookie = Cookie::build(state.config.session_cookie_name.clone())
        .path("/")
        .max_age(CookieDuration::seconds(0))
        .build();

    Ok((jar.remove(delete_cookie), StatusCode::NO_CONTENT))
}

async fn me(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<Json<MeResponse>> {
    let user = require_current_user(&state, &jar).await?;
    Ok(Json(MeResponse {
        id: user.id.to_string(),
        github_user_id: user.github_user_id,
        github_login: user.github_login,
    }))
}

async fn get_repo_config(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<i64>,
    jar: CookieJar,
) -> ApiResult<Json<RepoConfigResponse>> {
    let _user = require_current_user(&state, &jar).await?;

    let row: Option<RepoConfigRow> = sqlx::query_as(
        r#"
        select github_repo_id, full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
               spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache
        from repo_configs
        where github_repo_id = $1
        "#,
    )
    .bind(repo_id)
    .fetch_optional(&state.pool)
    .await?;

    let row = row.ok_or(ApiError::NotFound)?;
    Ok(Json(repo_config_row_to_response(&row)))
}

async fn put_repo_config(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<i64>,
    jar: CookieJar,
    Json(payload): Json<RepoConfigPutRequest>,
) -> ApiResult<Json<RepoConfigResponse>> {
    let _user = require_current_user(&state, &jar).await?;

    let input_mode = payload.input_mode.to_uppercase();
    if input_mode != "ETH" && input_mode != "USD" {
        return Err(ApiError::validation("input_mode must be ETH or USD"));
    }

    let input_value = Decimal::from_str_exact(payload.input_value.as_str())
        .map_err(|_| ApiError::validation("input_value must be a numeric string"))?;
    if input_value <= Decimal::ZERO {
        return Err(ApiError::validation("input_value must be > 0"));
    }

    let quote = state.quote_service.live_or_cached_eth_usd_quote().await?;

    let eth_value = if input_mode == "USD" {
        if quote.price <= Decimal::ZERO {
            return Err(ApiError::PriceUnavailable);
        }
        input_value / quote.price
    } else {
        input_value
    };

    let threshold_wei = eth_to_wei(eth_value)?;

    let full_name: Option<String> =
        sqlx::query_scalar("select full_name from repo_configs where github_repo_id = $1")
            .bind(repo_id)
            .fetch_optional(&state.pool)
            .await?;

    let full_name = full_name.unwrap_or_else(|| format!("repo/{repo_id}"));
    let installation_id: Option<i64> =
        sqlx::query_scalar("select installation_id from repo_configs where github_repo_id = $1")
            .bind(repo_id)
            .fetch_optional(&state.pool)
            .await?;
    let installation_id = installation_id.unwrap_or(0);
    if installation_id == 0 {
        sqlx::query(
            r#"
            insert into github_installations (installation_id, account_login, account_type, created_at, updated_at)
            values (0, 'unknown', 'User', $1, $1)
            on conflict (installation_id) do nothing
            "#,
        )
        .bind(Utc::now())
        .execute(&state.pool)
        .await?;
    }

    let now = Utc::now();

    sqlx::query(
        r#"
        insert into repo_configs (
          github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei,
          input_mode, input_value, spot_price_usd, spot_source, spot_at, spot_quote_id,
          spot_from_cache, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        on conflict (github_repo_id) do update
        set draft_prs_gated = excluded.draft_prs_gated,
            threshold_wei = excluded.threshold_wei,
            input_mode = excluded.input_mode,
            input_value = excluded.input_value,
            spot_price_usd = excluded.spot_price_usd,
            spot_source = excluded.spot_source,
            spot_at = excluded.spot_at,
            spot_quote_id = excluded.spot_quote_id,
            spot_from_cache = excluded.spot_from_cache,
            updated_at = excluded.updated_at
        "#,
    )
    .bind(repo_id)
    .bind(installation_id)
    .bind(full_name)
    .bind(payload.draft_prs_gated)
    .bind(threshold_wei)
    .bind(input_mode)
    .bind(input_value)
    .bind(quote.price)
    .bind(quote.source)
    .bind(quote.fetched_at)
    .bind(quote.quote_id)
    .bind(quote.from_cache)
    .bind(now)
    .execute(&state.pool)
    .await?;

    let row: RepoConfigRow = sqlx::query_as(
        r#"
        select github_repo_id, full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
               spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache
        from repo_configs
        where github_repo_id = $1
        "#,
    )
    .bind(repo_id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(repo_config_row_to_response(&row)))
}

async fn resolve_logins(
    State(state): State<Arc<AppState>>,
    Path(_repo_id): Path<i64>,
    jar: CookieJar,
    Json(payload): Json<ResolveLoginsRequest>,
) -> ApiResult<Json<ResolveLoginsResponse>> {
    let _user = require_current_user(&state, &jar).await?;

    if payload.logins.is_empty() {
        return Ok(Json(ResolveLoginsResponse {
            resolved: vec![],
            unresolved: vec![],
        }));
    }

    let rows: Vec<WhitelistRow> =
        sqlx::query_as("select github_user_id, github_login from users where github_login = any($1)")
            .bind(&payload.logins)
            .fetch_all(&state.pool)
            .await?;

    let resolved: Vec<ResolvedLogin> = rows
        .iter()
        .map(|r| ResolvedLogin {
            github_user_id: r.github_user_id,
            github_login: r.github_login.clone(),
        })
        .collect();

    let unresolved = payload
        .logins
        .into_iter()
        .filter(|login| !rows.iter().any(|row| row.github_login.eq_ignore_ascii_case(login)))
        .collect();

    Ok(Json(ResolveLoginsResponse {
        resolved,
        unresolved,
    }))
}

async fn put_whitelist(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<i64>,
    jar: CookieJar,
    Json(payload): Json<WhitelistPutRequest>,
) -> ApiResult<StatusCode> {
    let _user = require_current_user(&state, &jar).await?;

    let mut tx = state.pool.begin().await?;

    for entry in payload.entries {
        sqlx::query(
            r#"
            insert into repo_whitelist (id, github_repo_id, github_user_id, github_login, created_at)
            values ($1, $2, $3, $4, $5)
            on conflict (github_repo_id, github_user_id) do update set github_login = excluded.github_login
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(repo_id)
        .bind(entry.github_user_id)
        .bind(entry.github_login)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_whitelist_entry(
    State(state): State<Arc<AppState>>,
    Path((repo_id, github_user_id)): Path<(i64, i64)>,
    jar: CookieJar,
) -> ApiResult<StatusCode> {
    let _user = require_current_user(&state, &jar).await?;

    sqlx::query("delete from repo_whitelist where github_repo_id = $1 and github_user_id = $2")
        .bind(repo_id)
        .bind(github_user_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn get_gate(
    State(state): State<Arc<AppState>>,
    Path(gate_token): Path<String>,
) -> ApiResult<Json<GateResponse>> {
    let row: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation, deadline_at, status
        from pr_challenges
        where gate_token = $1
        "#,
    )
    .bind(gate_token)
    .fetch_optional(&state.pool)
    .await?;

    let row = row.ok_or(ApiError::NotFound)?;

    Ok(Json(GateResponse {
        challenge_id: row.id,
        status: row.status,
        github_repo_id: row.github_repo_id,
        github_repo_full_name: row.github_repo_full_name,
        github_pr_number: row.github_pr_number,
        github_pr_author_id: row.github_pr_author_id,
        github_pr_author_login: row.github_pr_author_login,
        head_sha: row.head_sha,
        deadline_at: row.deadline_at,
        threshold_wei_snapshot: row.threshold_wei_snapshot.normalize().to_string(),
    }))
}

async fn get_gate_confirm_typed_data(
    State(state): State<Arc<AppState>>,
    Path(gate_token): Path<String>,
) -> ApiResult<Json<ConfirmTypedDataResponse>> {
    let challenge: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation, deadline_at, status
        from pr_challenges
        where gate_token = $1
        "#,
    )
    .bind(gate_token)
    .fetch_optional(&state.pool)
    .await?;

    let challenge = challenge.ok_or(ApiError::NotFound)?;

    let nonce: Option<Uuid> = sqlx::query_scalar("select nonce from challenge_nonces where challenge_id = $1")
        .bind(challenge.id)
        .fetch_optional(&state.pool)
        .await?;

    let nonce = nonce.ok_or(ApiError::NotFound)?;

    Ok(Json(ConfirmTypedDataResponse {
        domain: TypedDataDomain {
            name: "StakeToContribute".to_string(),
            version: "1".to_string(),
            chain_id: 8453,
            verifying_contract: "0x0000000000000000000000000000000000000000".to_string(),
        },
        primary_type: "PRGateConfirmation".to_string(),
        message: TypedDataMessage {
            github_user_id: challenge.github_pr_author_id,
            github_repo_id: challenge.github_repo_id,
            pull_request_number: challenge.github_pr_number,
            head_sha: challenge.head_sha,
            challenge_id: challenge.id.to_string(),
            nonce: nonce.to_string(),
            expires_at: challenge.deadline_at.timestamp(),
        },
    }))
}

async fn post_gate_confirm(
    State(state): State<Arc<AppState>>,
    Path(gate_token): Path<String>,
    Json(payload): Json<ConfirmRequest>,
) -> ApiResult<Json<ConfirmResponse>> {
    if payload.signature.trim().is_empty() {
        return Err(ApiError::validation("signature is required"));
    }

    let challenge: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation, deadline_at, status
        from pr_challenges
        where gate_token = $1
        "#,
    )
    .bind(gate_token)
    .fetch_optional(&state.pool)
    .await?;

    let challenge = challenge.ok_or(ApiError::NotFound)?;

    if challenge.status == "VERIFIED" {
        return Ok(Json(ConfirmResponse {
            status: "VERIFIED".to_string(),
        }));
    }

    if challenge.status != "PENDING" {
        return Err(ApiError::Conflict("CHALLENGE_NOT_PENDING"));
    }

    if Utc::now() > challenge.deadline_at {
        return Err(ApiError::Conflict("CHALLENGE_EXPIRED"));
    }

    let typed_data = json!({
        "challenge_id": challenge.id,
        "gate_token": challenge.gate_token,
        "head_sha": challenge.head_sha,
    });

    let mut tx = state.pool.begin().await?;

    let nonce_update = sqlx::query(
        "update challenge_nonces set used_at = $2 where challenge_id = $1 and used_at is null and expires_at > $2",
    )
    .bind(challenge.id)
    .bind(Utc::now())
    .execute(&mut *tx)
    .await?;

    if nonce_update.rows_affected() == 0 {
        return Err(ApiError::Conflict("NONCE_INVALID"));
    }

    sqlx::query(
        r#"
        insert into pr_confirmations (id, challenge_id, signature, signer_address, typed_data, created_at)
        values ($1, $2, $3, $4, $5, $6)
        on conflict (challenge_id) do update set signature = excluded.signature
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(challenge.id)
    .bind(payload.signature)
    .bind("0x0000000000000000000000000000000000000000")
    .bind(Value::from(typed_data))
    .bind(Utc::now())
    .execute(&mut *tx)
    .await?;

    sqlx::query("update pr_challenges set status = 'VERIFIED', updated_at = $2 where id = $1")
        .bind(challenge.id)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(Json(ConfirmResponse {
        status: "VERIFIED".to_string(),
    }))
}

async fn wallet_link_challenge(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<Json<WalletLinkChallengeResponse>> {
    let user = require_current_user(&state, &jar).await?;
    let now = Utc::now();
    let nonce = Uuid::new_v4();
    let expires_at = now + Duration::minutes(10);

    sqlx::query(
        "insert into wallet_link_challenges (id, user_id, nonce, expires_at, used_at, created_at) values ($1, $2, $3, $4, null, $5)",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(nonce)
    .bind(expires_at)
    .bind(now)
    .execute(&state.pool)
    .await?;

    Ok(Json(WalletLinkChallengeResponse {
        nonce: nonce.to_string(),
        expires_at,
        message: format!(
            "Link wallet for github_user_id={} nonce={} expires_at={}.",
            user.github_user_id,
            nonce,
            expires_at.to_rfc3339()
        ),
    }))
}

async fn wallet_link_confirm(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(payload): Json<WalletLinkConfirmRequest>,
) -> ApiResult<Json<WalletLinkConfirmResponse>> {
    let user = require_current_user(&state, &jar).await?;
    if payload.signature.trim().is_empty() {
        return Err(ApiError::validation("signature is required"));
    }

    let nonce = Uuid::parse_str(&payload.nonce)
        .map_err(|_| ApiError::validation("nonce must be a valid UUID"))?;
    let wallet_address = normalize_wallet_address(&payload.wallet_address)?;

    let challenge: Option<WalletLinkChallengeRow> = sqlx::query_as(
        "select nonce, expires_at from wallet_link_challenges where user_id = $1 and nonce = $2 and used_at is null and expires_at > $3",
    )
    .bind(user.id)
    .bind(nonce)
    .bind(Utc::now())
    .fetch_optional(&state.pool)
    .await?;

    if challenge.is_none() {
        return Err(ApiError::Conflict("WALLET_LINK_CHALLENGE_INVALID"));
    }

    let mut tx = state.pool.begin().await?;

    sqlx::query(
        "update wallet_link_challenges set used_at = $3 where user_id = $1 and nonce = $2 and used_at is null",
    )
    .bind(user.id)
    .bind(nonce)
    .bind(Utc::now())
    .execute(&mut *tx)
    .await?;

    sqlx::query("update wallet_links set unlinked_at = $2 where user_id = $1 and unlinked_at is null")
        .bind(user.id)
        .bind(Utc::now())
        .execute(&mut *tx)
        .await?;

    let insert_result = sqlx::query(
        "insert into wallet_links (id, user_id, wallet_address, chain_id, linked_at, unlinked_at) values ($1, $2, $3, 8453, $4, null)",
    )
    .bind(Uuid::new_v4())
    .bind(user.id)
    .bind(&wallet_address)
    .bind(Utc::now())
    .execute(&mut *tx)
    .await;

    if let Err(err) = insert_result {
        if is_wallet_uniqueness_violation(&err) {
            return Err(ApiError::Conflict("WALLET_ALREADY_LINKED"));
        }
        return Err(ApiError::Db(err));
    }

    tx.commit().await?;

    Ok(Json(WalletLinkConfirmResponse {
        wallet_address,
        linked: true,
    }))
}

async fn wallet_unlink(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<StatusCode> {
    let user = require_current_user(&state, &jar).await?;

    let current_wallet: Option<String> =
        sqlx::query_scalar("select wallet_address from wallet_links where user_id = $1 and unlinked_at is null")
            .bind(user.id)
            .fetch_optional(&state.pool)
            .await?;

    let Some(wallet_address) = current_wallet else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let staked = state.stake_service.staked_balance_wei(&wallet_address).await;
    if staked > Decimal::ZERO {
        return Err(ApiError::Conflict("WALLET_HAS_STAKE"));
    }

    sqlx::query("update wallet_links set unlinked_at = $2 where user_id = $1 and unlinked_at is null")
        .bind(user.id)
        .bind(Utc::now())
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn internal_pr_events(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<InternalPrEventRequest>,
) -> ApiResult<Json<InternalPrEventResponse>> {
    tracing::info!(
        delivery_id = %payload.delivery_id,
        installation_id = payload.installation_id,
        action = %payload.action,
        pr_id = payload.pull_request.id,
        pr_url = %payload.pull_request.html_url,
        "received internal PR event"
    );

    let config: Option<RepoConfigRow> = sqlx::query_as(
        r#"
        select github_repo_id, full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
               spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache
        from repo_configs
        where github_repo_id = $1
        "#,
    )
    .bind(payload.repository.id)
    .fetch_optional(&state.pool)
    .await?;

    let config = match config {
        Some(c) => c,
        None => {
            return Ok(Json(InternalPrEventResponse {
                decision: "IGNORE".to_string(),
                challenge: None,
            }));
        }
    };

    if payload.pull_request.is_draft && !config.draft_prs_gated {
        return Ok(Json(InternalPrEventResponse {
            decision: "IGNORE".to_string(),
            challenge: None,
        }));
    }

    let is_whitelisted: Option<i64> = sqlx::query_scalar(
        "select github_user_id from repo_whitelist where github_repo_id = $1 and github_user_id = $2",
    )
    .bind(payload.repository.id)
    .bind(payload.pull_request.user.id)
    .fetch_optional(&state.pool)
    .await?;

    if is_whitelisted.is_some() {
        return Ok(Json(InternalPrEventResponse {
            decision: "EXEMPT".to_string(),
            challenge: None,
        }));
    }

    let existing: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation, deadline_at, status
        from pr_challenges
        where github_repo_id = $1 and github_pr_number = $2
          and status in ('PENDING', 'VERIFIED', 'EXEMPT')
        limit 1
        "#,
    )
    .bind(payload.repository.id)
    .bind(payload.pull_request.number)
    .fetch_optional(&state.pool)
    .await?;

    let challenge = if let Some(existing) = existing {
        if existing.status == "VERIFIED" {
            return Ok(Json(InternalPrEventResponse {
                decision: "ALREADY_VERIFIED".to_string(),
                challenge: None,
            }));
        }
        existing
    } else {
        let challenge_id = Uuid::new_v4();
        let gate_token = build_token(24);
        let deadline_at = payload.event_time + Duration::minutes(30);
        let now = Utc::now();

        sqlx::query(
            r#"
            insert into pr_challenges (
              id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
              github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
              draft_at_creation, deadline_at, status, verified_wallet_address, created_at, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', null, $12, $12)
            "#,
        )
        .bind(challenge_id)
        .bind(&gate_token)
        .bind(payload.repository.id)
        .bind(payload.repository.full_name.clone())
        .bind(payload.pull_request.number)
        .bind(payload.pull_request.user.id)
        .bind(payload.pull_request.user.login.clone())
        .bind(payload.pull_request.head_sha.clone())
        .bind(config.threshold_wei)
        .bind(payload.pull_request.is_draft)
        .bind(deadline_at)
        .bind(now)
        .execute(&state.pool)
        .await?;

        let nonce = Uuid::new_v4();
        sqlx::query(
            "insert into challenge_nonces (nonce, challenge_id, expires_at, used_at, created_at) values ($1, $2, $3, null, $4)",
        )
        .bind(nonce)
        .bind(challenge_id)
        .bind(deadline_at)
        .bind(now)
        .execute(&state.pool)
        .await?;

        ChallengeRow {
            id: challenge_id,
            gate_token,
            github_repo_id: payload.repository.id,
            github_repo_full_name: payload.repository.full_name,
            github_pr_number: payload.pull_request.number,
            github_pr_author_id: payload.pull_request.user.id,
            github_pr_author_login: payload.pull_request.user.login,
            head_sha: payload.pull_request.head_sha,
            threshold_wei_snapshot: config.threshold_wei,
            draft_at_creation: payload.pull_request.is_draft,
            deadline_at,
            status: "PENDING".to_string(),
        }
    };

    let gate_url = format!("{}/g/{}", state.config.app_base_url, challenge.gate_token);

    let challenge_payload = InternalChallengePayload {
        id: challenge.id,
        gate_url: gate_url.clone(),
        deadline_at: challenge.deadline_at,
        comment_markdown: format!(
            "This repository requires stake verification to keep this PR open.\n\nPlease verify within **30 minutes**:\n{}\n\nIf verification is not completed in time, this PR will be automatically closed.",
            gate_url
        ),
    };

    Ok(Json(InternalPrEventResponse {
        decision: "REQUIRE_STAKE".to_string(),
        challenge: Some(challenge_payload),
    }))
}

async fn internal_deadline_check(
    State(state): State<Arc<AppState>>,
    Path(challenge_id): Path<Uuid>,
) -> ApiResult<Json<DeadlineCheckResponse>> {
    let challenge: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation, deadline_at, status
        from pr_challenges
        where id = $1
        "#,
    )
    .bind(challenge_id)
    .fetch_optional(&state.pool)
    .await?;

    let challenge = challenge.ok_or(ApiError::NotFound)?;

    if challenge.status == "VERIFIED" || challenge.status == "EXEMPT" {
        return Ok(Json(DeadlineCheckResponse {
            action: "NOOP".to_string(),
            close: None,
        }));
    }

    let is_whitelisted: Option<i64> = sqlx::query_scalar(
        "select github_user_id from repo_whitelist where github_repo_id = $1 and github_user_id = $2",
    )
    .bind(challenge.github_repo_id)
    .bind(challenge.github_pr_author_id)
    .fetch_optional(&state.pool)
    .await?;

    if is_whitelisted.is_some() {
        sqlx::query("update pr_challenges set status = 'EXEMPT', updated_at = $2 where id = $1")
            .bind(challenge.id)
            .bind(Utc::now())
            .execute(&state.pool)
            .await?;

        return Ok(Json(DeadlineCheckResponse {
            action: "NOOP".to_string(),
            close: None,
        }));
    }

    if challenge.status == "PENDING" {
        sqlx::query("update pr_challenges set status = 'TIMED_OUT_CLOSED', updated_at = $2 where id = $1")
            .bind(challenge.id)
            .bind(Utc::now())
            .execute(&state.pool)
            .await?;

        let close = DeadlineCloseAction {
            github_repo_id: challenge.github_repo_id,
            github_pr_number: challenge.github_pr_number,
            comment_markdown:
                "Stake verification was not completed within 30 minutes, so this PR has been closed."
                    .to_string(),
        };

        return Ok(Json(DeadlineCheckResponse {
            action: "CLOSE_PR".to_string(),
            close: Some(close),
        }));
    }

    Ok(Json(DeadlineCheckResponse {
        action: "NOOP".to_string(),
        close: None,
    }))
}

async fn require_current_user(state: &AppState, jar: &CookieJar) -> ApiResult<CurrentUserRow> {
    let session_cookie = jar
        .get(&state.config.session_cookie_name)
        .ok_or(ApiError::Unauthenticated)?;

    let row: Option<CurrentUserRow> = sqlx::query_as(
        r#"
        select u.id, u.github_user_id, u.github_login
        from user_sessions s
        join users u on u.id = s.user_id
        where s.session_token = $1 and s.revoked_at is null and s.expires_at > $2
        "#,
    )
    .bind(session_cookie.value())
    .bind(Utc::now())
    .fetch_optional(&state.pool)
    .await?;

    row.ok_or(ApiError::Unauthenticated)
}

fn sanitize_redirect_url(
    candidate: Option<String>,
    allowed_prefix: &str,
    fallback: &str,
) -> String {
    match candidate {
        Some(url) if url.starts_with(allowed_prefix) => url,
        _ => fallback.to_string(),
    }
}

fn normalize_wallet_address(address: &str) -> ApiResult<String> {
    let lowered = address.trim().to_lowercase();
    let valid = lowered.len() == 42
        && lowered.starts_with("0x")
        && lowered.chars().skip(2).all(|c| c.is_ascii_hexdigit());
    if valid {
        Ok(lowered)
    } else {
        Err(ApiError::validation(
            "wallet_address must be a 20-byte 0x-prefixed hex string",
        ))
    }
}

fn is_wallet_uniqueness_violation(err: &sqlx::Error) -> bool {
    match err {
        sqlx::Error::Database(db_err) => db_err
            .constraint()
            .map(|name| name == "wallet_links_one_active_user_per_wallet")
            .unwrap_or(false),
        _ => false,
    }
}

fn repo_config_row_to_response(row: &RepoConfigRow) -> RepoConfigResponse {
    let wei = row.threshold_wei.normalize().to_string();
    let eth = wei_to_eth_str(&row.threshold_wei);
    let usd_estimate = (Decimal::from_str_exact(&eth).unwrap_or(Decimal::ZERO) * row.spot_price_usd)
        .round_dp(2)
        .normalize()
        .to_string();

    RepoConfigResponse {
        github_repo_id: row.github_repo_id,
        threshold: ThresholdResponse {
            wei,
            eth,
            usd_estimate,
            input_mode: row.input_mode.clone(),
            input_value: row.input_value.normalize().to_string(),
            spot_price_usd: row.spot_price_usd.normalize().to_string(),
            spot_source: row.spot_source.clone(),
            spot_at: row.spot_at,
            spot_from_cache: row.spot_from_cache,
            spot_quote_id: row.spot_quote_id,
            message: "Enforced in ETH. USD is an estimate.".to_string(),
        },
        draft_prs_gated: row.draft_prs_gated,
    }
}

fn eth_to_wei(eth: Decimal) -> ApiResult<Decimal> {
    let scale = Decimal::from_i128_with_scale(1_000_000_000_000_000_000i128, 0);
    Ok((eth * scale).round_dp(0))
}

fn wei_to_eth_str(wei: &Decimal) -> String {
    let scale = Decimal::from_i128_with_scale(1_000_000_000_000_000_000i128, 0);
    (wei / scale).normalize().to_string()
}

fn build_token(size: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(size)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::db::RepoConfigRow;
    use chrono::TimeZone;

    #[test]
    fn converts_eth_to_wei() {
        let wei = eth_to_wei(Decimal::from_str_exact("0.1").expect("valid decimal"))
            .expect("conversion should succeed");
        assert_eq!(wei.to_string(), "100000000000000000");
    }

    #[test]
    fn converts_wei_to_eth_string() {
        let wei = Decimal::from_str_exact("1500000000000000000").expect("valid decimal");
        assert_eq!(wei_to_eth_str(&wei), "1.5");
    }

    #[test]
    fn maps_repo_config_response() {
        let row = RepoConfigRow {
            github_repo_id: 42,
            full_name: "org/repo".to_string(),
            draft_prs_gated: true,
            threshold_wei: Decimal::from_str_exact("100000000000000000").expect("valid decimal"),
            input_mode: "ETH".to_string(),
            input_value: Decimal::from_str_exact("0.10").expect("valid decimal"),
            spot_price_usd: Decimal::from_str_exact("2600.12").expect("valid decimal"),
            spot_source: "coingecko".to_string(),
            spot_at: Utc.with_ymd_and_hms(2026, 2, 13, 0, 0, 0).unwrap(),
            spot_quote_id: Some(Uuid::nil()),
            spot_from_cache: false,
        };

        let response = repo_config_row_to_response(&row);
        assert_eq!(response.github_repo_id, 42);
        assert_eq!(response.threshold.wei, "100000000000000000");
        assert_eq!(response.threshold.eth, "0.1");
        assert_eq!(response.threshold.input_mode, "ETH");
        assert_eq!(response.threshold.usd_estimate, "260.01");
    }

    #[test]
    fn normalizes_wallet_address() {
        let normalized = normalize_wallet_address("0xAbCd00000000000000000000000000000000Ef12")
            .expect("address should parse");
        assert_eq!(normalized, "0xabcd00000000000000000000000000000000ef12");
    }

    #[test]
    fn rejects_invalid_wallet_address() {
        let err = normalize_wallet_address("0x123").expect_err("should reject invalid");
        assert!(matches!(err, ApiError::Validation(_)));
    }

    #[test]
    fn generates_token_with_expected_length() {
        let token = build_token(24);
        assert_eq!(token.len(), 24);
    }

    #[test]
    fn validates_redirect_prefix() {
        let redirect = sanitize_redirect_url(
            Some("https://app.example.com/g/abc".to_string()),
            "https://app.example.com",
            "https://app.example.com",
        );
        assert_eq!(redirect, "https://app.example.com/g/abc");

        let fallback = sanitize_redirect_url(
            Some("https://evil.example.com".to_string()),
            "https://app.example.com",
            "https://app.example.com",
        );
        assert_eq!(fallback, "https://app.example.com");
    }
}
