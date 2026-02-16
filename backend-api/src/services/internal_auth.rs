use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::error::{ApiError, ApiResult};

pub struct InternalAuthContext {
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

    let stored_secret: Option<String> = sqlx::query_scalar(
        r#"
        select secret_hash
        from service_bot_keys
        where key_id = $1
          and active = true
          and revoked_at is null
        "#,
    )
    .bind(key_id)
    .fetch_optional(pool)
    .await?;

    let stored_secret = stored_secret.ok_or(ApiError::Forbidden)?;
    verify_hmac(&stored_secret, timestamp, message, &signature)?;

    sqlx::query("update service_bot_keys set last_used_at = $2 where key_id = $1")
        .bind(key_id)
        .bind(Utc::now())
        .execute(pool)
        .await?;

    Ok(InternalAuthContext {
        _key_id: key_id.to_string(),
        timestamp,
        signature_hex,
    })
}

fn verify_hmac(
    stored_secret: &str,
    timestamp: i64,
    message: &str,
    signature: &[u8],
) -> ApiResult<()> {
    let key = decode_hmac_key(stored_secret)?;
    let mut mac = HmacSha256::new_from_slice(&key).map_err(|_| ApiError::Forbidden)?;
    mac.update(format!("{timestamp}.{message}").as_bytes());
    mac.verify_slice(signature).map_err(|_| ApiError::Forbidden)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn encode_bot_secret_for_storage(raw_secret: &str) -> String {
    let digest = Sha256::digest(raw_secret.as_bytes());
    format!("sha256:{}", hex::encode(digest))
}

fn decode_hmac_key(stored_secret: &str) -> ApiResult<Vec<u8>> {
    let hex_key = stored_secret
        .strip_prefix("sha256:")
        .ok_or(ApiError::Forbidden)?;
    let bytes = hex::decode(hex_key).map_err(|_| ApiError::Forbidden)?;
    if bytes.len() != 32 {
        return Err(ApiError::Forbidden);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_hmac_payload_with_hashed_storage() {
        let raw_secret = "topsecret";
        let secret = encode_bot_secret_for_storage(raw_secret);
        let timestamp = Utc::now().timestamp();
        let message = "abc";
        let key = decode_hmac_key(&secret).expect("key");
        let mut mac = HmacSha256::new_from_slice(&key).expect("hmac");
        mac.update(format!("{timestamp}.{message}").as_bytes());
        let signature = mac.finalize().into_bytes();

        verify_hmac(&secret, timestamp, message, signature.as_slice()).expect("valid");
    }

    #[test]
    fn rejects_unhashed_storage_secret() {
        let err = verify_hmac("plain-secret", Utc::now().timestamp(), "abc", &[0u8; 32])
            .expect_err("secret format should be rejected");
        assert!(matches!(err, ApiError::Forbidden));
    }

    #[test]
    fn rejects_invalid_signature_for_payload() {
        let secret = encode_bot_secret_for_storage("topsecret");
        let err = verify_hmac(&secret, Utc::now().timestamp(), "abc", &[0u8; 32])
            .expect_err("signature should not verify");
        assert!(matches!(err, ApiError::Forbidden));
    }
}
