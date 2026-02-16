use serde::Deserialize;

use crate::{
    config::Config,
    error::{ApiError, ApiResult},
};

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

#[derive(Debug, Deserialize)]
struct GithubInstallationsEnvelope {
    installations: Vec<GithubInstallationItem>,
}

#[derive(Debug, Deserialize)]
struct GithubInstallationItem {
    id: i64,
    account: GithubInstallationAccount,
}

#[derive(Debug, Deserialize)]
struct GithubInstallationAccount {
    login: String,
    #[serde(rename = "type")]
    account_type: String,
}

#[derive(Debug, Clone)]
pub struct GithubInstallationOption {
    pub id: i64,
    pub account_login: String,
    pub account_type: String,
}

impl GithubOAuthService {
    fn can_write(permissions: Option<&GithubRepoPermissions>) -> bool {
        permissions
            .map(|p| {
                p.push.unwrap_or(false) || p.admin.unwrap_or(false) || p.maintain.unwrap_or(false)
            })
            .unwrap_or(false)
    }

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
        let encoded_scope = urlencoding::encode("read:user public_repo");
        Ok(format!(
            "https://github.com/login/oauth/authorize?client_id={client_id}&redirect_uri={encoded_redirect}&scope={encoded_scope}&state={state}"
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
        let response = self
            .client
            .get("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member")
            .bearer_auth(token)
            .header("User-Agent", "sitg-backend")
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

        let mut out: Vec<GithubRepoOption> = repos
            .into_iter()
            .filter(|repo| Self::can_write(repo.permissions.as_ref()))
            .map(|repo| GithubRepoOption {
                id: repo.id,
                full_name: repo.full_name,
            })
            .collect();

        out.sort_by(|a, b| a.full_name.to_lowercase().cmp(&b.full_name.to_lowercase()));
        Ok(out)
    }

    pub async fn lookup_repo_by_id(
        &self,
        token: &str,
        repo_id: i64,
    ) -> ApiResult<Option<GithubRepoLookup>> {
        let response = self
            .client
            .get(format!("https://api.github.com/repositories/{repo_id}"))
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

    pub async fn list_user_installations(
        &self,
        token: &str,
    ) -> ApiResult<Vec<GithubInstallationOption>> {
        let response = self
            .client
            .get("https://api.github.com/user/installations?per_page=100")
            .bearer_auth(token)
            .header("User-Agent", "sitg-backend")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ApiError::Unauthenticated);
        }
        if !response.status().is_success() {
            return Err(ApiError::validation("GitHub installations listing failed"));
        }

        let payload = response
            .json::<GithubInstallationsEnvelope>()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Ok(payload
            .installations
            .into_iter()
            .map(|it| GithubInstallationOption {
                id: it.id,
                account_login: it.account.login,
                account_type: it.account.account_type,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            base_rpc_url: None,
            staking_contract_address: None,
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
}
