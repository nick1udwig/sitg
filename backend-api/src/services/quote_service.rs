use std::time::Duration as StdDuration;

use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use sqlx::PgPool;
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
}

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
            .timeout(StdDuration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            pool,
            client,
            coingecko_base_url: "https://api.coingecko.com".to_string(),
            coinbase_base_url: "https://api.coinbase.com".to_string(),
        }
    }

    #[cfg(test)]
    fn with_base_urls(pool: PgPool, coingecko_base_url: String, coinbase_base_url: String) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("sitg-backend")
            .timeout(StdDuration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            pool,
            client,
            coingecko_base_url,
            coinbase_base_url,
        }
    }

    pub async fn live_or_cached_eth_usd_quote(&self) -> ApiResult<QuoteSelection> {
        match self.fetch_live().await {
            Ok(live) => Ok(live),
            Err(err) => {
                tracing::warn!(error = %err, "live quote fetch failed, falling back to cached quote");
                self.fetch_latest_cached().await
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
        let expires_at = now + Duration::minutes(5);

        sqlx::query(
            r#"
            insert into spot_quotes (id, source, pair, price, fetched_at, expires_at, created_at)
            values ($1, $2, 'ETH_USD', $3, $4, $5, $4)
            "#,
        )
        .bind(id)
        .bind(source)
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

    async fn fetch_latest_cached(&self) -> ApiResult<QuoteSelection> {
        let cached: Option<SpotQuoteRow> = sqlx::query_as(
            r#"
            select id, source, price, fetched_at
            from spot_quotes
            where pair = 'ETH_USD'
            order by fetched_at desc
            limit 1
            "#,
        )
        .fetch_optional(&self.pool)
        .await?;

        match cached {
            Some(row) => Ok(QuoteSelection {
                quote_id: row.id,
                source: row.source,
                price: row.price,
                fetched_at: row.fetched_at,
                from_cache: true,
            }),
            None => Err(ApiError::PriceUnavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::Query, routing::get};
    use sqlx::postgres::PgPoolOptions;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
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
