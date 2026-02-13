use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct RepoConfigRow {
    pub github_repo_id: i64,
    pub full_name: String,
    pub draft_prs_gated: bool,
    pub threshold_wei: Decimal,
    pub input_mode: String,
    pub input_value: Decimal,
    pub spot_price_usd: Decimal,
    pub spot_source: String,
    pub spot_at: DateTime<Utc>,
    pub spot_quote_id: Option<Uuid>,
    pub spot_from_cache: bool,
}

#[derive(Debug, Clone, FromRow)]
pub struct SpotQuoteRow {
    pub id: Uuid,
    pub source: String,
    pub pair: String,
    pub price: Decimal,
    pub fetched_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct WhitelistRow {
    pub github_user_id: i64,
    pub github_login: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct ChallengeRow {
    pub id: Uuid,
    pub gate_token: String,
    pub github_repo_id: i64,
    pub github_repo_full_name: String,
    pub github_pr_number: i32,
    pub github_pr_author_id: i64,
    pub github_pr_author_login: String,
    pub head_sha: String,
    pub threshold_wei_snapshot: Decimal,
    pub draft_at_creation: bool,
    pub deadline_at: DateTime<Utc>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoinGeckoPriceEnvelope {
    pub ethereum: CoinGeckoPrice,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoinGeckoPrice {
    pub usd: Decimal,
}
