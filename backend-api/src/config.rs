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
        let app_base_url =
            env::var("APP_BASE_URL").unwrap_or_else(|_| "https://sitg.io".to_string());
        let api_base_url =
            env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:8080".to_string());
        let github_client_id = env::var("GITHUB_CLIENT_ID").ok();
        let github_client_secret = env::var("GITHUB_CLIENT_SECRET").ok();
        let session_cookie_name =
            env::var("SESSION_COOKIE_NAME").unwrap_or_else(|_| "sitg_session".to_string());
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
            session_cookie_name,
            blocked_unlink_wallets,
            base_rpc_url,
            staking_contract_address,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    const TEST_ENV_KEYS: &[&str] = &[
        "HOST",
        "PORT",
        "DATABASE_URL",
        "DB_MAX_CONNECTIONS",
        "APP_BASE_URL",
        "API_BASE_URL",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "SESSION_COOKIE_NAME",
        "BLOCKED_UNLINK_WALLETS",
        "BASE_RPC_URL",
        "STAKING_CONTRACT_ADDRESS",
    ];

    struct EnvSnapshot {
        entries: Vec<(&'static str, Option<String>)>,
    }

    impl EnvSnapshot {
        fn capture() -> Self {
            let entries = TEST_ENV_KEYS
                .iter()
                .map(|key| (*key, env::var(key).ok()))
                .collect();
            Self { entries }
        }

        fn clear_tracked() {
            for key in TEST_ENV_KEYS {
                unsafe {
                    env::remove_var(key);
                }
            }
        }
    }

    impl Drop for EnvSnapshot {
        fn drop(&mut self) {
            for (key, value) in &self.entries {
                match value {
                    Some(v) => unsafe {
                        env::set_var(key, v);
                    },
                    None => unsafe {
                        env::remove_var(key);
                    },
                }
            }
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn parses_defaults_and_normalizes_blocked_wallets() {
        let _lock = env_lock().lock().expect("env lock");
        let _snapshot = EnvSnapshot::capture();
        EnvSnapshot::clear_tracked();

        unsafe {
            env::set_var("DATABASE_URL", "postgres://localhost/sitg");
            env::set_var("PORT", "not-a-number");
            env::set_var("DB_MAX_CONNECTIONS", "invalid");
            env::set_var("BLOCKED_UNLINK_WALLETS", " 0xAbC , , 0xDEF,");
        }

        let config = Config::from_env().expect("config should parse");
        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 8080);
        assert_eq!(config.db_max_connections, 10);
        assert_eq!(config.app_base_url, "https://sitg.io");
        assert_eq!(config.api_base_url, "http://localhost:8080");
        assert_eq!(config.session_cookie_name, "sitg_session");
        assert_eq!(
            config.blocked_unlink_wallets,
            vec!["0xabc".to_string(), "0xdef".to_string()]
        );
    }

    #[test]
    fn requires_database_url() {
        let _lock = env_lock().lock().expect("env lock");
        let _snapshot = EnvSnapshot::capture();
        EnvSnapshot::clear_tracked();

        let err = Config::from_env().expect_err("DATABASE_URL should be required");
        assert!(matches!(err, env::VarError::NotPresent));
    }
}
