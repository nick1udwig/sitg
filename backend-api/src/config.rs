use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub db_max_connections: u32,
    pub app_base_url: String,
    pub api_base_url: String,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    pub github_owner_check_token: Option<String>,
    pub session_cookie_name: String,
    pub blocked_unlink_wallets: Vec<String>,
    pub base_rpc_url: Option<String>,
    pub staking_contract_address: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, env::VarError> {
        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = env::var("PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8080);
        let db_max_connections = env::var("DB_MAX_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(10);
        let app_base_url = env::var("APP_BASE_URL").unwrap_or_else(|_| "https://app.example.com".to_string());
        let api_base_url = env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:8080".to_string());
        let github_client_id = env::var("GITHUB_CLIENT_ID").ok();
        let github_client_secret = env::var("GITHUB_CLIENT_SECRET").ok();
        let github_owner_check_token = env::var("GITHUB_OWNER_CHECK_TOKEN").ok();
        let session_cookie_name =
            env::var("SESSION_COOKIE_NAME").unwrap_or_else(|_| "stc_session".to_string());
        let blocked_unlink_wallets = env::var("BLOCKED_UNLINK_WALLETS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        let base_rpc_url = env::var("BASE_RPC_URL").ok();
        let staking_contract_address = env::var("STAKING_CONTRACT_ADDRESS").ok();
        let database_url = env::var("DATABASE_URL")?;

        Ok(Self {
            host,
            port,
            database_url,
            db_max_connections,
            app_base_url,
            api_base_url,
            github_client_id,
            github_client_secret,
            github_owner_check_token,
            session_cookie_name,
            blocked_unlink_wallets,
            base_rpc_url,
            staking_contract_address,
        })
    }
}
