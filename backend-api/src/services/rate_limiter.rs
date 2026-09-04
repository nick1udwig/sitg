use std::{collections::HashMap, sync::Mutex};

use chrono::Utc;

use crate::error::{ApiError, ApiResult};

const STALE_ENTRY_CLEANUP_INTERVAL_SECS: i64 = 60;

#[derive(Clone)]
pub struct RateLimiter {
    inner: std::sync::Arc<Mutex<RateLimiterState>>,
}

#[derive(Default)]
struct RateLimiterState {
    windows: HashMap<String, RateWindow>,
    next_cleanup_at_unix: i64,
}

#[derive(Debug, Clone)]
struct RateWindow {
    expires_at_unix: i64,
    count: u32,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(RateLimiterState::default())),
        }
    }

    pub fn check(&self, key: &str, max: u32, window_secs: i64) -> ApiResult<()> {
        self.check_at(key, max, window_secs, Utc::now().timestamp())
    }

    fn check_at(&self, key: &str, max: u32, window_secs: i64, now: i64) -> ApiResult<()> {
        let mut state = self.inner.lock().map_err(|_| ApiError::Forbidden)?;

        if now >= state.next_cleanup_at_unix {
            state
                .windows
                .retain(|_, window| window.expires_at_unix > now);
            state.next_cleanup_at_unix = now.saturating_add(STALE_ENTRY_CLEANUP_INTERVAL_SECS);
        }

        let entry = state.windows.entry(key.to_string()).or_insert(RateWindow {
            expires_at_unix: now.saturating_add(window_secs),
            count: 0,
        });

        if now >= entry.expires_at_unix {
            entry.expires_at_unix = now.saturating_add(window_secs);
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
        limiter.check_at("u:1", 1, 60, 100).expect("first");
        limiter
            .check_at("u:1", 1, 60, 160)
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

    #[test]
    fn periodically_evicts_expired_keys_but_keeps_live_windows() {
        let limiter = RateLimiter::new();
        limiter.check_at("expired:1", 1, 10, 100).expect("key 1");
        limiter.check_at("expired:2", 1, 20, 100).expect("key 2");
        limiter.check_at("live", 1, 120, 100).expect("live key");

        {
            let state = limiter.inner.lock().expect("rate limiter state");
            assert_eq!(state.windows.len(), 3);
        }

        limiter
            .check_at("trigger", 1, 60, 160)
            .expect("cleanup trigger");

        let state = limiter.inner.lock().expect("rate limiter state");
        assert_eq!(state.windows.len(), 2);
        assert!(state.windows.contains_key("live"));
        assert!(state.windows.contains_key("trigger"));
        assert!(!state.windows.contains_key("expired:1"));
        assert!(!state.windows.contains_key("expired:2"));
    }
}
