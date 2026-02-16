use chrono::{Duration, Utc};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    error::{ApiError, ApiResult},
    models::db::{CoinGeckoPriceEnvelope, SpotQuoteRow},
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

impl QuoteService {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            client: reqwest::Client::new(),
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
        let response = self
            .client
            .get("https://api.coingecko.com/api/v3/simple/price")
            .query(&[("ids", "ethereum"), ("vs_currencies", "usd")])
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

        let id = Uuid::new_v4();
        let now = Utc::now();
        let expires_at = now + Duration::minutes(5);

        sqlx::query(
            r#"
            insert into spot_quotes (id, source, pair, price, fetched_at, expires_at, created_at)
            values ($1, 'coingecko', 'ETH_USD', $2, $3, $4, $3)
            "#,
        )
        .bind(id)
        .bind(parsed.ethereum.usd)
        .bind(now)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;

        Ok(QuoteSelection {
            quote_id: id,
            source: "coingecko".to_string(),
            price: parsed.ethereum.usd,
            fetched_at: now,
            from_cache: false,
        })
    }

    async fn fetch_latest_cached(&self) -> ApiResult<QuoteSelection> {
        let cached: Option<SpotQuoteRow> = sqlx::query_as(
            r#"
            select id, source, price, fetched_at
            from spot_quotes
            where source = 'coingecko' and pair = 'ETH_USD'
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
