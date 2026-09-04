use std::{
    sync::Arc,
    time::{Duration as StdDuration, Instant},
};

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    models::db::SpotQuoteRow,
};

#[derive(Clone)]
pub struct QuoteService {
    pool: PgPool,
    client: reqwest::Client,
    coingecko_base_url: String,
    coinbase_base_url: String,
    pair: String,
    refresh_lock: Arc<Mutex<Option<Instant>>>,
}

const QUOTE_CACHE_TTL_MINUTES: i64 = 5;
const QUOTE_MAX_AGE_MINUTES: i64 = 15;
const QUOTE_FAILURE_RETRY_DELAY: StdDuration = StdDuration::from_secs(30);

#[derive(Debug, Clone)]
pub struct QuoteSelection {
    pub quote_id: Uuid,
    pub source: String,
    pub price: Decimal,
    pub fetched_at: chrono::DateTime<Utc>,
    pub from_cache: bool,
}

#[derive(Debug, Deserialize)]
struct CoinGeckoPriceEnvelope {
    ethereum: CoinGeckoPrice,
}

#[derive(Debug, Deserialize)]
struct CoinGeckoPrice {
    usd: Decimal,
}

#[derive(Debug, Deserialize)]
struct CoinbaseSpotEnvelope {
    data: CoinbaseSpotData,
}

#[derive(Debug, Deserialize)]
struct CoinbaseSpotData {
    amount: String,
}

impl QuoteService {
    pub fn new(pool: PgPool) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("sitg-backend")
            .connect_timeout(StdDuration::from_secs(3))
            .timeout(StdDuration::from_secs(8))
            .build()
            .expect("build quote HTTP client");

