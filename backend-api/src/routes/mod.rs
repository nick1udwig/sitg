use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
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
    config::STAKING_CHAIN_ID,
    error::{ApiError, ApiResult},
    models::{
        api::{
            AuthCallbackQuery, AuthStartQuery, BotActionClaimRequest, BotActionClaimResponse,
            BotActionItem, BotActionResultRequest, BotActionResultResponse, ConfirmRequest,
            ConfirmResponse, ConfirmTypedDataResponse, GateResponse,
            InternalInstallationSyncRequest, InternalInstallationSyncResponse,
            InternalPrEventRequest, InternalPrEventResponse, MeResponse, RepoConfigPutRequest,
            RepoConfigResponse, RepoGithubAppStatusResponse, RepoOptionResponse,
            ResolveLoginsRequest, ResolveLoginsResponse, ResolvedLogin, StakeStatusQuery,
            StakeStatusResponse, StakingConfigResponse, ThresholdResponse,
            TypedDataDomain, TypedDataMessage, WalletLinkChallengeResponse,
            WalletLinkConfirmRequest, WalletLinkConfirmResponse, WalletLinkStatusResponse,
            WhitelistPutRequest,
        },
        db::{
            BotActionResultStateRow, BotActionRow, ChallengeRow, CurrentUserRow, RepoConfigRow,
            WalletLinkChallengeRow,
        },
    },
    services::internal_auth::verify_internal_request as verify_internal_with_key_id,
    services::signature_service::{
        recover_eip712_pr_confirmation_address, recover_personal_sign_address, uuid_to_bytes32_hex,
        uuid_to_uint256_decimal,
    },
};

