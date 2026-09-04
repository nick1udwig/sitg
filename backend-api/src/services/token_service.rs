use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    config::TokenEncryptionKey,
    error::{ApiError, ApiResult},
};

const ENCRYPTED_TOKEN_PREFIX: &str = "enc:v1:";
const TOKEN_AAD: &[u8] = b"sitg:user_sessions:github_access_token:v1";
const AES_GCM_NONCE_LENGTH: usize = 12;
const TOKEN_BACKFILL_LOCK_ID: i64 = 6_000_285_038_052_379_461;

pub struct TokenCipher {
    key: LessSafeKey,
}

impl TokenCipher {
    pub fn new(key: &TokenEncryptionKey) -> Self {
        let key = UnboundKey::new(&AES_256_GCM, key.as_bytes())
            .expect("validated AES-256-GCM key length");
        Self {
            key: LessSafeKey::new(key),
        }
    }

    pub fn encrypt(&self, plaintext: &str) -> ApiResult<String> {
        let mut nonce_bytes = [0_u8; AES_GCM_NONCE_LENGTH];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::assume_unique_for_key(nonce_bytes);
        let mut ciphertext = plaintext.as_bytes().to_vec();
        self.key
            .seal_in_place_append_tag(nonce, Aad::from(TOKEN_AAD), &mut ciphertext)
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("OAuth token encryption failed")))?;

        let mut encoded = Vec::with_capacity(AES_GCM_NONCE_LENGTH + ciphertext.len());
        encoded.extend_from_slice(&nonce_bytes);
        encoded.extend_from_slice(&ciphertext);
        Ok(format!(
            "{ENCRYPTED_TOKEN_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(encoded)
        ))
    }

    pub fn decrypt(&self, encrypted: &str) -> ApiResult<String> {
        let encoded = encrypted
            .strip_prefix(ENCRYPTED_TOKEN_PREFIX)
            .ok_or_else(|| {
                ApiError::Internal(anyhow::anyhow!("OAuth token ciphertext version is invalid"))
            })?;
        let payload = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
            ApiError::Internal(anyhow::anyhow!("OAuth token ciphertext is invalid"))
        })?;
        if payload.len() <= AES_GCM_NONCE_LENGTH {
            return Err(ApiError::Internal(anyhow::anyhow!(
                "OAuth token ciphertext is truncated"
            )));
        }

        let nonce_bytes: [u8; AES_GCM_NONCE_LENGTH] = payload[..AES_GCM_NONCE_LENGTH]
            .try_into()
            .expect("nonce slice has fixed length");
        let nonce = Nonce::assume_unique_for_key(nonce_bytes);
        let mut ciphertext = payload[AES_GCM_NONCE_LENGTH..].to_vec();
        let plaintext = self
            .key
            .open_in_place(nonce, Aad::from(TOKEN_AAD), &mut ciphertext)
            .map_err(|_| {
                ApiError::Internal(anyhow::anyhow!("OAuth token authentication failed"))
            })?;

        String::from_utf8(plaintext.to_vec())
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("OAuth token plaintext is invalid")))
    }

    pub async fn encrypt_legacy_github_tokens(&self, pool: &PgPool) -> ApiResult<u64> {
        let mut tx = pool.begin().await?;
        sqlx::query("select pg_advisory_xact_lock($1)")
            .bind(TOKEN_BACKFILL_LOCK_ID)
            .execute(&mut *tx)
            .await?;

        let legacy_tokens: Vec<(Uuid, String)> = sqlx::query_as(
            r#"
            select id, github_access_token
            from user_sessions
            where github_access_token is not null
            order by id
            for update
            "#,
        )
        .fetch_all(&mut *tx)
        .await?;

        for (session_id, plaintext) in &legacy_tokens {
            let encrypted = self.encrypt(plaintext)?;
            sqlx::query(
                r#"
                update user_sessions
                set github_access_token = null,
                    github_access_token_encrypted = $2
                where id = $1
                "#,
            )
            .bind(session_id)
            .bind(encrypted)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            "alter table user_sessions validate constraint user_sessions_no_plaintext_oauth_tokens",
        )
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(legacy_tokens.len() as u64)
    }
}