        Self {
            pool,
            client,
            coingecko_base_url: "https://api.coingecko.com".to_string(),
            coinbase_base_url: "https://api.coinbase.com".to_string(),
            pair: "ETH_USD".to_string(),
            refresh_lock: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    fn with_base_urls(pool: PgPool, coingecko_base_url: String, coinbase_base_url: String) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("sitg-backend")
            .connect_timeout(StdDuration::from_secs(3))
            .timeout(StdDuration::from_secs(8))
            .build()
            .expect("build quote HTTP client");

        Self {
            pool,
            client,
            coingecko_base_url,
            coinbase_base_url,
            pair: format!("ETH_USD_TEST_{}", Uuid::new_v4()),
            refresh_lock: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn live_or_cached_eth_usd_quote(&self) -> ApiResult<QuoteSelection> {
        if let Some(cached) = self.fetch_fresh_cached().await? {
            return Ok(cached);
        }

        let mut last_refresh_failure = self.refresh_lock.lock().await;
        if let Some(cached) = self.fetch_fresh_cached().await? {
            return Ok(cached);
        }

        if last_refresh_failure
            .as_ref()
            .is_some_and(|failed_at| failed_at.elapsed() < QUOTE_FAILURE_RETRY_DELAY)
        {
            return self.fetch_recent_cached().await;
        }

        match self.fetch_live().await {
            Ok(live) => {
                *last_refresh_failure = None;
                Ok(live)
            }
            Err(err) => {
                *last_refresh_failure = Some(Instant::now());
                tracing::warn!(error = %err, max_age_minutes = QUOTE_MAX_AGE_MINUTES, "live quote fetch failed, falling back to a recent cached quote");
                self.fetch_recent_cached().await
            }
        }
    }

    async fn fetch_live(&self) -> ApiResult<QuoteSelection> {
        match self.fetch_live_from_coingecko().await {
            Ok(quote) => Ok(quote),
            Err(primary_err) => {
                tracing::warn!(error = %primary_err, "coingecko quote fetch failed, trying coinbase");
                self.fetch_live_from_coinbase().await
            }
        }
    }

    async fn fetch_live_from_coingecko(&self) -> ApiResult<QuoteSelection> {
        let price = self.fetch_coingecko_price().await?;
        if price <= Decimal::ZERO {
            return Err(ApiError::PriceUnavailable);
        }

        self.persist_live_quote("coingecko", price).await
    }

    async fn fetch_live_from_coinbase(&self) -> ApiResult<QuoteSelection> {
        let price = self.fetch_coinbase_price().await?;
        if price <= Decimal::ZERO {
            return Err(ApiError::PriceUnavailable);
        }

        self.persist_live_quote("coinbase", price).await
    }

    async fn fetch_coingecko_price(&self) -> ApiResult<Decimal> {
        let response = self
            .client
            .get(format!(
                "{}/api/v3/simple/price",
                self.coingecko_base_url.trim_end_matches('/')
            ))
            .query(&[("ids", "ethereum"), ("vs_currencies", "usd")])
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if !response.status().is_success() {
            return Err(ApiError::PriceUnavailable);
        }

        let parsed: CoinGeckoPriceEnvelope = response
            .json()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Ok(parsed.ethereum.usd)
    }

    async fn fetch_coinbase_price(&self) -> ApiResult<Decimal> {
        let response = self
            .client
            .get(format!(
                "{}/v2/prices/ETH-USD/spot",
                self.coinbase_base_url.trim_end_matches('/')
            ))
            .header("Accept", "application/json")
            .header("CB-VERSION", "2015-04-08")
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if !response.status().is_success() {
            return Err(ApiError::PriceUnavailable);
        }

        let parsed: CoinbaseSpotEnvelope = response
            .json()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Decimal::from_str_exact(parsed.data.amount.trim()).map_err(|_| ApiError::PriceUnavailable)
    }

    async fn persist_live_quote(&self, source: &str, price: Decimal) -> ApiResult<QuoteSelection> {
        let id = Uuid::new_v4();
        let now = Utc::now();
        let expires_at = now + Duration::minutes(QUOTE_CACHE_TTL_MINUTES);

        sqlx::query(
            r#"
            insert into spot_quotes (id, source, pair, price, fetched_at, expires_at, created_at)
            values ($1, $2, $3, $4, $5, $6, $5)
            "#,
        )
        .bind(id)
        .bind(source)
        .bind(&self.pair)
        .bind(price)
        .bind(now)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;

        Ok(QuoteSelection {
            quote_id: id,
            source: source.to_string(),
            price,
            fetched_at: now,
            from_cache: false,
        })
    }

    async fn fetch_fresh_cached(&self) -> ApiResult<Option<QuoteSelection>> {
        let cached: Option<SpotQuoteRow> = sqlx::query_as(
            r#"
            select id, source, price, fetched_at
            from spot_quotes
            where pair = $1
              and price > 0
              and expires_at > $2
            order by fetched_at desc
            limit 1
            "#,
        )
        .bind(&self.pair)
        .bind(Utc::now())
        .fetch_optional(&self.pool)
        .await?;

        Ok(cached.map(|row| QuoteSelection {
            quote_id: row.id,
            source: row.source,
            price: row.price,
            fetched_at: row.fetched_at,
            from_cache: true,
        }))
    }

    async fn fetch_recent_cached(&self) -> ApiResult<QuoteSelection> {
        let now = Utc::now();
        let cached: Option<SpotQuoteRow> = sqlx::query_as(
            r#"
            select id, source, price, fetched_at
            from spot_quotes
            where pair = $1
              and price > 0
              and fetched_at >= $2
              and fetched_at <= $3
            order by fetched_at desc
            limit 1
            "#,
        )
        .bind(&self.pair)
        .bind(now - Duration::minutes(QUOTE_MAX_AGE_MINUTES))
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;

        cached
            .map(|row| QuoteSelection {
                quote_id: row.id,
                source: row.source,
                price: row.price,
                fetched_at: row.fetched_at,
                from_cache: true,
            })
            .ok_or(ApiError::PriceUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::Query, http::StatusCode, response::IntoResponse, routing::get, Json, Router,
    };
    use sqlx::postgres::PgPoolOptions;
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use tokio::net::TcpListener;

    fn lazy_pool() -> PgPool {
        PgPoolOptions::new()
            .connect_lazy("postgres://postgres:postgres@127.0.0.1:5432/sitg_test")
            .expect("lazy pool")
    }

    #[tokio::test]
    async fn calls_exact_coingecko_endpoint_and_parses_price() {
        let hits = Arc::new(Mutex::new(Vec::<String>::new()));
        let hits_clone = Arc::clone(&hits);
        let app = Router::new().route(
            "/api/v3/simple/price",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let hits = Arc::clone(&hits_clone);
                async move {
                    hits.lock().expect("lock").push(format!(
                        "/api/v3/simple/price?ids={}&vs_currencies={}",
                        q.get("ids").cloned().unwrap_or_default(),
                        q.get("vs_currencies").cloned().unwrap_or_default()
                    ));
                    Json(serde_json::json!({ "ethereum": { "usd": 2010.50 } }))
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let service = QuoteService::with_base_urls(
            lazy_pool(),
            format!("http://{}", addr),
            "http://127.0.0.1:9".to_string(),
        );

        let price = service.fetch_coingecko_price().await.expect("price");
        assert_eq!(price, Decimal::from_str_exact("2010.50").expect("decimal"));
        assert_eq!(
            hits.lock().expect("lock").as_slice(),
            ["/api/v3/simple/price?ids=ethereum&vs_currencies=usd"]
        );
    }

    #[tokio::test]
    async fn calls_exact_coinbase_endpoint_and_parses_price() {
        let hits = Arc::new(Mutex::new(Vec::<String>::new()));
        let hits_clone = Arc::clone(&hits);
        let app = Router::new().route(
            "/v2/prices/ETH-USD/spot",
            get(move || {
                let hits = Arc::clone(&hits_clone);
                async move {
                    hits.lock().expect("lock").push("/v2/prices/ETH-USD/spot".to_string());
                    Json(serde_json::json!({ "data": { "amount": "2022.33", "base": "ETH", "currency": "USD" } }))
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let service = QuoteService::with_base_urls(
            lazy_pool(),
            "http://127.0.0.1:9".to_string(),
            format!("http://{}", addr),
        );

        let price = service.fetch_coinbase_price().await.expect("price");
        assert_eq!(price, Decimal::from_str_exact("2022.33").expect("decimal"));
        assert_eq!(
            hits.lock().expect("lock").as_slice(),
            ["/v2/prices/ETH-USD/spot"]
        );
    }

    #[tokio::test]
    #[ignore = "requires DATABASE_URL postgres"]
    async fn reuses_fresh_quotes_single_flight_and_rejects_over_age_fallback() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set when running the quote cache integration test");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to quote cache test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let hits = Arc::new(AtomicUsize::new(0));
        let fail_requests = Arc::new(AtomicBool::new(false));
        let app = Router::new().route(
            "/api/v3/simple/price",
            get({
                let hits = Arc::clone(&hits);
                let fail_requests = Arc::clone(&fail_requests);
                move || {
                    let hits = Arc::clone(&hits);
                    let fail_requests = Arc::clone(&fail_requests);
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        if fail_requests.load(Ordering::SeqCst) {
                            return StatusCode::SERVICE_UNAVAILABLE.into_response();
                        }
                        Json(serde_json::json!({ "ethereum": { "usd": 2100.25 } })).into_response()
                    }
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let service = QuoteService::with_base_urls(
            pool.clone(),
            format!("http://{}", addr),
            "http://127.0.0.1:9".to_string(),
        );
        let mut requests = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let service = service.clone();
            requests.spawn(async move { service.live_or_cached_eth_usd_quote().await });
        }

        let mut quotes = Vec::new();
        while let Some(result) = requests.join_next().await {
            quotes.push(result.expect("quote task").expect("quote"));
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "refresh should be single-flight"
        );
        assert!(quotes
            .iter()
            .all(|quote| quote.quote_id == quotes[0].quote_id));
        assert_eq!(quotes.iter().filter(|quote| !quote.from_cache).count(), 1);

        let quote_id = quotes[0].quote_id;
        sqlx::query(
            "update spot_quotes set fetched_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = $1",
        )
        .bind(quote_id)
        .execute(&pool)
        .await
        .expect("age quote within fallback window");
        fail_requests.store(true, Ordering::SeqCst);

        let mut fallback_requests = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let service = service.clone();
            fallback_requests.spawn(async move { service.live_or_cached_eth_usd_quote().await });
        }

        while let Some(result) = fallback_requests.join_next().await {
            let fallback = result
                .expect("fallback quote task")
                .expect("recent stale quote should be accepted during provider outage");
            assert_eq!(fallback.quote_id, quote_id);
            assert!(fallback.from_cache);
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "concurrent callers should share one failed refresh attempt"
        );

        sqlx::query(
            "update spot_quotes set fetched_at = now() - interval '16 minutes' where id = $1",
        )
        .bind(quote_id)
        .execute(&pool)
        .await
        .expect("age quote past fallback window");

        let err = service
            .live_or_cached_eth_usd_quote()
            .await
            .expect_err("over-age quote must not be accepted");
        assert!(matches!(err, ApiError::PriceUnavailable));

        sqlx::query("delete from spot_quotes where pair = $1")
            .bind(&service.pair)
            .execute(&pool)
            .await
            .expect("clean up test quotes");
    }

    #[tokio::test]
    #[ignore = "live network test; run explicitly"]
    async fn live_coingecko_endpoint_returns_price() {
        let service = QuoteService::new(lazy_pool());
        let price = service
            .fetch_coingecko_price()
            .await
            .expect("live coingecko price");
        assert!(price > Decimal::ZERO);
    }

    #[tokio::test]
    #[ignore = "live network test; run explicitly"]
    async fn live_coinbase_endpoint_returns_price() {
        let service = QuoteService::new(lazy_pool());
        let price = service
            .fetch_coinbase_price()
            .await
            .expect("live coinbase price");
        assert!(price > Decimal::ZERO);
    }
}
