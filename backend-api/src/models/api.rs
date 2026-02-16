use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct AuthStartQuery {
    pub redirect_after: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub installation_id: Option<i64>,
    pub setup_action: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub id: String,
    pub github_user_id: i64,
    pub github_login: String,
}

#[derive(Debug, Serialize)]
pub struct RepoOptionResponse {
    pub id: i64,
    pub full_name: String,
}

#[derive(Debug, Serialize)]
pub struct RepoGithubAppStatusResponse {
    pub installed: bool,
    pub installation_id: Option<i64>,
    pub installation_account_login: Option<String>,
    pub installation_account_type: Option<String>,
    pub repo_connected: bool,
}

#[derive(Debug, Deserialize)]
pub struct RepoConfigPutRequest {
    pub input_mode: String,
    pub input_value: String,
    pub draft_prs_gated: bool,
}

#[derive(Debug, Serialize)]
pub struct RepoConfigResponse {
    pub github_repo_id: i64,
    pub threshold: ThresholdResponse,
    pub draft_prs_gated: bool,
}

#[derive(Debug, Serialize)]
pub struct ThresholdResponse {
    pub wei: String,
    pub eth: String,
    pub usd_estimate: String,
    pub input_mode: String,
    pub input_value: String,
    pub spot_price_usd: String,
    pub spot_source: String,
    pub spot_at: DateTime<Utc>,
    pub spot_from_cache: bool,
    pub spot_quote_id: Option<Uuid>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct ResolveLoginsRequest {
    pub logins: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ResolveLoginsResponse {
    pub resolved: Vec<ResolvedLogin>,
    pub unresolved: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolvedLogin {
    pub github_user_id: i64,
    pub github_login: String,
}

#[derive(Debug, Deserialize)]
pub struct WhitelistPutRequest {
    pub entries: Vec<ResolvedLogin>,
}

#[derive(Debug, Serialize)]
pub struct GateResponse {
    pub challenge_id: Uuid,
    pub status: String,
    pub github_repo_id: i64,
    pub github_repo_full_name: String,
    pub github_pr_number: i32,
    pub github_pr_author_id: i64,
    pub github_pr_author_login: String,
    pub head_sha: String,
    pub deadline_at: DateTime<Utc>,
    pub threshold_wei_snapshot: String,
}

#[derive(Debug, Serialize)]
pub struct ConfirmTypedDataResponse {
    pub domain: TypedDataDomain,
    pub primary_type: String,
    pub message: TypedDataMessage,
}

#[derive(Debug, Serialize)]
pub struct TypedDataDomain {
    pub name: String,
    pub version: String,
    #[serde(rename = "chainId")]
    pub chain_id: u64,
    #[serde(rename = "verifyingContract")]
    pub verifying_contract: String,
}

#[derive(Debug, Serialize)]
pub struct TypedDataMessage {
    #[serde(rename = "githubUserId")]
    pub github_user_id: i64,
    #[serde(rename = "githubRepoId")]
    pub github_repo_id: i64,
    #[serde(rename = "pullRequestNumber")]
    pub pull_request_number: i32,
    #[serde(rename = "headSha")]
    pub head_sha: String,
    #[serde(rename = "challengeId")]
    pub challenge_id: String,
    pub nonce: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmRequest {
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct ConfirmResponse {
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct WalletLinkChallengeResponse {
    pub nonce: String,
    pub expires_at: DateTime<Utc>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct WalletLinkConfirmRequest {
    pub nonce: String,
    pub wallet_address: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct WalletLinkConfirmResponse {
    pub wallet_address: String,
    pub linked: bool,
}

#[derive(Debug, Deserialize)]
pub struct InternalPrEventRequest {
    pub delivery_id: String,
    pub event_time: DateTime<Utc>,
    pub installation_id: i64,
    pub action: String,
    pub repository: InternalRepository,
    pub pull_request: InternalPullRequest,
}

#[derive(Debug, Deserialize)]
pub struct InternalRepository {
    pub id: i64,
    pub full_name: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct InternalPullRequest {
    pub number: i32,
    pub id: i64,
    pub html_url: String,
    pub user: InternalPrUser,
    pub head_sha: String,
    pub is_draft: bool,
}

#[derive(Debug, Deserialize)]
pub struct InternalPrUser {
    pub id: i64,
    pub login: String,
}

#[derive(Debug, Serialize)]
pub struct InternalPrEventResponse {
    pub ingest_status: String,
    pub challenge_id: Option<Uuid>,
    pub enqueued_actions: i32,
}

#[derive(Debug, Deserialize)]
pub struct InternalInstallationSyncRequest {
    pub delivery_id: String,
    pub event_time: DateTime<Utc>,
    pub event_name: String,
    pub action: String,
    pub installation: Option<InternalInstallationPayload>,
    #[serde(default)]
    pub repositories_added: Vec<InternalRepository>,
    #[serde(default)]
    pub repositories_removed: Vec<InternalRepository>,
    #[serde(default)]
    pub repositories: Vec<InternalRepository>,
}

#[derive(Debug, Deserialize)]
pub struct InternalInstallationPayload {
    pub id: i64,
    pub account_login: String,
    pub account_type: String,
}

#[derive(Debug, Serialize)]
pub struct InternalInstallationSyncResponse {
    pub ingest_status: String,
    pub updated_installation_id: Option<i64>,
    pub updated_repositories: i32,
}

#[derive(Debug, Deserialize)]
pub struct BotActionClaimRequest {
    pub worker_id: String,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct BotActionClaimResponse {
    pub actions: Vec<BotActionItem>,
}

#[derive(Debug, Serialize)]
pub struct BotActionItem {
    pub id: Uuid,
    pub action_type: String,
    pub installation_id: i64,
    pub github_repo_id: i64,
    pub repo_full_name: String,
    pub github_pr_number: i32,
    pub challenge_id: Option<Uuid>,
    pub payload: serde_json::Value,
    pub attempts: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct BotActionResultRequest {
    pub worker_id: String,
    pub outcome: String,
    pub failure_code: Option<String>,
    pub failure_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BotActionResultResponse {
    pub id: Uuid,
    pub status: String,
}
