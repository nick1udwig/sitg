use sqlx::PgPool;

use crate::{config::Config, services::quote_service::QuoteService};

pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub quote_service: QuoteService,
}

impl AppState {
    pub fn new(pool: PgPool, config: Config) -> Self {
        let quote_service = QuoteService::new(pool.clone());
        Self {
            pool,
            config,
            quote_service,
        }
    }
}
