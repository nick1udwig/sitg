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
