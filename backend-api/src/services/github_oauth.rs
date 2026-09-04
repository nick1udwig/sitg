use std::{collections::HashSet, sync::Arc, time::Duration as StdDuration};

use serde::Deserialize;
use tokio::{sync::Semaphore, task::JoinSet};

use crate::{
    config::Config,
    error::{ApiError, ApiResult},
};

#[derive(Clone)]
pub struct GithubOAuthService {
    client: reqwest::Client,
    web_base_url: String,
    api_base_url: String,
}

const GITHUB_REPOS_PER_PAGE: usize = 100;
const GITHUB_REPO_PAGE_LIMIT: usize = 100;
const GITHUB_LOGIN_LOOKUP_CONCURRENCY: usize = 8;

#[derive(Debug, Deserialize)]
struct GithubAccessTokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
pub struct GithubUserResponse {
    pub id: i64,
    pub login: String,
}

#[derive(Debug, Deserialize)]
struct GithubRepoPermissions {
    admin: Option<bool>,
    maintain: Option<bool>,
    push: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct GithubRepoResponse {
    id: i64,
    full_name: String,
    permissions: Option<GithubRepoPermissions>,
}

#[derive(Debug, Clone)]
pub struct GithubRepoOption {
    pub id: i64,
    pub full_name: String,
}

#[derive(Debug, Clone)]
pub struct GithubRepoLookup {
    pub full_name: String,
    pub can_write: bool,
}

#[derive(Debug, Deserialize)]
struct GithubPermissionResponse {
    permission: String,
}

impl GithubOAuthService {
    fn http_client() -> reqwest::Client {
        reqwest::Client::builder()
            .user_agent("sitg-backend")
            .connect_timeout(StdDuration::from_secs(3))
            .timeout(StdDuration::from_secs(10))
            .build()
            .expect("build GitHub HTTP client")
    }

    fn can_write(permissions: Option<&GithubRepoPermissions>) -> bool {
        permissions
            .map(|p| {
                p.push.unwrap_or(false) || p.admin.unwrap_or(false) || p.maintain.unwrap_or(false)
            })
            .unwrap_or(false)
    }

    pub fn new() -> Self {
        Self {
            client: Self::http_client(),
            web_base_url: "https://github.com".to_string(),
            api_base_url: "https://api.github.com".to_string(),
        }
    }

