mod app;
mod config;
mod error;
mod models;
mod routes;
mod services;

use std::sync::Arc;

use app::AppState;
use config::Config;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_target(false)
        .compact()
        .init();

    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .connect(&config.database_url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    let state = Arc::new(AppState::new(pool, config.clone()));
    services::jobs::start_background_jobs(state.clone());
    let app = routes::router(state);

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    tracing::info!(host = %config.host, port = config.port, "backend-api listening");

    axum::serve(listener, app).await?;

    Ok(())
}