pub fn digest_session_token(token: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(token.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use sqlx::Executor;

    fn test_cipher(byte: u8) -> TokenCipher {
        TokenCipher::new(&TokenEncryptionKey::from_bytes([byte; 32]))
    }

    #[test]
    fn encrypts_with_random_nonces_and_round_trips() {
        let cipher = test_cipher(7);
        let first = cipher.encrypt("gho_secret_token").expect("encrypt token");
        let second = cipher.encrypt("gho_secret_token").expect("encrypt token");

        assert!(first.starts_with(ENCRYPTED_TOKEN_PREFIX));
        assert_ne!(first, second);
        assert!(!first.contains("gho_secret_token"));
        assert_eq!(
            cipher.decrypt(&first).expect("decrypt token"),
            "gho_secret_token"
        );
        assert_eq!(
            cipher.decrypt(&second).expect("decrypt token"),
            "gho_secret_token"
        );
    }

    #[test]
    fn rejects_tampered_ciphertext_and_the_wrong_key() {
        let cipher = test_cipher(7);
        let encrypted = cipher.encrypt("gho_secret_token").expect("encrypt token");
        assert!(test_cipher(8).decrypt(&encrypted).is_err());

        let mut tampered = encrypted.into_bytes();
        let last = tampered.last_mut().expect("ciphertext byte");
        *last = if *last == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).expect("valid encoded token");

        assert!(cipher.decrypt(&tampered).is_err());
    }

    #[test]
    fn session_token_digest_is_stable_and_does_not_contain_the_token() {
        let token = "a-high-entropy-session-token";
        let digest = digest_session_token(token);

        assert_eq!(digest, digest_session_token(token));
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), 71);
        assert!(!digest.contains(token));
    }

    #[tokio::test]
    #[ignore = "requires a disposable DATABASE_URL postgres"]
    async fn backfills_legacy_tokens_and_clears_plaintext_atomically() {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set for the token backfill integration test");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to token backfill test database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let user_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let github_user_id = 8_000_000_000_i64 + i64::from(rand::random::<u32>());
        let now = Utc::now();
        sqlx::query(
            "insert into users (id, github_user_id, github_login, created_at, updated_at) values ($1, $2, $3, $4, $4)",
        )
        .bind(user_id)
        .bind(github_user_id)
        .bind(format!("token-backfill-{github_user_id}"))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert backfill user");
        let plaintext_session_result = sqlx::query(
            "insert into user_sessions (id, user_id, session_token, expires_at, created_at, revoked_at) values ($1, $2, $3, $4, $5, null)",
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind("plaintext-session-token")
        .bind(now + Duration::hours(1))
        .bind(now)
        .execute(&pool)
        .await;
        assert!(
            plaintext_session_result.is_err(),
            "database constraint must reject plaintext session tokens"
        );
        sqlx::query(
            "alter table user_sessions drop constraint user_sessions_no_plaintext_oauth_tokens",
        )
        .execute(&pool)
        .await
        .expect("temporarily simulate the pre-migration schema");
        sqlx::query(
            r#"
            insert into user_sessions (
              id, user_id, session_token, github_access_token,
              github_access_token_encrypted, expires_at, created_at, revoked_at
            )
            values ($1, $2, $3, $4, null, $5, $6, null)
            "#,
        )
        .bind(session_id)
        .bind(user_id)
        .bind(digest_session_token("backfill-session-token"))
        .bind("gho_plaintext_legacy_token")
        .bind(now + Duration::hours(1))
        .bind(now)
        .execute(&pool)
        .await
        .expect("insert legacy token");
        pool.execute(include_str!(
            "../../migrations/0013_protect_session_tokens.sql"
        ))
        .await
        .expect("reapply token protection migration");

        let cipher = test_cipher(7);
        assert_eq!(
            cipher
                .encrypt_legacy_github_tokens(&pool)
                .await
                .expect("backfill tokens"),
            1
        );
        let (plaintext, encrypted): (Option<String>, Option<String>) = sqlx::query_as(
            "select github_access_token, github_access_token_encrypted from user_sessions where id = $1",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .expect("load protected token");
        assert!(plaintext.is_none());
        let encrypted = encrypted.expect("encrypted token");
        assert_eq!(
            cipher
                .decrypt(&encrypted)
                .expect("decrypt backfilled token"),
            "gho_plaintext_legacy_token"
        );
        let plaintext_constraint_validated: bool = sqlx::query_scalar(
            "select convalidated from pg_constraint where conname = 'user_sessions_no_plaintext_oauth_tokens' and conrelid = 'user_sessions'::regclass",
        )
        .fetch_one(&pool)
        .await
        .expect("load plaintext constraint state");
        assert!(plaintext_constraint_validated);
        assert_eq!(
            cipher
                .encrypt_legacy_github_tokens(&pool)
                .await
                .expect("idempotent backfill"),
            0
        );

        sqlx::query("delete from user_sessions where id = $1")
            .bind(session_id)
            .execute(&pool)
            .await
            .expect("clean session");
        sqlx::query("delete from users where id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("clean user");
    }
}