    #[cfg(test)]
    fn with_api_base_url(api_base_url: String) -> Self {
        Self {
            client: Self::http_client(),
            web_base_url: "https://github.com".to_string(),
            api_base_url: api_base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn authorize_url(&self, config: &Config, state: &str) -> ApiResult<String> {
        let client_id = config
            .github_client_id
            .as_deref()
            .ok_or_else(|| ApiError::validation("GITHUB_CLIENT_ID is not configured"))?;
        let redirect_uri = format!("{}/api/v1/auth/github/callback", config.api_base_url);
        let encoded_redirect = urlencoding::encode(&redirect_uri);
        let encoded_scope = urlencoding::encode("read:user public_repo");
        Ok(format!(
            "{}/login/oauth/authorize?client_id={client_id}&redirect_uri={encoded_redirect}&scope={encoded_scope}&state={state}",
            self.web_base_url
        ))
    }

    pub async fn exchange_code_for_token(&self, config: &Config, code: &str) -> ApiResult<String> {
        let client_id = config
            .github_client_id
            .as_deref()
            .ok_or_else(|| ApiError::validation("GITHUB_CLIENT_ID is not configured"))?;
        let client_secret = config
            .github_client_secret
            .as_deref()
            .ok_or_else(|| ApiError::validation("GITHUB_CLIENT_SECRET is not configured"))?;

        let response = self
            .client
            .post(format!("{}/login/oauth/access_token", self.web_base_url))
            .header("Accept", "application/json")
            .json(&serde_json::json!({
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
            }))
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if !response.status().is_success() {
            return Err(ApiError::validation("GitHub token exchange failed"));
        }

        let payload: GithubAccessTokenResponse = response
            .json()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Ok(payload.access_token)
    }

    pub async fn fetch_user(&self, access_token: &str) -> ApiResult<GithubUserResponse> {
        let response = self
            .client
            .get(format!("{}/user", self.api_base_url))
            .bearer_auth(access_token)
            .header("User-Agent", "sitg-backend")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if !response.status().is_success() {
            return Err(ApiError::validation("GitHub user lookup failed"));
        }

        response
            .json::<GithubUserResponse>()
            .await
            .map_err(|e| ApiError::Internal(e.into()))
    }

    pub async fn resolve_login(
        &self,
        access_token: &str,
        login: &str,
    ) -> ApiResult<Option<GithubUserResponse>> {
        let response = self
            .client
            .get(format!(
                "{}/users/{}",
                self.api_base_url,
                urlencoding::encode(login)
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthenticated);
        }
        if !response.status().is_success() {
            return Err(ApiError::validation("GitHub login resolution failed"));
        }

        let payload = response
            .json::<GithubUserResponse>()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
        Ok(Some(payload))
    }

    pub async fn resolve_logins(
        &self,
        access_token: &str,
        logins: Vec<String>,
    ) -> ApiResult<Vec<(String, Option<GithubUserResponse>)>> {
        let permits = Arc::new(Semaphore::new(GITHUB_LOGIN_LOOKUP_CONCURRENCY));
        let mut tasks = JoinSet::new();

        for (position, login) in logins.into_iter().enumerate() {
            let service = self.clone();
            let token = access_token.to_string();
            let permits = Arc::clone(&permits);
            tasks.spawn(async move {
                let _permit = permits
                    .acquire_owned()
                    .await
                    .expect("lookup semaphore remains open");
                let user = service.resolve_login(&token, &login).await?;
                Ok::<_, ApiError>((position, login, user))
            });
        }

        let mut resolved = Vec::new();
        while let Some(task) = tasks.join_next().await {
            resolved.push(task.map_err(|error| ApiError::Internal(anyhow::Error::new(error)))??);
        }
        resolved.sort_by_key(|(position, _, _)| *position);

        Ok(resolved
            .into_iter()
            .map(|(_, login, user)| (login, user))
            .collect())
    }

    pub async fn has_repo_write_access(
        &self,
        token: &str,
        full_repo_name: &str,
        login: &str,
    ) -> ApiResult<bool> {
        let response = self
            .client
            .get(format!(
                "{}/repos/{full_repo_name}/collaborators/{}/permission",
                self.api_base_url,
                urlencoding::encode(login)
            ))
            .bearer_auth(token)
            .header("User-Agent", "sitg-backend")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthenticated);
        }
        if !response.status().is_success() {
            return Err(ApiError::validation(
                "GitHub permission lookup failed for repo owner check",
            ));
        }

        let payload = response
            .json::<GithubPermissionResponse>()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Ok(matches!(
            payload.permission.as_str(),
            "admin" | "maintain" | "write"
        ))
    }

    pub async fn list_writable_repos(&self, token: &str) -> ApiResult<Vec<GithubRepoOption>> {
        let mut out = Vec::new();
        let mut seen_repo_ids = HashSet::new();

        for page in 1..=GITHUB_REPO_PAGE_LIMIT {
            let response = self
                .client
                .get(format!("{}/user/repos", self.api_base_url))
                .query(&[
                    ("per_page", GITHUB_REPOS_PER_PAGE.to_string()),
                    ("page", page.to_string()),
                    ("sort", "updated".to_string()),
                    (
                        "affiliation",
                        "owner,collaborator,organization_member".to_string(),
                    ),
                ])
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| ApiError::Internal(e.into()))?;

            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Err(ApiError::Unauthenticated);
            }
            if !response.status().is_success() {
                return Err(ApiError::validation("GitHub repository listing failed"));
            }

