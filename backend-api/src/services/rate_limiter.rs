use std::{collections::HashMap, sync::Mutex};

use chrono::Utc;

use crate::error::{ApiError, ApiResult};

#[derive(Clone)]
pub struct RateLimiter {
    inner: std::sync::Arc<Mutex<HashMap<String, RateWindow>>>,
}

#[derive(Debug, Clone)]
struct RateWindow {
    started_at_unix: i64,
    count: u32,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn check(&self, key: &str, max: u32, window_secs: i64) -> ApiResult<()> {
        let now = Utc::now().timestamp();
        let mut map = self.inner.lock().map_err(|_| ApiError::Forbidden)?;
        let entry = map.entry(key.to_string()).or_insert(RateWindow {
            started_at_unix: now,
            count: 0,
        });

        if now - entry.started_at_unix >= window_secs {
            entry.started_at_unix = now;
            entry.count = 0;
        }

        if entry.count >= max {
            return Err(ApiError::Conflict("RATE_LIMITED"));
        }

        entry.count += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_limit() {
        let limiter = RateLimiter::new();
        limiter.check("u:1", 2, 60).expect("first");
        limiter.check("u:1", 2, 60).expect("second");
        let err = limiter.check("u:1", 2, 60).expect_err("third should fail");
        assert!(matches!(err, ApiError::Conflict("RATE_LIMITED")));
    }

    #[test]
    fn resets_counter_when_window_has_elapsed() {
        let limiter = RateLimiter::new();
        limiter.check("u:1", 1, 0).expect("first");
        limiter
            .check("u:1", 1, 0)
            .expect("window reset should allow second call");
    }

    #[test]
    fn tracks_limits_per_key() {
        let limiter = RateLimiter::new();
        limiter.check("u:1", 1, 60).expect("first key");
        let err = limiter
            .check("u:1", 1, 60)
            .expect_err("first key should be limited");
        assert!(matches!(err, ApiError::Conflict("RATE_LIMITED")));
        limiter
            .check("u:2", 1, 60)
            .expect("second key should not be limited");
    }
}