const BOT_ACTION_CLAIM_LEASE_SECONDS: i64 = 5 * 60;
const BOT_ACTION_MAX_ATTEMPTS: i32 = 8;
const BOT_ACTION_RETRY_BASE_SECONDS: i64 = 5;
const BOT_ACTION_RETRY_MAX_SECONDS: i64 = 15 * 60;

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/auth/github/start", get(auth_github_start))
        .route("/api/v1/auth/github/callback", get(auth_github_callback))
        .route("/api/v1/auth/logout", post(auth_logout))
        .route("/api/v1/me", get(me))
        .route("/api/v1/repos", get(list_owned_repos))
        .route(
            "/api/v1/repos/{repo_id}/github-app-status",
            get(get_repo_github_app_status),
        )
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
        .route("/api/v1/wallet/link", get(wallet_link_status).delete(wallet_unlink))
        .route("/api/v1/staking/config", get(get_staking_config))
        .route("/api/v1/stake/status", get(get_stake_status))
        .route(
            "/internal/v2/github/events/pull-request",
            post(internal_v2_pr_events),
        )
        .route(
            "/internal/v2/github/events/installation-sync",
            post(internal_v2_installation_sync),
        )
        .route(
            "/internal/v2/bot-actions/claim",
            post(internal_v2_bot_actions_claim),
        )
        .route(
            "/internal/v2/bot-actions/{action_id}/result",
            post(internal_v2_bot_action_result),
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
    state.rate_limiter.check("auth:start:global", 100, 60)?;
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
    state.rate_limiter.check("auth:callback:global", 100, 60)?;
    let redirect_after: Option<String> = if let Some(oauth_state) = query.state.as_deref() {
        sqlx::query_scalar(
            "delete from oauth_states where state = $1 and expires_at > $2 returning redirect_after",
        )
        .bind(oauth_state)
        .bind(Utc::now())
        .fetch_optional(&state.pool)
        .await?
    } else {
        None
    };

    if let Some(error_code) = query.error.as_deref() {
        let reason = if error_code == "access_denied" {
            "access_denied"
        } else {
            "oauth_error"
        };
        let redirect_to = append_auth_query(
            sanitize_redirect_url(
                redirect_after,
                &state.config.app_base_url,
                &state.config.app_base_url,
            ),
            "cancelled",
            reason,
        );
        return Ok((jar, Redirect::temporary(&redirect_to)));
    }

    if query.state.is_none() && (query.installation_id.is_some() || query.setup_action.is_some()) {
        let setup_action = query.setup_action.as_deref().unwrap_or("install");
        let redirect_to = append_install_query(
            format!("{}/owner", state.config.app_base_url.trim_end_matches('/')),
            setup_action,
            query.installation_id,
        );
        return Ok((jar, Redirect::temporary(&redirect_to)));
    }

    if redirect_after.is_none() {
        return Err(ApiError::validation("OAuth state is invalid or expired"));
    }

    let code = query
        .code
        .as_deref()
        .ok_or_else(|| ApiError::validation("GitHub OAuth code is missing"))?;

    let access_token = state
        .github_oauth_service
        .exchange_code_for_token(&state.config, code)
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
    .bind(gh_user.login.clone())
    .bind(now)
    .fetch_one(&state.pool)
    .await?;

    sqlx::query("update user_sessions set revoked_at = $2, github_access_token = null where user_id = $1 and revoked_at is null")
        .bind(current_user_id)
        .bind(now)
        .execute(&state.pool)
        .await?;

    let session_token = build_token(64);
    sqlx::query(
        "insert into user_sessions (id, user_id, session_token, github_access_token, expires_at, created_at, revoked_at) values ($1, $2, $3, $4, $5, $6, null)",
    )
    .bind(Uuid::new_v4())
    .bind(current_user_id)
    .bind(&session_token)
    .bind(&access_token)
    .bind(now + Duration::days(30))
    .bind(now)
    .execute(&state.pool)
    .await?;

    insert_audit(
        &state,
        "USER_LOGGED_IN",
        "user",
        current_user_id.to_string(),
        json!({"github_user_id": gh_user.id, "github_login": gh_user.login}),
    )
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
        sqlx::query("update user_sessions set revoked_at = $2, github_access_token = null where session_token = $1 and revoked_at is null")
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

async fn me(State(state): State<Arc<AppState>>, jar: CookieJar) -> ApiResult<Json<MeResponse>> {
    let user = require_current_user(&state, &jar).await?;
    state
        .rate_limiter
        .check(&format!("wallet:challenge:{}", user.id), 20, 60)?;
    Ok(Json(MeResponse {
        id: user.id.to_string(),
        github_user_id: user.github_user_id,
        github_login: user.github_login,
    }))
}

async fn list_owned_repos(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<Json<Vec<RepoOptionResponse>>> {
    let user = require_current_user(&state, &jar).await?;
    let token = user
        .github_access_token
        .as_deref()
        .ok_or(ApiError::Unauthenticated)?;

    let repos = state
        .github_oauth_service
        .list_writable_repos(token)
        .await?;
    Ok(Json(
        repos
            .into_iter()
            .map(|repo| RepoOptionResponse {
                id: repo.id,
                full_name: repo.full_name,
            })
            .collect(),
    ))
}

async fn get_repo_github_app_status(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<i64>,
    jar: CookieJar,
) -> ApiResult<Json<RepoGithubAppStatusResponse>> {
    let user = require_current_user(&state, &jar).await?;
    let token = user
        .github_access_token
        .as_deref()
        .ok_or(ApiError::Unauthenticated)?;

    let repo = state
        .github_oauth_service
        .lookup_repo_by_id(token, repo_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if !repo.can_write {
        return Err(ApiError::Forbidden);
    }

    let row: Option<(i64, String, String, bool)> = sqlx::query_as(
        r#"
        select i.installation_id, i.account_login, i.account_type, gir.active
        from github_installation_repositories gir
        join github_installations i on i.installation_id = gir.installation_id
        where gir.github_repo_id = $1
          and i.active = true
        order by gir.active desc, gir.updated_at desc
        limit 1
        "#,
    )
    .bind(repo_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((installation_id, account_login, account_type, repo_connected)) = row {
        return Ok(Json(RepoGithubAppStatusResponse {
            installed: true,
            installation_id: Some(installation_id),
            installation_account_login: Some(account_login),
            installation_account_type: Some(account_type),
            repo_connected,
        }));
    }

    Ok(Json(RepoGithubAppStatusResponse {
        installed: false,
        installation_id: None,
        installation_account_login: None,
        installation_account_type: None,
        repo_connected: false,
    }))
}

async fn get_repo_config(
    State(state): State<Arc<AppState>>,
    Path(repo_id): Path<i64>,
    jar: CookieJar,
) -> ApiResult<Json<RepoConfigResponse>> {
    require_repo_owner(&state, &jar, repo_id).await?;

    let row: Option<RepoConfigRow> = sqlx::query_as(
        r#"
        select github_repo_id, full_name as _full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
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
    let user = require_current_user(&state, &jar).await?;
    let token = user
        .github_access_token
        .as_deref()
        .ok_or(ApiError::Unauthenticated)?;

    let input_mode = payload.input_mode.to_uppercase();
    if input_mode != "ETH" && input_mode != "USD" {
        return Err(ApiError::validation("input_mode must be ETH or USD"));
    }

    let input_value = Decimal::from_str_exact(payload.input_value.as_str())
        .map_err(|_| ApiError::validation("input_value must be a numeric string"))?;
    if input_value <= Decimal::ZERO {
        return Err(ApiError::validation("input_value must be > 0"));
    }

    let existing: Option<String> =
        sqlx::query_scalar("select full_name from repo_configs where github_repo_id = $1")
            .bind(repo_id)
            .fetch_optional(&state.pool)
            .await?;

    let (full_name, created) = if let Some(full_name) = existing {
        let has_access = state
            .github_oauth_service
            .has_repo_write_access(token, &full_name, &user.github_login)
            .await?;
        if !has_access {
            return Err(ApiError::Forbidden);
        }
        (full_name, false)
    } else {
        let repo = state
            .github_oauth_service
            .lookup_repo_by_id(token, repo_id)
            .await?
            .ok_or(ApiError::NotFound)?;
        if !repo.can_write {
            return Err(ApiError::Forbidden);
        }

        (repo.full_name, true)
    };

    let installation_id = require_active_repo_installation(&state, repo_id).await?;
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

    let now = Utc::now();

    sqlx::query(
        r#"
        insert into repo_configs (
            github_repo_id, installation_id, full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
            spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        on conflict (github_repo_id) do update
        set installation_id = excluded.installation_id,
            full_name = excluded.full_name,
            draft_prs_gated = excluded.draft_prs_gated,
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
    .bind(&full_name)
    .bind(payload.draft_prs_gated)
    .bind(threshold_wei)
    .bind(&input_mode)
    .bind(input_value)
    .bind(quote.price)
    .bind(&quote.source)
    .bind(quote.fetched_at)
    .bind(quote.quote_id)
    .bind(quote.from_cache)
    .bind(now)
    .execute(&state.pool)
    .await?;

    insert_audit(
        &state,
        if created {
            "REPO_CONFIG_CREATED"
        } else {
            "REPO_CONFIG_UPDATED"
        },
        "repo",
        repo_id.to_string(),
        json!({
          "actor_user_id": user.id,
          "full_name": full_name,
          "installation_id": installation_id,
          "input_mode": payload.input_mode,
          "input_value": payload.input_value,
          "draft_prs_gated": payload.draft_prs_gated,
          "spot_quote_id": quote.quote_id,
        }),
    )
    .await?;

    let row: RepoConfigRow = sqlx::query_as(
        r#"
        select github_repo_id, full_name as _full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
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
    Path(repo_id): Path<i64>,
    jar: CookieJar,
    Json(payload): Json<ResolveLoginsRequest>,
) -> ApiResult<Json<ResolveLoginsResponse>> {
    require_repo_owner(&state, &jar, repo_id).await?;
    require_active_repo_installation(&state, repo_id).await?;

    if payload.logins.is_empty() {
        return Ok(Json(ResolveLoginsResponse {
            resolved: vec![],
            unresolved: vec![],
        }));
    }

    let mut resolved = Vec::new();
    let mut unresolved = Vec::new();

    for login in payload.logins {
        match state.github_oauth_service.resolve_login(&login).await? {
            Some(user) => resolved.push(ResolvedLogin {
                github_user_id: user.id,
                github_login: user.login,
            }),
            None => unresolved.push(login),
        }
    }

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
    let user = require_repo_owner(&state, &jar, repo_id).await?;
    require_active_repo_installation(&state, repo_id).await?;
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
    insert_audit(
        &state,
        "WHITELIST_UPDATED",
        "repo",
        repo_id.to_string(),
        json!({"actor_user_id": user.id}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_whitelist_entry(
    State(state): State<Arc<AppState>>,
    Path((repo_id, github_user_id)): Path<(i64, i64)>,
    jar: CookieJar,
) -> ApiResult<StatusCode> {
    let user = require_repo_owner(&state, &jar, repo_id).await?;
    require_active_repo_installation(&state, repo_id).await?;

    sqlx::query("delete from repo_whitelist where github_repo_id = $1 and github_user_id = $2")
        .bind(repo_id)
        .bind(github_user_id)
        .execute(&state.pool)
        .await?;

    insert_audit(
        &state,
        "WHITELIST_ENTRY_DELETED",
        "repo",
        repo_id.to_string(),
        json!({"actor_user_id": user.id, "github_user_id": github_user_id}),
    )
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
               draft_at_creation as _draft_at_creation, deadline_at, status
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
    jar: CookieJar,
) -> ApiResult<Json<ConfirmTypedDataResponse>> {
    let user = require_current_user(&state, &jar).await?;
    state
        .rate_limiter
        .check(&format!("wallet:confirm:{}", user.id), 30, 60)?;

    let challenge: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation as _draft_at_creation, deadline_at, status
        from pr_challenges
        where gate_token = $1
        "#,
    )
    .bind(gate_token)
    .fetch_optional(&state.pool)
    .await?;

    let challenge = challenge.ok_or(ApiError::NotFound)?;
    if user.github_user_id != challenge.github_pr_author_id {
        return Err(ApiError::Forbidden);
    }
    if challenge.status != "PENDING" {
        return Err(ApiError::Conflict("CHALLENGE_NOT_PENDING"));
    }
    if Utc::now() > challenge.deadline_at {
        return Err(ApiError::Conflict("CHALLENGE_EXPIRED"));
    }

    let nonce_row: Option<WalletLinkChallengeRow> = sqlx::query_as(
        "select nonce, expires_at from challenge_nonces where challenge_id = $1 and used_at is null",
    )
    .bind(challenge.id)
    .fetch_optional(&state.pool)
    .await?;

    let nonce_row = nonce_row.ok_or(ApiError::NotFound)?;
    if Utc::now() > nonce_row.expires_at {
        return Err(ApiError::Conflict("NONCE_INVALID"));
    }

    Ok(Json(ConfirmTypedDataResponse {
        domain: TypedDataDomain {
            name: "SITG".to_string(),
            version: "1".to_string(),
            chain_id: STAKING_CHAIN_ID,
            verifying_contract: state.config.staking_contract_address.clone(),
        },
        primary_type: "PRGateConfirmation".to_string(),
        message: TypedDataMessage {
            github_user_id: challenge.github_pr_author_id,
            github_repo_id: challenge.github_repo_id,
            pull_request_number: challenge.github_pr_number,
            head_sha: challenge.head_sha,
            challenge_id: uuid_to_bytes32_hex(challenge.id),
            nonce: uuid_to_uint256_decimal(nonce_row.nonce),
            expires_at: nonce_row.expires_at.timestamp(),
        },
    }))
}

async fn post_gate_confirm(
    State(state): State<Arc<AppState>>,
    Path(gate_token): Path<String>,
    jar: CookieJar,
    Json(payload): Json<ConfirmRequest>,
) -> ApiResult<Json<ConfirmResponse>> {
    let user = require_current_user(&state, &jar).await?;

    if payload.signature.trim().is_empty() {
        return Err(ApiError::validation("signature is required"));
    }

    let challenge: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation as _draft_at_creation, deadline_at, status
        from pr_challenges
        where gate_token = $1
        "#,
    )
    .bind(gate_token)
    .fetch_optional(&state.pool)
    .await?;

    let challenge = challenge.ok_or(ApiError::NotFound)?;
    if user.github_user_id != challenge.github_pr_author_id {
        return Err(ApiError::Forbidden);
    }

    if challenge.status == "VERIFIED" {
        return Ok(Json(ConfirmResponse {
            status: "VERIFIED".to_string(),
        }));
    }

    if challenge.status != "PENDING" {
        return Err(ApiError::Conflict("CHALLENGE_NOT_PENDING"));
    }

    let nonce_row: Option<WalletLinkChallengeRow> = sqlx::query_as(
        "select nonce, expires_at from challenge_nonces where challenge_id = $1 and used_at is null",
    )
    .bind(challenge.id)
    .fetch_optional(&state.pool)
    .await?;
    let nonce_row = nonce_row.ok_or(ApiError::Conflict("NONCE_INVALID"))?;

    if Utc::now() > nonce_row.expires_at || Utc::now() > challenge.deadline_at {
        return Err(ApiError::Conflict("CHALLENGE_EXPIRED"));
    }

    let linked_wallet: Option<String> = sqlx::query_scalar(
        r#"
        select wl.wallet_address
        from wallet_links wl
        join users u on u.id = wl.user_id
        where u.github_user_id = $1 and wl.unlinked_at is null
        limit 1
        "#,
    )
    .bind(user.github_user_id)
    .fetch_optional(&state.pool)
    .await?;
    let linked_wallet = linked_wallet.ok_or(ApiError::Conflict("WALLET_NOT_LINKED"))?;

    let verifying_contract = &state.config.staking_contract_address;

    let signer = recover_eip712_pr_confirmation_address(
        STAKING_CHAIN_ID,
        verifying_contract,
        challenge.github_pr_author_id,
        challenge.github_repo_id,
        challenge.github_pr_number,
        &challenge.head_sha,
        &uuid_to_bytes32_hex(challenge.id),
        &uuid_to_uint256_decimal(nonce_row.nonce),
        nonce_row.expires_at.timestamp(),
        &payload.signature,
    )?;

    if !signer.eq_ignore_ascii_case(&linked_wallet) {
        return Err(ApiError::Conflict("SIGNER_MISMATCH"));
    }

    let stake_status = state.stake_service.stake_status(&signer).await?;
    let threshold_wei = decimal_wei_to_u128(&challenge.threshold_wei_snapshot)?;
    if stake_status.balance_wei < threshold_wei {
        return Err(ApiError::Conflict("INSUFFICIENT_STAKE"));
    }
    if stake_status.unlock_time_unix <= Utc::now().timestamp() as u64 {
        return Err(ApiError::Conflict("LOCK_INACTIVE"));
    }

    let typed_data = json!({
        "github_user_id": challenge.github_pr_author_id,
        "github_repo_id": challenge.github_repo_id,
        "github_pr_number": challenge.github_pr_number,
        "head_sha": challenge.head_sha,
        "challenge_id": uuid_to_bytes32_hex(challenge.id),
        "nonce": uuid_to_uint256_decimal(nonce_row.nonce),
        "expires_at": nonce_row.expires_at.timestamp(),
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
        on conflict (challenge_id) do update set signature = excluded.signature, signer_address = excluded.signer_address, typed_data = excluded.typed_data
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(challenge.id)
    .bind(payload.signature)
    .bind(&signer)
    .bind(Value::from(typed_data))
    .bind(Utc::now())
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "update pr_challenges set status = 'VERIFIED', verified_wallet_address = $2, updated_at = $3 where id = $1",
    )
    .bind(challenge.id)
    .bind(&signer)
    .bind(Utc::now())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    insert_audit(
        &state,
        "CHALLENGE_VERIFIED",
        "challenge",
        challenge.id.to_string(),
        json!({"github_user_id": user.github_user_id, "signer": signer}),
    )
    .await?;

    match sqlx::query_scalar::<_, i64>(
        "select installation_id from repo_configs where github_repo_id = $1",
    )
    .bind(challenge.github_repo_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(Some(installation_id)) => {
            let comment_marker = format!("sitg:verified:{}", challenge.id);
            if let Err(err) = queue_pr_comment_action(
                &state.pool,
                Some(challenge.id),
                installation_id,
                challenge.github_repo_id,
                &challenge.github_repo_full_name,
                challenge.github_pr_number,
                "Stake verification complete. This PR is verified.",
                &comment_marker,
                "CHALLENGE_VERIFIED",
            )
            .await
            {
                tracing::error!(
                    error = %err,
                    challenge_id = %challenge.id,
                    github_repo_id = challenge.github_repo_id,
                    github_pr_number = challenge.github_pr_number,
                    "failed to enqueue verified PR comment action"
                );
            }
        }
        Ok(None) => {
            tracing::warn!(
                challenge_id = %challenge.id,
                github_repo_id = challenge.github_repo_id,
                "repo config missing installation_id; skipped verified PR comment action"
            );
        }
        Err(err) => {
            tracing::error!(
                error = %err,
                challenge_id = %challenge.id,
                github_repo_id = challenge.github_repo_id,
                "failed to load repo installation for verified PR comment action"
            );
        }
    }

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
    // Postgres stores timestamptz with microsecond precision; normalize before issuing message.
    let expires_at = truncate_to_micros(now + Duration::minutes(10));

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
        message: wallet_link_message(user.github_user_id, nonce, expires_at),
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

    let challenge = challenge.ok_or(ApiError::Conflict("WALLET_LINK_CHALLENGE_INVALID"))?;
    let signed_message =
        wallet_link_message(user.github_user_id, challenge.nonce, challenge.expires_at);
    let signer = recover_personal_sign_address(&signed_message, &payload.signature)?;
    if !signer.eq_ignore_ascii_case(&wallet_address) {
        return Err(ApiError::Conflict("SIGNER_MISMATCH"));
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

    sqlx::query(
        "update wallet_links set unlinked_at = $2 where user_id = $1 and unlinked_at is null",
    )
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

    insert_audit(
        &state,
        "WALLET_LINKED",
        "user",
        user.id.to_string(),
        json!({"wallet_address": wallet_address}),
    )
    .await?;

    Ok(Json(WalletLinkConfirmResponse {
        wallet_address,
        linked: true,
    }))
}

async fn wallet_link_status(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<Json<WalletLinkStatusResponse>> {
    let user = require_current_user(&state, &jar).await?;

    let row: Option<(String, i32, chrono::DateTime<Utc>)> = sqlx::query_as(
        "select wallet_address, chain_id, linked_at from wallet_links where user_id = $1 and unlinked_at is null order by linked_at desc limit 1",
    )
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?;

    let (wallet_address, chain_id, linked_at) = row.ok_or(ApiError::NotFound)?;
    Ok(Json(WalletLinkStatusResponse {
        wallet_address,
        chain_id,
        linked_at,
    }))
}

async fn wallet_unlink(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<StatusCode> {
    let user = require_current_user(&state, &jar).await?;

    let current_wallet: Option<String> = sqlx::query_scalar(
        "select wallet_address from wallet_links where user_id = $1 and unlinked_at is null",
    )
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await?;

    let Some(wallet_address) = current_wallet else {
        return Ok(StatusCode::NO_CONTENT);
    };

    let stake_status = state.stake_service.stake_status(&wallet_address).await?;
    if stake_status.balance_wei > 0 {
        return Err(ApiError::Conflict("WALLET_HAS_STAKE"));
    }

    sqlx::query(
        "update wallet_links set unlinked_at = $2 where user_id = $1 and unlinked_at is null",
    )
    .bind(user.id)
    .bind(Utc::now())
    .execute(&state.pool)
    .await?;

    insert_audit(
        &state,
        "WALLET_UNLINKED",
        "user",
        user.id.to_string(),
        json!({"wallet_address": wallet_address}),
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn get_stake_status(
    State(state): State<Arc<AppState>>,
    Query(query): Query<StakeStatusQuery>,
    jar: CookieJar,
) -> ApiResult<Json<StakeStatusResponse>> {
    let user = require_current_user(&state, &jar).await?;
    state
        .rate_limiter
        .check(&format!("stake:status:{}", user.id), 30, 60)?;

    let wallet_address = normalize_wallet_address(&query.wallet)?;
    let stake_status = state.stake_service.stake_status(&wallet_address).await?;

    let unlock_time =
        chrono::DateTime::from_timestamp(stake_status.unlock_time_unix as i64, 0).ok_or_else(
            || ApiError::validation("invalid unlock time"),
        )?;
    let lock_active =
        stake_status.balance_wei > 0 && stake_status.unlock_time_unix > Utc::now().timestamp() as u64;

    Ok(Json(StakeStatusResponse {
        staked_balance_wei: stake_status.balance_wei.to_string(),
        unlock_time,
        lock_active,
    }))
}

async fn get_staking_config(
    State(state): State<Arc<AppState>>,
) -> Json<StakingConfigResponse> {
    Json(StakingConfigResponse {
        chain_id: STAKING_CHAIN_ID,
        contract_address: state.config.staking_contract_address.clone(),
    })
}

async fn internal_v2_pr_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<InternalPrEventResponse>> {
    let payload: InternalPrEventRequest = parse_internal_json(&body)?;
    if payload.delivery_id.trim().is_empty() {
        return Err(ApiError::validation("delivery_id is required"));
    }

    let message = format!("github-event:pull_request:{}", payload.delivery_id);
    let auth = verify_internal_from_headers(&state, &headers, &message, &body).await?;

    let mut tx = state.pool.begin().await?;
    store_internal_replay(
        &mut *tx,
        &auth.key_id,
        auth.request_nonce,
        &auth.signature_hex,
        auth.timestamp,
    )
    .await?;
    let is_new_delivery =
        register_github_delivery(&mut *tx, &payload.delivery_id, "pull_request").await?;
    if !is_new_delivery {
        tx.commit().await?;
        return Ok(Json(InternalPrEventResponse {
            ingest_status: "DUPLICATE".to_string(),
            challenge_id: None,
            enqueued_actions: 0,
        }));
    }

    let relevant_action = matches!(
        payload.action.as_str(),
        "opened" | "reopened" | "ready_for_review" | "synchronize"
    );
    if !relevant_action {
        tx.commit().await?;
        return Ok(Json(InternalPrEventResponse {
            ingest_status: "IGNORED".to_string(),
            challenge_id: None,
            enqueued_actions: 0,
        }));
    }

    sqlx::query("select pg_advisory_xact_lock(hashtext($1), $2)")
        .bind(payload.repository.id.to_string())
        .bind(payload.pull_request.number)
        .execute(&mut *tx)
        .await?;

    let mapped_repo: Option<i64> = sqlx::query_scalar(
        r#"
        select github_repo_id
        from github_installation_repositories
        where installation_id = $1 and github_repo_id = $2 and active = true
        "#,
    )
    .bind(payload.installation_id)
    .bind(payload.repository.id)
    .fetch_optional(&mut *tx)
    .await?;
    if mapped_repo.is_none() {
        tx.commit().await?;
        return Ok(Json(InternalPrEventResponse {
            ingest_status: "IGNORED".to_string(),
            challenge_id: None,
            enqueued_actions: 0,
        }));
    }

    let config: Option<RepoConfigRow> = sqlx::query_as(
        r#"
        select github_repo_id, full_name as _full_name, draft_prs_gated, threshold_wei, input_mode, input_value,
               spot_price_usd, spot_source, spot_at, spot_quote_id, spot_from_cache
        from repo_configs
        where github_repo_id = $1
        "#,
    )
    .bind(payload.repository.id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(config) = config else {
        tx.commit().await?;
        return Ok(Json(InternalPrEventResponse {
            ingest_status: "IGNORED".to_string(),
            challenge_id: None,
            enqueued_actions: 0,
        }));
    };

    if payload.pull_request.is_draft && !config.draft_prs_gated {
        tx.commit().await?;
        return Ok(Json(InternalPrEventResponse {
            ingest_status: "IGNORED".to_string(),
            challenge_id: None,
            enqueued_actions: 0,
        }));
    }

    let is_whitelisted: Option<i64> = sqlx::query_scalar(
        "select github_user_id from repo_whitelist where github_repo_id = $1 and github_user_id = $2",
    )
    .bind(payload.repository.id)
    .bind(payload.pull_request.user.id)
    .fetch_optional(&mut *tx)
    .await?;

    if is_whitelisted.is_some() {
        let inserted = queue_pr_comment_action(
            &mut *tx,
            None,
            payload.installation_id,
            payload.repository.id,
            &payload.repository.full_name,
            payload.pull_request.number,
            "Contributor is whitelisted for this repository. No stake verification is required.",
            &format!(
                "sitg:exempt:{}:{}",
                payload.repository.id, payload.pull_request.number
            ),
            "WHITELIST_EXEMPT",
        )
        .await?;
        tx.commit().await?;
        return Ok(Json(InternalPrEventResponse {
            ingest_status: "ACCEPTED".to_string(),
            challenge_id: None,
            enqueued_actions: if inserted { 1 } else { 0 },
        }));
    }

    let existing: Option<ChallengeRow> = sqlx::query_as(
        r#"
        select id, gate_token, github_repo_id, github_repo_full_name, github_pr_number,
               github_pr_author_id, github_pr_author_login, head_sha, threshold_wei_snapshot,
               draft_at_creation as _draft_at_creation, deadline_at, status
        from pr_challenges
        where github_repo_id = $1 and github_pr_number = $2
          and status in ('PENDING', 'VERIFIED', 'EXEMPT')
        limit 1
        "#,
    )
    .bind(payload.repository.id)
    .bind(payload.pull_request.number)
    .fetch_optional(&mut *tx)
    .await?;

    let mut create_challenge = existing.is_none();
    let mut challenge = None;

    if let Some(existing) = existing {
        match active_challenge_decision(
            &existing.status,
            &existing.head_sha,
            &payload.pull_request.head_sha,
        ) {
            ActiveChallengeDecision::ReusePending => {
                challenge = Some((existing.id, existing.gate_token));
            }
            ActiveChallengeDecision::KeepResolved => {}
            ActiveChallengeDecision::Supersede => {
                let now = Utc::now();
                sqlx::query(
                    r#"
                    update pr_challenges
                    set status = 'CANCELED', updated_at = $2
                    where id = $1 and status in ('PENDING', 'VERIFIED', 'EXEMPT')
                    "#,
                )
                .bind(existing.id)
                .bind(now)
                .execute(&mut *tx)
                .await?;

                sqlx::query(
                    r#"
                    update bot_actions
                    set status = 'FAILED', completed_at = $2, failure_code = 'CHALLENGE_SUPERSEDED',
                        failure_reason = 'pull request head changed', updated_at = $2
                    where challenge_id = $1 and status = 'PENDING'
                    "#,
                )
                .bind(existing.id)
                .bind(now)
                .execute(&mut *tx)
                .await?;

                create_challenge = true;
            }
        }
    }

    if create_challenge {
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
        .execute(&mut *tx)
        .await?;

        let nonce = Uuid::new_v4();
        sqlx::query(
            "insert into challenge_nonces (nonce, challenge_id, expires_at, used_at, created_at) values ($1, $2, $3, null, $4)",
        )
        .bind(nonce)
        .bind(challenge_id)
        .bind(deadline_at)
        .bind(now)
        .execute(&mut *tx)
        .await?;

        challenge = Some((challenge_id, gate_token));
    }

    let mut enqueued_actions = 0i32;
    if let Some((challenge_id, gate_token)) = challenge.as_ref() {
        let gate_url = format!("{}/g/{}", state.config.app_base_url, gate_token);
        let comment = format!(
            "This repository requires stake verification to keep this PR open.\n\nPlease verify within **30 minutes**:\n{}\n\nIf verification is not completed in time, this PR will be automatically closed.",
            gate_url
        );
        let inserted = queue_pr_comment_action(
            &mut *tx,
            Some(*challenge_id),
            payload.installation_id,
            payload.repository.id,
            &payload.repository.full_name,
            payload.pull_request.number,
            &comment,
            &format!("sitg:gate:{}", challenge_id),
            "REQUIRE_STAKE",
        )
        .await?;
        if inserted {
            enqueued_actions = 1;
        }
    }

    let challenge_id = challenge.map(|(id, _)| id);
    tx.commit().await?;

    Ok(Json(InternalPrEventResponse {
        ingest_status: "ACCEPTED".to_string(),
        challenge_id,
        enqueued_actions,
    }))
}

async fn internal_v2_installation_sync(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<InternalInstallationSyncResponse>> {
    let payload: InternalInstallationSyncRequest = parse_internal_json(&body)?;
    if payload.delivery_id.trim().is_empty() {
        return Err(ApiError::validation("delivery_id is required"));
    }

    let message = format!("github-event:installation-sync:{}", payload.delivery_id);
    let auth = verify_internal_from_headers(&state, &headers, &message, &body).await?;

    let mut tx = state.pool.begin().await?;
    store_internal_replay(
        &mut *tx,
        &auth.key_id,
        auth.request_nonce,
        &auth.signature_hex,
        auth.timestamp,
    )
    .await?;
    let is_new_delivery =
        register_github_delivery(&mut *tx, &payload.delivery_id, &payload.event_name).await?;
    if !is_new_delivery {
        tx.commit().await?;
        return Ok(Json(InternalInstallationSyncResponse {
            ingest_status: "DUPLICATE".to_string(),
            updated_installation_id: None,
            updated_repositories: 0,
        }));
    }

    let updated_installation_id: Option<i64>;
    let mut updated_repositories = 0i32;

    match (payload.event_name.as_str(), payload.action.as_str()) {
        ("installation", "created")
        | ("installation", "deleted")
        | ("installation", "suspend")
        | ("installation", "unsuspend") => {
            let Some(installation) = payload.installation else {
                tx.commit().await?;
                return Ok(Json(InternalInstallationSyncResponse {
                    ingest_status: "IGNORED".to_string(),
                    updated_installation_id: None,
                    updated_repositories: 0,
                }));
            };

            updated_installation_id = Some(installation.id);
            let active = matches!(payload.action.as_str(), "created" | "unsuspend");
            let suspended_at = if payload.action == "suspend" {
                Some(payload.event_time)
            } else {
                None
            };
            let deleted_at = if payload.action == "deleted" {
                Some(payload.event_time)
            } else {
                None
            };

            sqlx::query(
                r#"
                insert into github_installations (
                  installation_id, account_login, account_type, active, suspended_at, deleted_at, created_at, updated_at
                )
                values ($1, $2, $3, $4, $5, $6, $7, $7)
                on conflict (installation_id) do update
                set account_login = excluded.account_login,
                    account_type = excluded.account_type,
                    active = excluded.active,
                    suspended_at = excluded.suspended_at,
                    deleted_at = excluded.deleted_at,
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(installation.id)
            .bind(&installation.account_login)
            .bind(&installation.account_type)
            .bind(active)
            .bind(suspended_at)
            .bind(deleted_at)
            .bind(payload.event_time)
            .execute(&mut *tx)
            .await?;

            if payload.action == "deleted" {
                let changed = sqlx::query(
                    "update github_installation_repositories set active = false, updated_at = $2 where installation_id = $1 and active = true",
                )
                .bind(installation.id)
                .bind(payload.event_time)
                .execute(&mut *tx)
                .await?;
                updated_repositories = changed.rows_affected() as i32;
            } else {
                for repo in payload.repositories {
                    let affected = sqlx::query(
                        r#"
                        insert into github_installation_repositories (
                          installation_id, github_repo_id, full_name, active, created_at, updated_at
                        )
                        values ($1, $2, $3, true, $4, $4)
                        on conflict (installation_id, github_repo_id) do update
                        set full_name = excluded.full_name,
                            active = true,
                            updated_at = excluded.updated_at
                        "#,
                    )
                    .bind(installation.id)
                    .bind(repo.id)
                    .bind(&repo.full_name)
                    .bind(payload.event_time)
                    .execute(&mut *tx)
                    .await?;
                    updated_repositories += affected.rows_affected() as i32;
                }
            }
        }
        ("installation_repositories", "added") | ("installation_repositories", "removed") => {
            let Some(installation) = payload.installation else {
                tx.commit().await?;
                return Ok(Json(InternalInstallationSyncResponse {
                    ingest_status: "IGNORED".to_string(),
                    updated_installation_id: None,
                    updated_repositories: 0,
                }));
            };
            updated_installation_id = Some(installation.id);

            sqlx::query(
                r#"
                insert into github_installations (
                  installation_id, account_login, account_type, active, suspended_at, deleted_at, created_at, updated_at
                )
                values ($1, $2, $3, true, null, null, $4, $4)
                on conflict (installation_id) do update
                set account_login = excluded.account_login,
                    account_type = excluded.account_type,
                    active = true,
                    suspended_at = null,
                    deleted_at = null,
                    updated_at = excluded.updated_at
                "#,
            )
            .bind(installation.id)
            .bind(&installation.account_login)
            .bind(&installation.account_type)
            .bind(payload.event_time)
            .execute(&mut *tx)
            .await?;

            if payload.action == "added" {
                for repo in payload.repositories_added {
                    let affected = sqlx::query(
                        r#"
                        insert into github_installation_repositories (
                          installation_id, github_repo_id, full_name, active, created_at, updated_at
                        )
                        values ($1, $2, $3, true, $4, $4)
                        on conflict (installation_id, github_repo_id) do update
                        set full_name = excluded.full_name,
                            active = true,
                            updated_at = excluded.updated_at
                        "#,
                    )
                    .bind(installation.id)
                    .bind(repo.id)
                    .bind(&repo.full_name)
                    .bind(payload.event_time)
                    .execute(&mut *tx)
                    .await?;
                    updated_repositories += affected.rows_affected() as i32;
                }
            } else {
                for repo in payload.repositories_removed {
                    let affected = sqlx::query(
                        r#"
                        update github_installation_repositories
                        set active = false, updated_at = $3
                        where installation_id = $1 and github_repo_id = $2 and active = true
                        "#,
                    )
                    .bind(installation.id)
                    .bind(repo.id)
                    .bind(payload.event_time)
                    .execute(&mut *tx)
                    .await?;
                    updated_repositories += affected.rows_affected() as i32;
                }
            }
        }
        _ => {
            tx.commit().await?;
            return Ok(Json(InternalInstallationSyncResponse {
                ingest_status: "IGNORED".to_string(),
                updated_installation_id: None,
                updated_repositories: 0,
            }));
        }
    }

    tx.commit().await?;
    Ok(Json(InternalInstallationSyncResponse {
        ingest_status: "ACCEPTED".to_string(),
        updated_installation_id,
        updated_repositories,
    }))
}

async fn internal_v2_bot_actions_claim(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<BotActionClaimResponse>> {
    let payload: BotActionClaimRequest = parse_internal_json(&body)?;
    if payload.worker_id.trim().is_empty() {
        return Err(ApiError::validation("worker_id is required"));
    }
    let nonce_message = format!("bot-actions-claim:{}", payload.worker_id);
    let auth = verify_internal_from_headers(&state, &headers, &nonce_message, &body).await?;
    store_internal_replay(
        &state.pool,
        &auth.key_id,
        auth.request_nonce,
        &auth.signature_hex,
        auth.timestamp,
    )
    .await?;

    let limit = payload.limit.unwrap_or(25).clamp(1, 100);
    let mut tx = state.pool.begin().await?;
    let now = Utc::now();
    let lease_expired_before = now - Duration::seconds(BOT_ACTION_CLAIM_LEASE_SECONDS);
    let mut rows: Vec<BotActionRow> = sqlx::query_as(
        r#"
        select id, action_type, installation_id, github_repo_id, repo_full_name, github_pr_number,
               challenge_id, payload, attempts, created_at
        from bot_actions
        where status = 'CLAIMED' and claimed_by = $1
        order by claimed_at asc nulls first, created_at asc
        limit $2
        for update skip locked
        "#,
    )
    .bind(&payload.worker_id)
    .bind(limit)
    .fetch_all(&mut *tx)
    .await?;

    if rows.is_empty() {
        rows = sqlx::query_as(
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
            returning a.id, a.action_type, a.installation_id, a.github_repo_id, a.repo_full_name, a.github_pr_number,
                      a.challenge_id, a.payload, a.attempts, a.created_at
            "#,
        )
        .bind(limit)
        .bind(now)
        .bind(&payload.worker_id)
        .bind(lease_expired_before)
        .fetch_all(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let actions = rows
        .into_iter()
        .map(|r| BotActionItem {
            id: r.id,
            action_type: r.action_type,
            installation_id: r.installation_id,
            github_repo_id: r.github_repo_id,
            repo_full_name: r.repo_full_name,
            github_pr_number: r.github_pr_number,
            challenge_id: r.challenge_id,
            payload: r.payload,
            attempts: r.attempts,
            created_at: r.created_at,
        })
        .collect();

    Ok(Json(BotActionClaimResponse { actions }))
}

async fn internal_v2_bot_action_result(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(action_id): Path<Uuid>,
    body: Bytes,
) -> ApiResult<Json<BotActionResultResponse>> {
    let payload: BotActionResultRequest = parse_internal_json(&body)?;
    if payload.worker_id.trim().is_empty() {
        return Err(ApiError::validation("worker_id is required"));
    }
    let worker_id = payload.worker_id.clone();

    let outcome = payload.outcome.to_uppercase();
    if !matches!(
        outcome.as_str(),
        "SUCCEEDED" | "RETRYABLE_FAILURE" | "FAILED"
    ) {
        return Err(ApiError::validation(
            "outcome must be SUCCEEDED, RETRYABLE_FAILURE, or FAILED",
        ));
    }

    let nonce_message = format!("bot-action-result:{action_id}:{worker_id}:{outcome}");
    let auth = verify_internal_from_headers(&state, &headers, &nonce_message, &body).await?;
    store_internal_replay(
        &state.pool,
        &auth.key_id,
        auth.request_nonce,
        &auth.signature_hex,
        auth.timestamp,
    )
    .await?;

    let failure_code = payload.failure_code;
    let failure_reason = match outcome.as_str() {
        "RETRYABLE_FAILURE" => Some(
            payload
                .failure_message
                .unwrap_or_else(|| "retry requested".to_string()),
        ),
        "FAILED" => Some(
            payload
                .failure_message
                .unwrap_or_else(|| "unknown failure".to_string()),
        ),
        _ => None,
    };
    let now = Utc::now();
    let updated_status: Option<String> = if outcome == "SUCCEEDED" {
        sqlx::query_scalar(
            r#"
            update bot_actions
            set status = 'DONE', completed_at = $3, failure_code = null, failure_reason = null, updated_at = $3
            where id = $1 and status = 'CLAIMED' and claimed_by = $2
            returning status
            "#,
        )
        .bind(action_id)
        .bind(&worker_id)
        .bind(now)
        .fetch_optional(&state.pool)
        .await?
    } else if outcome == "RETRYABLE_FAILURE" {
        let attempts: Option<i32> = sqlx::query_scalar(
            "select attempts from bot_actions where id = $1 and status = 'CLAIMED' and claimed_by = $2",
        )
        .bind(action_id)
        .bind(&worker_id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(attempts) = attempts {
            let exhausted = attempts >= BOT_ACTION_MAX_ATTEMPTS;
            let next_status = if exhausted { "FAILED" } else { "PENDING" };
            let completed_at = if exhausted { Some(now) } else { None };
            let available_at = if exhausted {
                now
            } else {
                now + Duration::seconds(bot_action_retry_delay_seconds(attempts))
            };
            sqlx::query_scalar(
                r#"
                update bot_actions
                set status = $3, claimed_by = $2, claimed_at = null, failure_code = $4,
                    failure_reason = $5, completed_at = $6, available_at = $7, updated_at = $8
                where id = $1 and status = 'CLAIMED' and claimed_by = $2
                returning status
                "#,
            )
            .bind(action_id)
            .bind(&worker_id)
            .bind(next_status)
            .bind(failure_code.as_deref())
            .bind(failure_reason.as_deref())
            .bind(completed_at)
            .bind(available_at)
            .bind(now)
            .fetch_optional(&state.pool)
            .await?
        } else {
            None
        }
    } else {
        sqlx::query_scalar(
            r#"
            update bot_actions
            set status = 'FAILED', completed_at = $5, failure_code = $3, failure_reason = $4, updated_at = $5
            where id = $1 and status = 'CLAIMED' and claimed_by = $2
            returning status
            "#,
        )
        .bind(action_id)
        .bind(&worker_id)
        .bind(failure_code.as_deref())
        .bind(failure_reason.as_deref())
        .bind(now)
        .fetch_optional(&state.pool)
        .await?
    };

    let state_changed = updated_status.is_some();
    let status = if let Some(status) = updated_status {
        status
    } else {
        let existing: Option<BotActionResultStateRow> = sqlx::query_as(
            "select status, claimed_by, failure_code, failure_reason from bot_actions where id = $1",
        )
        .bind(action_id)
        .fetch_optional(&state.pool)
        .await?;
        let Some(existing) = existing else {
            return Err(ApiError::Conflict("BOT_ACTION_NOT_CLAIMED_BY_WORKER"));
        };
        if !is_idempotent_bot_action_result(
            &outcome,
            &existing.status,
            existing.claimed_by.as_deref(),
            &worker_id,
            (
                existing.failure_code.as_deref(),
                existing.failure_reason.as_deref(),
            ),
            (failure_code.as_deref(), failure_reason.as_deref()),
        ) {
            return Err(ApiError::Conflict("BOT_ACTION_NOT_CLAIMED_BY_WORKER"));
        }
        existing.status
    };

    if state_changed {
        insert_audit(
            &state,
            "BOT_ACTION_RESULT",
            "bot_action",
            action_id.to_string(),
            json!({"worker_id": worker_id, "status": status}),
        )
        .await?;
    }

    Ok(Json(BotActionResultResponse {
        id: action_id,
        status,
    }))
}

async fn queue_pr_comment_action<'e, E>(
    executor: E,
    challenge_id: Option<Uuid>,
    installation_id: i64,
    github_repo_id: i64,
    repo_full_name: &str,
    github_pr_number: i32,
    comment_markdown: &str,
    comment_marker: &str,
    reason: &str,
) -> ApiResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let inserted = sqlx::query(
        r#"
        insert into bot_actions (
          id, action_type, challenge_id, installation_id, github_repo_id, repo_full_name, github_pr_number, payload, status, claimed_at, completed_at, created_at, updated_at
        )
        values ($1, 'UPSERT_PR_COMMENT', $2, $3, $4, $5, $6, $7, 'PENDING', null, null, $8, $8)
        on conflict do nothing
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(challenge_id)
    .bind(installation_id)
    .bind(github_repo_id)
    .bind(repo_full_name)
    .bind(github_pr_number)
    .bind(json!({
      "comment_markdown": comment_markdown,
      "comment_marker": comment_marker,
      "reason": reason
    }))
    .bind(Utc::now())
    .execute(executor)
    .await?;
    Ok(inserted.rows_affected() > 0)
}

async fn register_github_delivery<'e, E>(
    executor: E,
    delivery_id: &str,
    event_name: &str,
) -> ApiResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let inserted = sqlx::query(
        r#"
        insert into github_event_deliveries (delivery_id, event_name, first_seen_at)
        values ($1, $2, $3)
        on conflict (delivery_id, event_name) do nothing
        "#,
    )
    .bind(delivery_id)
    .bind(event_name)
    .bind(Utc::now())
    .execute(executor)
    .await?;
    Ok(inserted.rows_affected() > 0)
}

async fn require_current_user(state: &AppState, jar: &CookieJar) -> ApiResult<CurrentUserRow> {
    let session_cookie = jar
        .get(&state.config.session_cookie_name)
        .ok_or(ApiError::Unauthenticated)?;

    let row: Option<CurrentUserRow> = sqlx::query_as(
        r#"
        select u.id, u.github_user_id, u.github_login, s.github_access_token
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

async fn require_repo_owner(
    state: &AppState,
    jar: &CookieJar,
    repo_id: i64,
) -> ApiResult<CurrentUserRow> {
    let user = require_current_user(state, jar).await?;
    let full_name: Option<String> =
        sqlx::query_scalar("select full_name from repo_configs where github_repo_id = $1")
            .bind(repo_id)
            .fetch_optional(&state.pool)
            .await?;
    let full_name = full_name.ok_or(ApiError::NotFound)?;
    let token = user
        .github_access_token
        .as_deref()
        .ok_or(ApiError::Unauthenticated)?;

    let has_access = state
        .github_oauth_service
        .has_repo_write_access(token, &full_name, &user.github_login)
        .await?;
    if !has_access {
        return Err(ApiError::Forbidden);
    }
    Ok(user)
}

async fn require_active_repo_installation(state: &AppState, repo_id: i64) -> ApiResult<i64> {
    let installation_id: Option<i64> = sqlx::query_scalar(
        r#"
        select gir.installation_id
        from github_installation_repositories gir
        join github_installations i on i.installation_id = gir.installation_id
        where gir.github_repo_id = $1
          and gir.active = true
          and i.active = true
        order by gir.updated_at desc
        limit 1
        "#,
    )
    .bind(repo_id)
    .fetch_optional(&state.pool)
    .await?;

    installation_id.ok_or(ApiError::Conflict("REPO_NOT_CONNECTED"))
}

async fn verify_internal_from_headers(
    state: &AppState,
    headers: &HeaderMap,
    message: &str,
    body: &[u8],
) -> ApiResult<crate::services::internal_auth::InternalAuthContext> {
    let key_id = headers
        .get("x-sitg-key-id")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Forbidden)?;
    let timestamp = headers
        .get("x-sitg-timestamp")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Forbidden)?;
    let request_nonce = headers
        .get("x-sitg-nonce")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Forbidden)?;
    let signature_hex = headers
        .get("x-sitg-signature")
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Forbidden)?;
    verify_internal_with_key_id(
        &state.pool,
        key_id,
        timestamp,
        request_nonce,
        signature_hex,
        message,
        body,
    )
    .await
}

async fn store_internal_replay<'e, E>(
    executor: E,
    key_id: &str,
    request_nonce: Uuid,
    signature_hex: &str,
    timestamp: i64,
) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    let inserted = sqlx::query(
        r#"
        insert into internal_request_replays (
          id, key_id, request_nonce, signature, timestamp_unix, created_at
        )
        values ($1, $2, $3, $4, $5, $6)
        on conflict do nothing
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(key_id)
    .bind(request_nonce)
    .bind(signature_hex)
    .bind(timestamp)
    .bind(Utc::now())
    .execute(executor)
    .await?;

    if inserted.rows_affected() == 0 {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

fn parse_internal_json<T: serde::de::DeserializeOwned>(body: &[u8]) -> ApiResult<T> {
    serde_json::from_slice(body).map_err(|_| ApiError::validation("invalid JSON request body"))
}

async fn insert_audit(
    state: &AppState,
    event_type: &str,
    entity_type: &str,
    entity_id: String,
    payload: Value,
) -> ApiResult<()> {
    sqlx::query(
        "insert into audit_events (id, event_type, entity_type, entity_id, payload, created_at) values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(event_type)
    .bind(entity_type)
    .bind(entity_id)
    .bind(payload)
    .bind(Utc::now())
    .execute(&state.pool)
    .await?;
    Ok(())
}

fn wallet_link_message(
    github_user_id: i64,
    nonce: Uuid,
    expires_at: chrono::DateTime<Utc>,
) -> String {
    format!(
        "Link wallet for github_user_id={} nonce={} expires_at={}.",
        github_user_id,
        nonce,
        expires_at.to_rfc3339()
    )
}

fn truncate_to_micros(value: chrono::DateTime<Utc>) -> chrono::DateTime<Utc> {
    chrono::DateTime::<Utc>::from_timestamp_micros(value.timestamp_micros()).unwrap_or(value)
}

fn sanitize_redirect_url(
    candidate: Option<String>,
    allowed_prefix: &str,
    fallback: &str,
) -> String {
    let Some(url) = candidate else {
        return fallback.to_string();
    };

    let Ok(allowed) = reqwest::Url::parse(allowed_prefix) else {
        return fallback.to_string();
    };
    let Ok(parsed) = reqwest::Url::parse(&url) else {
        return fallback.to_string();
    };

    if parsed.scheme() == allowed.scheme()
        && parsed.host_str() == allowed.host_str()
        && parsed.port_or_known_default() == allowed.port_or_known_default()
    {
        url
    } else {
        fallback.to_string()
    }
}

fn append_auth_query(base_url: String, auth: &str, reason: &str) -> String {
    match reqwest::Url::parse(&base_url) {
        Ok(mut parsed) => {
            parsed.query_pairs_mut().append_pair("auth", auth);
            parsed.query_pairs_mut().append_pair("reason", reason);
            parsed.into()
        }
        Err(_) => base_url,
    }
}

fn append_install_query(
    base_url: String,
    setup_action: &str,
    installation_id: Option<i64>,
) -> String {
    match reqwest::Url::parse(&base_url) {
        Ok(mut parsed) => {
            parsed
                .query_pairs_mut()
                .append_pair("github_app", "installed");
            parsed
                .query_pairs_mut()
                .append_pair("setup_action", setup_action);
            if let Some(installation_id) = installation_id {
                parsed
                    .query_pairs_mut()
                    .append_pair("installation_id", &installation_id.to_string());
            }
            parsed.into()
        }
        Err(_) => base_url,
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

#[derive(Debug, PartialEq, Eq)]
enum ActiveChallengeDecision {
    ReusePending,
    KeepResolved,
    Supersede,
}

fn active_challenge_decision(
    existing_status: &str,
    existing_head_sha: &str,
    incoming_head_sha: &str,
) -> ActiveChallengeDecision {
    if existing_head_sha != incoming_head_sha {
        ActiveChallengeDecision::Supersede
    } else if existing_status == "PENDING" {
        ActiveChallengeDecision::ReusePending
    } else {
        ActiveChallengeDecision::KeepResolved
    }
}

fn bot_action_retry_delay_seconds(attempts: i32) -> i64 {
    let exponent = attempts.saturating_sub(1).clamp(0, 30) as u32;
    BOT_ACTION_RETRY_BASE_SECONDS
        .saturating_mul(1_i64 << exponent)
        .min(BOT_ACTION_RETRY_MAX_SECONDS)
}

fn is_idempotent_bot_action_result(
    outcome: &str,
    status: &str,
    claimed_by: Option<&str>,
    worker_id: &str,
    stored_failure: (Option<&str>, Option<&str>),
    requested_failure: (Option<&str>, Option<&str>),
) -> bool {
    if claimed_by != Some(worker_id) {
        return false;
    }

    let status_matches = match outcome {
        "SUCCEEDED" => status == "DONE",
        "FAILED" => status == "FAILED",
        "RETRYABLE_FAILURE" => matches!(status, "PENDING" | "FAILED"),
        _ => false,
    };
    status_matches
        && (outcome == "SUCCEEDED" || stored_failure == requested_failure)
}

fn decimal_wei_to_u128(value: &Decimal) -> ApiResult<u128> {
    value
        .normalize()
        .to_string()
        .parse::<u128>()
        .map_err(|_| ApiError::validation("threshold_wei out of supported range"))
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
    let usd_estimate = (Decimal::from_str_exact(&eth).unwrap_or(Decimal::ZERO)
        * row.spot_price_usd)
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
    use crate::{config::Config, models::db::RepoConfigRow};
    use chrono::{TimeZone, Timelike};
    use sqlx::postgres::PgPoolOptions;

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
            _full_name: "org/repo".to_string(),
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

    #[tokio::test]
    async fn stake_status_requires_an_authenticated_session() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgres://postgres:postgres@127.0.0.1:5432/sitg_test")
            .expect("lazy pool");
        let config = Config {
            host: "127.0.0.1".to_string(),
            port: 8080,
            database_url: "postgres://localhost/sitg".to_string(),
            db_max_connections: 1,
            app_base_url: "https://sitg.io".to_string(),
            api_base_url: "https://sitg.io".to_string(),
            github_client_id: None,
            github_client_secret: None,
            session_cookie_name: "sitg_session".to_string(),
            blocked_unlink_wallets: vec![],
            base_rpc_url: "https://mainnet.base.org".to_string(),
            staking_contract_address: "0x1111111111111111111111111111111111111111".to_string(),
        };
        let state = Arc::new(AppState::new(pool, config));

        let result = get_stake_status(
            State(state),
            Query(StakeStatusQuery {
                wallet: "0x1111111111111111111111111111111111111111".to_string(),
            }),
            CookieJar::new(),
        )
        .await;

        assert!(matches!(result, Err(ApiError::Unauthenticated)));
    }

    #[test]
    fn supersedes_active_challenge_when_pr_head_changes() {
        assert_eq!(
            active_challenge_decision("PENDING", "old-head", "new-head"),
            ActiveChallengeDecision::Supersede
        );
        assert_eq!(
            active_challenge_decision("VERIFIED", "old-head", "new-head"),
            ActiveChallengeDecision::Supersede
        );
        assert_eq!(
            active_challenge_decision("EXEMPT", "old-head", "new-head"),
            ActiveChallengeDecision::Supersede
        );
    }

    #[test]
    fn reuses_only_pending_challenge_for_same_pr_head() {
        assert_eq!(
            active_challenge_decision("PENDING", "same-head", "same-head"),
            ActiveChallengeDecision::ReusePending
        );
        assert_eq!(
            active_challenge_decision("VERIFIED", "same-head", "same-head"),
            ActiveChallengeDecision::KeepResolved
        );
    }

    #[test]
    fn bot_action_retry_backoff_is_exponential_and_capped() {
        assert_eq!(bot_action_retry_delay_seconds(1), 5);
        assert_eq!(bot_action_retry_delay_seconds(2), 10);
        assert_eq!(bot_action_retry_delay_seconds(8), 640);
        assert_eq!(bot_action_retry_delay_seconds(100), 900);
    }

    #[test]
    fn recognizes_only_matching_idempotent_bot_action_results() {
        assert!(is_idempotent_bot_action_result(
            "SUCCEEDED",
            "DONE",
            Some("worker-1"),
            "worker-1",
            (None, None),
            (None, None),
        ));
        assert!(is_idempotent_bot_action_result(
            "RETRYABLE_FAILURE",
            "PENDING",
            Some("worker-1"),
            "worker-1",
            (Some("GITHUB_HTTP_500"), Some("retry")),
            (Some("GITHUB_HTTP_500"), Some("retry")),
        ));
        assert!(!is_idempotent_bot_action_result(
            "FAILED",
            "FAILED",
            Some("worker-2"),
            "worker-1",
            (Some("A"), Some("failure")),
            (Some("A"), Some("failure")),
        ));
    }

    #[test]
    fn generates_token_with_expected_length() {
        let token = build_token(24);
        assert_eq!(token.len(), 24);
    }

    #[test]
    fn validates_redirect_prefix() {
        let redirect = sanitize_redirect_url(
            Some("https://sitg.io/g/abc".to_string()),
            "https://sitg.io",
            "https://sitg.io",
        );
        assert_eq!(redirect, "https://sitg.io/g/abc");

        let fallback = sanitize_redirect_url(
            Some("https://evil.example.com".to_string()),
            "https://sitg.io",
            "https://sitg.io",
        );
        assert_eq!(fallback, "https://sitg.io");
    }

    #[test]
    fn appends_auth_query_to_redirect() {
        let redirect = append_auth_query(
            "https://sitg.io/owner?tab=setup".to_string(),
            "cancelled",
            "access_denied",
        );
        assert_eq!(
            redirect,
            "https://sitg.io/owner?tab=setup&auth=cancelled&reason=access_denied"
        );
    }

    #[test]
    fn appends_install_query_to_redirect() {
        let redirect = append_install_query(
            "https://sitg.io/owner?tab=repo-info".to_string(),
            "install",
            Some(110417326),
        );
        assert_eq!(
            redirect,
            "https://sitg.io/owner?tab=repo-info&github_app=installed&setup_action=install&installation_id=110417326"
        );
    }

    #[test]
    fn wallet_link_message_is_stable_after_microsecond_roundtrip() {
        let nonce = Uuid::parse_str("2c6dc47f-00ea-401d-8d96-13794ca39f35").expect("uuid");
        let raw = Utc
            .with_ymd_and_hms(2026, 2, 13, 23, 10, 5)
            .unwrap()
            .with_nanosecond(821_781_504)
            .expect("nanoseconds");
        let normalized = truncate_to_micros(raw);

        let issued = wallet_link_message(2002, nonce, normalized);
        let from_db = chrono::DateTime::<Utc>::from_timestamp_micros(normalized.timestamp_micros())
            .expect("from micros");
        let verified = wallet_link_message(2002, nonce, from_db);

        assert_eq!(issued, verified);
    }
}
