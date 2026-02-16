use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;

#[derive(thiserror::Error, Debug)]
pub enum ApiError {
    #[error("unauthenticated")]
    Unauthenticated,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("validation error: {0}")]
    Validation(String),
    #[error("price unavailable")]
    PriceUnavailable,
    #[error("conflict: {0}")]
    Conflict(&'static str),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorPayload,
}

#[derive(Serialize)]
struct ErrorPayload {
    code: String,
    message: String,
}

impl ApiError {
    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    fn as_code(&self) -> &'static str {
        match self {
            ApiError::Unauthenticated => "UNAUTHENTICATED",
            ApiError::Forbidden => "FORBIDDEN",
            ApiError::NotFound => "NOT_FOUND",
            ApiError::Validation(_) => "VALIDATION_ERROR",
            ApiError::PriceUnavailable => "PRICE_UNAVAILABLE",
            ApiError::Conflict("WALLET_HAS_STAKE") => "WALLET_HAS_STAKE",
            ApiError::Conflict(_) => "CONFLICT",
            ApiError::Db(_) | ApiError::Internal(_) => "INTERNAL_ERROR",
        }
    }

    fn as_status(&self) -> StatusCode {
        match self {
            ApiError::Unauthenticated => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::Validation(_) => StatusCode::BAD_REQUEST,
            ApiError::PriceUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Db(_) | ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = self.as_status();
        let message = self.to_string();
        let body = ErrorBody {
            error: ErrorPayload {
                code: self.as_code().to_string(),
                message,
            },
        };
        (status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, response::IntoResponse};
    use serde_json::Value;

    async fn error_payload(err: ApiError) -> (StatusCode, Value) {
        let response = err.into_response();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response bytes");
        let payload: Value = serde_json::from_slice(&bytes).expect("json body");
        (status, payload)
    }

    #[tokio::test]
    async fn maps_wallet_has_stake_conflict_to_specific_code() {
        let (status, payload) = error_payload(ApiError::Conflict("WALLET_HAS_STAKE")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(payload["error"]["code"], "WALLET_HAS_STAKE");
    }

    #[tokio::test]
    async fn maps_generic_conflict_to_conflict_code() {
        let (status, payload) = error_payload(ApiError::Conflict("RATE_LIMITED")).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(payload["error"]["code"], "CONFLICT");
    }

    #[tokio::test]
    async fn maps_internal_error_to_internal_status_and_code() {
        let (status, payload) = error_payload(ApiError::Internal(anyhow::anyhow!("boom"))).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(payload["error"]["code"], "INTERNAL_ERROR");
    }
}
