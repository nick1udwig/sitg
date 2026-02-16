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

        Self { pool, client }
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
        let response = self
            .client
            .get("https://api.coingecko.com/api/v3/simple/price")
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

        if parsed.ethereum.usd <= Decimal::ZERO {
            return Err(ApiError::PriceUnavailable);
        }

        self.persist_live_quote("coingecko", parsed.ethereum.usd)
            .await
    }

    async fn fetch_live_from_coinbase(&self) -> ApiResult<QuoteSelection> {
        let response = self
            .client
            .get("https://api.coinbase.com/v2/prices/ETH-USD/spot")
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

        let price = Decimal::from_str_exact(parsed.data.amount.trim())
            .map_err(|_| ApiError::PriceUnavailable)?;
        if price <= Decimal::ZERO {
            return Err(ApiError::PriceUnavailable);
        }

        self.persist_live_quote("coinbase", price).await
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
