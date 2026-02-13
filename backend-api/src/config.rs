use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_url: String,
    pub db_max_connections: u32,
    pub app_base_url: String,
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
        let database_url = env::var("DATABASE_URL")?;

        Ok(Self {
            host,
            port,
            database_url,
            db_max_connections,
            app_base_url,
        })
    }
}
