use sqlx::PgPool;

use crate::{
    config::Config,
    services::{
        github_oauth::GithubOAuthService, quote_service::QuoteService, stake_service::StakeService,
    },
};

pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub quote_service: QuoteService,
    pub github_oauth_service: GithubOAuthService,
    pub stake_service: StakeService,
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Self {
        let quote_service = QuoteService::new(pool.clone());
        let github_oauth_service = GithubOAuthService::new();
        let stake_service = StakeService::new(&config);
        Self {
            pool,
            config,
            quote_service,
            github_oauth_service,
            stake_service,
        }
    }
}
