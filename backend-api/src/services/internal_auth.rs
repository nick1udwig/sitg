use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

pub struct InternalAuthContext {
    pub key_id: String,
    pub timestamp: i64,
    pub request_nonce: Uuid,
    pub signature_hex: String,
}

pub async fn verify_internal_request(
    pool: &PgPool,
    key_id: &str,
    timestamp_str: &str,
    request_nonce_str: &str,
    signature_header: &str,
    message: &str,
    body: &[u8],
) -> ApiResult<InternalAuthContext> {
    let timestamp = timestamp_str
        .parse::<i64>()
        .map_err(|_| ApiError::Forbidden)?;
    if (Utc::now().timestamp() - timestamp).abs() > 300 {
        return Err(ApiError::Forbidden);
    }

    let request_nonce = Uuid::parse_str(request_nonce_str).map_err(|_| ApiError::Forbidden)?;
    let signature_hex = signature_header
        .strip_prefix("ed25519=")
        .ok_or(ApiError::Forbidden)?;
    let signature_bytes = hex::decode(signature_hex).map_err(|_| ApiError::Forbidden)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| ApiError::Forbidden)?;

    let stored_public_key: Option<String> = sqlx::query_scalar(
        r#"
        select public_key
        from service_bot_keys
        where key_id = $1
          and active = true
          and revoked_at is null
          and public_key is not null
        "#,
    )
    .bind(key_id)
    .fetch_optional(pool)
    .await?;

    let stored_public_key = stored_public_key.ok_or(ApiError::Forbidden)?;
    verify_ed25519(
        &stored_public_key,
        timestamp,
        request_nonce,
        message,
        body,
        &signature,
    )?;

    sqlx::query("update service_bot_keys set last_used_at = $2 where key_id = $1")
        .bind(key_id)
        .bind(Utc::now())
        .execute(pool)
        .await?;

    Ok(InternalAuthContext {
        key_id: key_id.to_string(),
        timestamp,
        request_nonce,
        signature_hex: hex::encode(signature_bytes),
    })
}

fn verify_ed25519(
    stored_public_key: &str,
    timestamp: i64,
    request_nonce: Uuid,
    message: &str,
    body: &[u8],
    signature: &Signature,
) -> ApiResult<()> {
    let public_key_der = STANDARD
        .decode(stored_public_key)
        .map_err(|_| ApiError::Forbidden)?;
    let verifying_key =
        VerifyingKey::from_public_key_der(&public_key_der).map_err(|_| ApiError::Forbidden)?;
    let payload = internal_signing_payload(timestamp, request_nonce, message, body);
    verifying_key
        .verify(&payload, signature)
        .map_err(|_| ApiError::Forbidden)
}

fn internal_signing_payload(
    timestamp: i64,
    request_nonce: Uuid,
    message: &str,
    body: &[u8],
) -> Vec<u8> {
    let body_hash = Sha256::digest(body);
    format!(
        "{timestamp}.{request_nonce}.{message}.{}",
        hex::encode(body_hash)
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};

    fn test_key() -> (SigningKey, String) {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_der = signing_key
            .verifying_key()
            .to_public_key_der()
            .expect("encode public key");
        (signing_key, STANDARD.encode(public_der.as_bytes()))
    }

    #[test]
    fn verifies_signature_bound_to_nonce_message_and_body() {
        let (signing_key, public_key) = test_key();
        let timestamp = 1_800_000_000;
        let nonce = Uuid::parse_str("9d3b948a-fb4d-4b60-81e7-5a19378c806d").expect("uuid");
        let message = "bot-actions-claim:worker-1";
        let body = br#"{"worker_id":"worker-1","limit":25}"#;
        let payload = internal_signing_payload(timestamp, nonce, message, body);
        let signature = signing_key.sign(&payload);

        verify_ed25519(
            &public_key,
            timestamp,
            nonce,
            message,
            body,
            &signature,
        )
        .expect("valid signature");

        let error = verify_ed25519(
            &public_key,
            timestamp,
            nonce,
            message,
            br#"{"worker_id":"worker-1","limit":100}"#,
            &signature,
        )
        .expect_err("modified body must fail");
        assert!(matches!(error, ApiError::Forbidden));
    }

    #[test]
    fn rejects_signature_from_another_key() {
        let (_, public_key) = test_key();
        let other_key = SigningKey::from_bytes(&[8_u8; 32]);
        let nonce = Uuid::nil();
        let signature = other_key.sign(&internal_signing_payload(1, nonce, "message", b"{}"));

        let error = verify_ed25519(&public_key, 1, nonce, "message", b"{}", &signature)
            .expect_err("wrong key must fail");
        assert!(matches!(error, ApiError::Forbidden));
    }
}
