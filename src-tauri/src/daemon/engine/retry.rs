use std::time::Duration;

#[derive(Clone, Debug)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub backoff_multiplier: f64,
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 5,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(120),
            backoff_multiplier: 2.0,
            jitter: true,
        }
    }
}

impl RetryPolicy {
    pub fn aggressive() -> Self {
        Self {
            max_retries: 10,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(300),
            backoff_multiplier: 1.5,
            jitter: true,
        }
    }

    pub fn conservative() -> Self {
        Self {
            max_retries: 3,
            base_delay: Duration::from_secs(5),
            max_delay: Duration::from_secs(60),
            backoff_multiplier: 3.0,
            jitter: false,
        }
    }

    pub fn no_retry() -> Self {
        Self {
            max_retries: 0,
            base_delay: Duration::ZERO,
            max_delay: Duration::ZERO,
            backoff_multiplier: 1.0,
            jitter: false,
        }
    }

    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return Duration::ZERO;
        }
        let exp = (attempt - 1) as f64;
        let base = self.base_delay.as_secs_f64() * self.backoff_multiplier.powf(exp);
        let capped = base.min(self.max_delay.as_secs_f64());
        if self.jitter {
            let jitter_range = capped * 0.25;
            let jitter = (attempt as u64 * 7919) as f64 % jitter_range;
            Duration::from_secs_f64((capped + jitter).max(0.1))
        } else {
            Duration::from_secs_f64(capped)
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct RetryState {
    pub attempt: u32,
    pub last_error: Option<String>,
    pub total_retries: u32,
}

impl RetryState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_failure(&mut self, error: String) {
        self.attempt += 1;
        self.total_retries += 1;
        self.last_error = Some(error);
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
        self.last_error = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn assert_duration_eq(actual: Duration, expected: Duration, msg: &str) {
        let epsilon = Duration::from_millis(50);
        let diff = if actual > expected {
            actual - expected
        } else {
            expected - actual
        };
        assert!(
            diff <= epsilon,
            "{msg}: expected ~{expected:?}, got {actual:?}"
        );
    }

    // --- delay_for_attempt tests ---

    #[test]
    fn delay_for_attempt_zero_always_returns_zero() {
        let policies = [
            RetryPolicy::default(),
            RetryPolicy::aggressive(),
            RetryPolicy::conservative(),
            RetryPolicy::no_retry(),
        ];
        for policy in &policies {
            assert_eq!(
                policy.delay_for_attempt(0),
                Duration::ZERO,
                "attempt 0 must return ZERO"
            );
        }
    }

    #[test]
    fn default_policy_delays_grow_exponentially() {
        let policy = RetryPolicy::default(); // base=1s, mult=2.0, jitter=true
        let d1 = policy.delay_for_attempt(1);
        let d2 = policy.delay_for_attempt(2);
        let d3 = policy.delay_for_attempt(3);
        assert_duration_eq(d1, Duration::from_secs(1), "attempt 1");
        assert_duration_eq(d2, Duration::from_secs(2), "attempt 2");
        assert_duration_eq(d3, Duration::from_secs(4), "attempt 3");
        assert!(d2 > d1, "delays must grow");
        assert!(d3 > d2, "delays must grow");
    }

    #[test]
    fn conservative_policy_exact_deterministic_delays() {
        let policy = RetryPolicy::conservative(); // base=5s, mult=3.0, no jitter
        assert_duration_eq(policy.delay_for_attempt(1), Duration::from_secs(5), "a1=5s");
        assert_duration_eq(
            policy.delay_for_attempt(2),
            Duration::from_secs(15),
            "a2=15s",
        );
        assert_duration_eq(
            policy.delay_for_attempt(3),
            Duration::from_secs(45),
            "a3=45s",
        );
    }

    #[test]
    fn conservative_policy_has_no_jitter_is_deterministic() {
        let policy = RetryPolicy::conservative();
        let first: Vec<_> = (1..=5).map(|a| policy.delay_for_attempt(a)).collect();
        let second: Vec<_> = (1..=5).map(|a| policy.delay_for_attempt(a)).collect();
        assert_eq!(first, second, "no-jitter delays must be deterministic");
    }

    #[test]
    fn aggressive_policy_smaller_base_and_more_retries() {
        let policy = RetryPolicy::aggressive();
        assert_eq!(policy.max_retries, 10);
        assert_eq!(policy.base_delay, Duration::from_millis(500));
        assert!(policy.base_delay < RetryPolicy::default().base_delay);

        let d1 = policy.delay_for_attempt(1);
        assert_duration_eq(d1, Duration::from_millis(500), "a1=500ms");
    }

    #[test]
    fn no_retry_policy_delays_are_zero() {
        let policy = RetryPolicy::no_retry();
        assert_eq!(policy.max_retries, 0);
        for attempt in 0..=5 {
            assert_eq!(
                policy.delay_for_attempt(attempt),
                Duration::ZERO,
                "no_retry delay at attempt {attempt} must be ZERO"
            );
        }
    }

    #[test]
    fn delays_capped_at_max_delay() {
        let policy = RetryPolicy::conservative(); // max_delay=60s, no jitter
        let attempt_4 = policy.delay_for_attempt(4); // raw: 5*3^3=135s → capped
        assert_duration_eq(attempt_4, Duration::from_secs(60), "capped at 60s");
        let attempt_10 = policy.delay_for_attempt(10); // raw: 5*3^9=98415s → capped
        assert_duration_eq(attempt_10, Duration::from_secs(60), "still capped");
    }

    #[test]
    fn delays_never_negative_with_jitter() {
        let policy = RetryPolicy::default();
        for attempt in 1..=20 {
            let d = policy.delay_for_attempt(attempt);
            assert!(
                d >= Duration::from_millis(100),
                "attempt {attempt}: delay {d:?} must be >= 100ms"
            );
        }
    }

    #[test]
    fn aggressive_delays_also_capped() {
        let policy = RetryPolicy::aggressive(); // max_delay=300s
        let max_with_jitter = Duration::from_secs_f64(300.0 * 1.25 + 0.1);
        for attempt in 1..=20 {
            let d = policy.delay_for_attempt(attempt);
            assert!(
                d <= max_with_jitter,
                "attempt {attempt}: {d:?} exceeds max_delay + jitter"
            );
        }
    }

    // --- RetryState tests ---

    #[test]
    fn retry_state_new_defaults() {
        let state = RetryState::new();
        assert_eq!(state.attempt, 0);
        assert_eq!(state.total_retries, 0);
        assert!(state.last_error.is_none());
    }

    #[test]
    fn record_failure_increments_counters_and_stores_error() {
        let mut state = RetryState::new();
        state.record_failure("connection refused".into());
        assert_eq!(state.attempt, 1);
        assert_eq!(state.total_retries, 1);
        assert_eq!(state.last_error.as_deref(), Some("connection refused"));
    }

    #[test]
    fn reset_clears_attempt_and_error_but_not_total_retries() {
        let mut state = RetryState::new();
        state.record_failure("err1".into());
        state.record_failure("err2".into());
        state.reset();
        assert_eq!(state.attempt, 0, "attempt reset to 0");
        assert!(state.last_error.is_none(), "last_error cleared");
        assert_eq!(state.total_retries, 2, "total_retries preserved");
    }

    #[test]
    fn multiple_record_failure_accumulates() {
        let mut state = RetryState::new();
        for i in 1..=10 {
            state.record_failure(format!("error {i}"));
            assert_eq!(state.attempt, i);
            assert_eq!(state.total_retries, i);
            assert_eq!(
                state.last_error.as_deref(),
                Some(format!("error {i}").as_str())
            );
        }
    }

    #[test]
    fn reset_then_record_failure_works_normally() {
        let mut state = RetryState::new();
        state.record_failure("err".into());
        state.reset();
        state.record_failure("new err".into());
        assert_eq!(state.attempt, 1);
        assert_eq!(state.total_retries, 2, "total_retries never decrements");
        assert_eq!(state.last_error.as_deref(), Some("new err"));
    }

    #[test]
    fn retry_state_is_clone() {
        let mut state = RetryState::new();
        state.record_failure("err".into());
        let cloned = state.clone();
        assert_eq!(state.attempt, cloned.attempt);
        assert_eq!(state.total_retries, cloned.total_retries);
        assert_eq!(state.last_error, cloned.last_error);
    }
}
