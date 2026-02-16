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
}

#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub id: String,
    pub github_user_id: i64,
    pub github_login: String,
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
    pub delivery_id: Uuid,
    pub installation_id: i64,
    pub action: String,
    pub repository: InternalRepository,
    pub pull_request: InternalPullRequest,
    pub event_time: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct InternalRepository {
    pub id: i64,
    pub full_name: String,
}

#[derive(Debug, Deserialize)]
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
    pub decision: String,
    pub challenge: Option<InternalChallengePayload>,
}

#[derive(Debug, Serialize)]
pub struct InternalChallengePayload {
    pub id: Uuid,
    pub gate_url: String,
    pub deadline_at: DateTime<Utc>,
    pub comment_markdown: String,
}

#[derive(Debug, Serialize)]
pub struct DeadlineCheckResponse {
    pub action: String,
    pub close: Option<DeadlineCloseAction>,
}

#[derive(Debug, Serialize)]
pub struct DeadlineCloseAction {
    pub github_repo_id: i64,
    pub github_pr_number: i32,
    pub comment_markdown: String,
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
    pub challenge_id: Option<Uuid>,
    pub github_repo_id: i64,
    pub github_pr_number: i32,
    pub payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct BotActionResultRequest {
    pub worker_id: String,
    pub success: bool,
    pub failure_reason: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct BotActionResultResponse {
    pub id: Uuid,
    pub status: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateBotClientRequest {
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct BotClientSummary {
    pub id: Uuid,
    pub name: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct BotClientDetailResponse {
    pub id: Uuid,
    pub name: String,
    pub status: String,
    pub key_ids: Vec<String>,
    pub installation_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
pub struct CreateBotKeyResponse {
    pub key_id: String,
    pub secret: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct SetInstallationBindingsRequest {
    pub installation_ids: Vec<i64>,
}
