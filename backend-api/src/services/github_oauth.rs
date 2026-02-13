use serde::Deserialize;

use crate::{config::Config, error::{ApiError, ApiResult}};

#[derive(Clone)]
pub struct GithubOAuthService {
    client: reqwest::Client,
}

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
struct GithubPermissionResponse {
    permission: String,
}

impl GithubOAuthService {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    pub fn authorize_url(&self, config: &Config, state: &str) -> ApiResult<String> {
        let client_id = config
            .github_client_id
            .as_deref()
            .ok_or_else(|| ApiError::validation("GITHUB_CLIENT_ID is not configured"))?;
        let redirect_uri = format!("{}/api/v1/auth/github/callback", config.api_base_url);
        let encoded_redirect = urlencoding::encode(&redirect_uri);
        Ok(format!(
            "https://github.com/login/oauth/authorize?client_id={client_id}&redirect_uri={encoded_redirect}&scope=read:user&state={state}"
        ))
    }

    pub async fn exchange_code_for_token(
        &self,
        config: &Config,
        code: &str,
    ) -> ApiResult<String> {
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
            .post("https://github.com/login/oauth/access_token")
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
            .get("https://api.github.com/user")
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

    pub async fn resolve_login(&self, login: &str) -> ApiResult<Option<GithubUserResponse>> {
        let response = self
            .client
            .get(format!("https://api.github.com/users/{login}"))
            .header("User-Agent", "sitg-backend")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
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

    pub async fn has_repo_write_access(
        &self,
        token: &str,
        full_repo_name: &str,
        login: &str,
    ) -> ApiResult<bool> {
        let response = self
            .client
            .get(format!(
                "https://api.github.com/repos/{full_repo_name}/collaborators/{login}/permission"
            ))
            .bearer_auth(token)
            .header("User-Agent", "sitg-backend")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(false);
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
}