            let repos = response
                .json::<Vec<GithubRepoResponse>>()
                .await
                .map_err(|e| ApiError::Internal(e.into()))?;
            let page_is_complete = repos.len() < GITHUB_REPOS_PER_PAGE;

            out.extend(
                repos
                    .into_iter()
                    .filter(|repo| Self::can_write(repo.permissions.as_ref()))
                    .filter(|repo| seen_repo_ids.insert(repo.id))
                    .map(|repo| GithubRepoOption {
                        id: repo.id,
                        full_name: repo.full_name,
                    }),
            );

            if page_is_complete {
                out.sort_by(|a, b| a.full_name.to_lowercase().cmp(&b.full_name.to_lowercase()));
                return Ok(out);
            }
        }

        Err(ApiError::validation(
            "GitHub repository listing exceeded the supported page limit",
        ))
    }

    pub async fn lookup_repo_by_id(
        &self,
        token: &str,
        repo_id: i64,
    ) -> ApiResult<Option<GithubRepoLookup>> {
        let response = self
            .client
            .get(format!("{}/repositories/{repo_id}", self.api_base_url))
            .bearer_auth(token)
            .header("User-Agent", "sitg-backend")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthenticated);
        }
        if !response.status().is_success() {
            return Err(ApiError::validation("GitHub repository lookup failed"));
        }

        let repo = response
            .json::<GithubRepoResponse>()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Ok(Some(GithubRepoLookup {
            full_name: repo.full_name,
            can_write: Self::can_write(repo.permissions.as_ref()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Path, Query},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
        Json, Router,
    };
    use std::{collections::HashMap, sync::Mutex};
    use tokio::{net::TcpListener, sync::Notify, time::timeout};

    fn test_config(client_id: Option<&str>) -> Config {
        Config {
            host: "0.0.0.0".to_string(),
            port: 8080,
            database_url: "postgres://localhost/sitg".to_string(),
            db_max_connections: 10,
            app_base_url: "https://sitg.io".to_string(),
            api_base_url: "https://api.sitg.io".to_string(),
            github_client_id: client_id.map(str::to_string),
            github_client_secret: Some("secret".to_string()),
            session_cookie_name: "sitg_session".to_string(),
            blocked_unlink_wallets: vec![],
            base_rpc_url: "https://mainnet.base.org".to_string(),
            staking_contract_address: "0x1111111111111111111111111111111111111111".to_string(),
        }
    }

    #[test]
    fn can_write_requires_any_write_permission_bit() {
        let none = GithubRepoPermissions {
            admin: Some(false),
            maintain: Some(false),
            push: Some(false),
        };
        let push = GithubRepoPermissions {
            admin: Some(false),
            maintain: Some(false),
            push: Some(true),
        };
        let admin = GithubRepoPermissions {
            admin: Some(true),
            maintain: Some(false),
            push: Some(false),
        };
        let maintain = GithubRepoPermissions {
            admin: Some(false),
            maintain: Some(true),
            push: Some(false),
        };

        assert!(!GithubOAuthService::can_write(Some(&none)));
        assert!(GithubOAuthService::can_write(Some(&push)));
        assert!(GithubOAuthService::can_write(Some(&admin)));
        assert!(GithubOAuthService::can_write(Some(&maintain)));
        assert!(!GithubOAuthService::can_write(None));
    }

    #[test]
    fn authorize_url_requires_client_id() {
        let service = GithubOAuthService::new();
        let err = service
            .authorize_url(&test_config(None), "state-123")
            .expect_err("missing client id should fail");
        assert!(matches!(err, ApiError::Validation(msg) if msg.contains("GITHUB_CLIENT_ID")));
    }

    #[test]
    fn authorize_url_encodes_callback_scope_and_state() {
        let service = GithubOAuthService::new();
        let url = service
            .authorize_url(&test_config(Some("client-123")), "state-123")
            .expect("authorize URL");
        assert!(url.contains("client_id=client-123"));
        assert!(url.contains(
            "redirect_uri=https%3A%2F%2Fapi.sitg.io%2Fapi%2Fv1%2Fauth%2Fgithub%2Fcallback"
        ));
        assert!(url.contains("scope=read%3Auser%20public_repo"));
        assert!(url.ends_with("&state=state-123"));
    }

    #[tokio::test]
    async fn lists_all_writable_repository_pages_without_duplicates() {
        let requested_pages = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new().route(
            "/user/repos",
            get({
                let requested_pages = Arc::clone(&requested_pages);
                move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                    let requested_pages = Arc::clone(&requested_pages);
                    async move {
                        if headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            != Some("Bearer owner-token")
                        {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }

                        let page = query
                            .get("page")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or_default();
                        requested_pages.lock().expect("page lock").push(page);
                        let repositories = if page == 1 {
                            (1..=100)
                                .map(|id| {
                                    serde_json::json!({
                                        "id": id,
                                        "full_name": format!("org/repo-{id:03}"),
                                        "permissions": { "push": true }
                                    })
                                })
                                .collect::<Vec<_>>()
                        } else {
                            vec![
                                serde_json::json!({
                                    "id": 1,
                                    "full_name": "org/duplicate",
                                    "permissions": { "push": true }
                                }),
                                serde_json::json!({
                                    "id": 101,
                                    "full_name": "org/repo-101",
                                    "permissions": { "maintain": true }
                                }),
                                serde_json::json!({
                                    "id": 102,
                                    "full_name": "org/read-only",
                                    "permissions": { "push": false }
                                }),
                            ]
                        };

                        Json(repositories).into_response()
                    }
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let repositories = GithubOAuthService::with_api_base_url(format!("http://{addr}"))
            .list_writable_repos("owner-token")
            .await
            .expect("list writable repositories");

        assert_eq!(repositories.len(), 101);
        assert_eq!(
            requested_pages.lock().expect("page lock").as_slice(),
            [1, 2]
        );
        assert!(repositories.iter().any(|repo| repo.id == 101));
        assert!(!repositories.iter().any(|repo| repo.id == 102));
        assert_eq!(repositories.iter().filter(|repo| repo.id == 1).count(), 1);
    }

    #[tokio::test]
    async fn resolves_logins_concurrently_with_owner_authentication() {
        let arrivals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let both_arrived = Arc::new(Notify::new());
        let app = Router::new().route(
            "/users/{login}",
            get({
                let arrivals = Arc::clone(&arrivals);
                let both_arrived = Arc::clone(&both_arrived);
                move |Path(login): Path<String>, headers: HeaderMap| {
                    let arrivals = Arc::clone(&arrivals);
                    let both_arrived = Arc::clone(&both_arrived);
                    async move {
                        if headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            != Some("Bearer owner-token")
                        {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }

                        let arrival =
                            arrivals.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                        if arrival == 1 {
                            if timeout(StdDuration::from_millis(500), both_arrived.notified())
                                .await
                                .is_err()
                            {
                                return StatusCode::REQUEST_TIMEOUT.into_response();
                            }
                        } else {
                            both_arrived.notify_waiters();
                        }

                        if login == "alice" {
                            Json(serde_json::json!({ "id": 1001, "login": "Alice" }))
                                .into_response()
                        } else {
                            StatusCode::NOT_FOUND.into_response()
                        }
                    }
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let results = GithubOAuthService::with_api_base_url(format!("http://{addr}"))
            .resolve_logins(
                "owner-token",
                vec!["alice".to_string(), "missing".to_string()],
            )
            .await
            .expect("resolve logins");

        assert_eq!(arrivals.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(results[0].0, "alice");
        assert_eq!(results[0].1.as_ref().expect("alice").id, 1001);
        assert_eq!(results[1].0, "missing");
        assert!(results[1].1.is_none());
    }
}
