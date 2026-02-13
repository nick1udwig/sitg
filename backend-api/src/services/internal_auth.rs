use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

pub struct InternalAuthContext {
    pub bot_client_id: Uuid,
    pub _key_id: String,
    pub timestamp: i64,
    pub signature_hex: String,
}

type HmacSha256 = Hmac<Sha256>;

pub async fn verify_internal_request(
    pool: &PgPool,
    key_id: &str,
    timestamp_str: &str,
    signature_header: &str,
    message: &str,
) -> ApiResult<InternalAuthContext> {
    let timestamp = timestamp_str
        .parse::<i64>()
        .map_err(|_| ApiError::Forbidden)?;
    if (Utc::now().timestamp() - timestamp).abs() > 300 {
        return Err(ApiError::Forbidden);
    }

    let signature_hex = signature_header
        .strip_prefix("sha256=")
        .unwrap_or(signature_header)
        .to_string();
    let signature = hex::decode(&signature_hex).map_err(|_| ApiError::Forbidden)?;

    let row: Option<(Uuid, String)> = sqlx::query_as(
        r#"
        select k.bot_client_id, k.secret_hash
        from bot_client_keys k
        join bot_clients c on c.id = k.bot_client_id
        where k.key_id = $1
          and k.active = true
          and k.revoked_at is null
          and c.status = 'ACTIVE'
        "#,
    )
    .bind(key_id)
    .fetch_optional(pool)
    .await?;

    let (bot_client_id, hmac_secret) = row.ok_or(ApiError::Forbidden)?;
    verify_hmac(&hmac_secret, timestamp, message, &signature)?;

    sqlx::query("update bot_client_keys set last_used_at = $2 where key_id = $1")
        .bind(key_id)
        .bind(Utc::now())
        .execute(pool)
        .await?;

    Ok(InternalAuthContext {
        bot_client_id,
        _key_id: key_id.to_string(),
        timestamp,
        signature_hex,
    })
}

fn verify_hmac(secret: &str, timestamp: i64, message: &str, signature: &[u8]) -> ApiResult<()> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| ApiError::Forbidden)?;
    mac.update(format!("{timestamp}.{message}").as_bytes());
    mac.verify_slice(signature).map_err(|_| ApiError::Forbidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_hmac_payload() {
        let secret = "topsecret";
        let timestamp = Utc::now().timestamp();
        let message = "abc";
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac");
        mac.update(format!("{timestamp}.{message}").as_bytes());
        let signature = mac.finalize().into_bytes();

        verify_hmac(secret, timestamp, message, signature.as_slice()).expect("valid");
    }
}

pub async fn ensure_installation_bound(
    pool: &PgPool,
    bot_client_id: Uuid,
    installation_id: i64,
) -> ApiResult<()> {
    let bound: Option<i64> = sqlx::query_scalar(
        "select installation_id from bot_installation_bindings where bot_client_id = $1 and installation_id = $2",
    )
    .bind(bot_client_id)
    .bind(installation_id)
    .fetch_optional(pool)
    .await?;

    if bound.is_some() {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
    }
}
