use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

// Break ties between calls made within the same system-clock tick. The retry
// path is concurrent, so a monotonic sequence is mixed with time before it is
// reduced to the jitter range.
static JITTER_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn retry_jitter_entropy() -> u128 {
    let sequence = JITTER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    // SplitMix64 finalizer: inexpensive, deterministic mixing with good bit
    // diffusion for consecutive inputs and no external RNG dependency.
    let mut value = time ^ sequence.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    u128::from(value ^ (value >> 31))
}

use super::config::global_config;

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
        let cfg = global_config();
        Self {
            max_retries: cfg.max_retries,
            base_delay: Duration::from_millis(cfg.base_retry_delay_ms),
            max_delay: Duration::from_millis(cfg.max_retry_delay_ms),
            backoff_multiplier: cfg.backoff_multiplier,
            jitter: true,
        }
    }
}

impl RetryPolicy {
    pub const fn aggressive() -> Self {
        Self {
            max_retries: 10,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(300),
            backoff_multiplier: 1.5,
            jitter: true,
        }
    }

    pub const fn conservative() -> Self {
        Self {
            max_retries: 3,
            base_delay: Duration::from_secs(5),
            max_delay: Duration::from_secs(60),
            backoff_multiplier: 3.0,
            jitter: false,
        }
    }

    pub const fn no_retry() -> Self {
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
        let exp = f64::from(attempt - 1);
        // Configuration can be imported or user-edited. Reject non-finite or
        // non-positive multipliers rather than letting NaN/∞ leak into float
        // duration conversion and make retry timing unpredictable.
        let multiplier = if self.backoff_multiplier.is_finite() && self.backoff_multiplier > 0.0 {
            self.backoff_multiplier
        } else {
            1.0
        };
        let raw = self.base_delay.as_secs_f64() * multiplier.powf(exp);
        let max_secs = self.max_delay.as_secs_f64();
        let capped = if raw.is_finite() {
            raw.min(max_secs)
        } else {
            max_secs
        };
        if self.jitter {
            // Symmetric jitter: ±12.5% of the capped delay, using integer
            // math on nanoseconds so the modulo is unbiased and never zero
            // for a non-trivial range. This both thundering-herd mitigates
            // (tasks at the same attempt land on different delays) and avoids
            // the old positive-only bias that made every retry longer.
            let capped_nanos = (capped * 1e9) as u128;
            let half_range = capped_nanos / 8; // ±12.5% → 25% spread
            let entropy = retry_jitter_entropy();
            if half_range > 0 {
                let offset = (entropy % (half_range * 2 + 1)) as i128 - half_range as i128;
                let jittered = (capped_nanos as i128 + offset).max(0) as u128;
                let secs = jittered as f64 / 1e9;
                Duration::from_secs_f64(secs.max(0.001))
            } else {
                Duration::from_secs_f64(capped)
            }
        } else {
            Duration::from_secs_f64(capped)
        }
    }

    #[allow(dead_code)]
    pub const fn should_retry(&self, attempt: u32) -> bool {
        attempt < self.max_retries
    }

    pub fn adapt_for_error(&self, error: &str) -> Self {
        let lower = error.to_ascii_lowercase();
        if lower.contains("timeout") || lower.contains("timed out") {
            Self {
                base_delay: self.base_delay.saturating_mul(2),
                max_delay: self.max_delay.saturating_mul(3) / 2,
                ..self.clone()
            }
        } else if lower.contains("connection refused") || lower.contains("connection reset") {
            Self {
                base_delay: self.base_delay,
                max_delay: self.max_delay,
                backoff_multiplier: (self.backoff_multiplier * 1.5).min(5.0),
                ..self.clone()
            }
        } else if lower.contains("429") || lower.contains("too many requests") {
            Self {
                base_delay: self.base_delay.saturating_mul(3),
                max_delay: self.max_delay.saturating_mul(2),
                ..self.clone()
            }
        } else if lower.contains("503") || lower.contains("service unavailable") {
            Self {
                base_delay: self.base_delay.saturating_mul(2),
                max_delay: self.max_delay.saturating_mul(2),
                max_retries: self.max_retries.saturating_add(5),
                ..self.clone()
            }
        } else {
            self.clone()
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
        self.attempt = self.attempt.saturating_add(1);
        self.total_retries = self.total_retries.saturating_add(1);
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
                                             // With symmetric jitter (±12.5%) the exact values are no longer
                                             // deterministic; assert the growth trend and the ±12.5% band instead.
        let d1 = policy.delay_for_attempt(1);
        let d2 = policy.delay_for_attempt(2);
        let d3 = policy.delay_for_attempt(3);
        let in_band = |d: Duration, expected_secs: f64| {
            let lo = (expected_secs * 0.875 * 1e9) as u128;
            let hi = (expected_secs * 1.125 * 1e9) as u128;
            let nanos = d.as_nanos();
            nanos >= lo && nanos <= hi
        };
        assert!(in_band(d1, 1.0), "a1={d1:?} outside 1s±12.5%");
        assert!(in_band(d2, 2.0), "a2={d2:?} outside 2s±12.5%");
        assert!(in_band(d3, 4.0), "a3={d3:?} outside 4s±12.5%");
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

        // With symmetric jitter the first delay sits in the ±12.5% band
        // around 500ms rather than at the exact value.
        let d1 = policy.delay_for_attempt(1);
        let lo = (500.0 * 0.875) as u128 * 1_000_000; // 437.5ms in ns
        let hi = (500.0 * 1.125) as u128 * 1_000_000; // 562.5ms in ns
        assert!(
            d1.as_nanos() >= lo && d1.as_nanos() <= hi,
            "a1={d1:?} outside 500ms±12.5%"
        );
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

    #[test]
    fn jitter_is_symmetric_and_varied() {
        // M1/L20 regression: jitter must be non-zero, varied across samples,
        // and symmetric around the capped delay (not positive-only).
        let policy = RetryPolicy::default(); // jitter enabled
        let mut samples: Vec<Duration> = (0..1000).map(|_| policy.delay_for_attempt(5)).collect();
        samples.sort();
        let min_d = samples[0];
        let max_d = *samples.last().unwrap();
        let median = samples[samples.len() / 2];
        // Symmetry: every value must stay within the theoretical ±12.5%
        // envelope around the capped base delay. Comparing the full spread to
        // a sampled median was flaky: a valid random median can sit slightly
        // below the exact centre, making a valid 25% spread look excessive.
        let capped_nanos = policy
            .base_delay
            .as_nanos()
            .saturating_mul(u128::from(policy.backoff_multiplier.powi(4) as u64))
            .min(policy.max_delay.as_nanos());
        let half_range = capped_nanos / 8;
        let center_nanos = (min_d.as_nanos() + max_d.as_nanos()) / 2;
        let spread = max_d.as_nanos().saturating_sub(min_d.as_nanos());
        assert!(
            spread > 0,
            "jitter must produce varied delays (min={min_d:?}, max={max_d:?})"
        );
        assert!(
            min_d.as_nanos() >= capped_nanos.saturating_sub(half_range)
                && max_d.as_nanos() <= capped_nanos.saturating_add(half_range),
            "jitter escaped ±12.5% envelope around {capped_nanos}ns: [{min_d:?}, {max_d:?}]"
        );
        // The median must sit near the middle of the range (±20% of spread).
        let median_offset = median.as_nanos().abs_diff(center_nanos);
        assert!(
            median_offset <= spread * 2 / 10,
            "jitter is biased: median {median:?} far from center of [{min_d:?}, {max_d:?}]"
        );
        // And some samples must fall strictly below the median and some above.
        let below = samples.iter().filter(|d| **d < median).count();
        let above = samples.iter().filter(|d| **d > median).count();
        assert!(
            below > 0 && above > 0,
            "jitter must be symmetric (below={below}, above={above})"
        );
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

    #[test]
    fn should_retry_within_limit() {
        let policy = RetryPolicy {
            max_retries: 5,
            ..RetryPolicy::default()
        };
        assert!(policy.should_retry(0));
        assert!(policy.should_retry(4));
        assert!(!policy.should_retry(5));
    }

    #[test]
    fn adapt_for_error_timeout_increases_delay() {
        let policy = RetryPolicy::default();
        let adapted = policy.adapt_for_error("Connection timed out");
        assert!(adapted.base_delay > policy.base_delay);
        assert!(adapted.max_delay > policy.max_delay);
    }

    #[test]
    fn adapt_for_error_rate_limit_increases_delay_significantly() {
        let policy = RetryPolicy::default();
        let adapted = policy.adapt_for_error("HTTP 429 Too Many Requests");
        assert!(adapted.base_delay > policy.base_delay);
    }

    #[test]
    fn adapt_for_error_service_unavailable_increases_retries() {
        let policy = RetryPolicy::default();
        let adapted = policy.adapt_for_error("HTTP 503 Service Unavailable");
        assert!(adapted.max_retries > policy.max_retries);
    }

    #[test]
    fn retry_policy_handles_invalid_backoff_and_saturates_error_adaptation() {
        let invalid = RetryPolicy {
            backoff_multiplier: f64::NAN,
            base_delay: Duration::from_secs(2),
            max_delay: Duration::from_secs(10),
            jitter: false,
            ..RetryPolicy::default()
        };
        assert_eq!(invalid.delay_for_attempt(2), Duration::from_secs(2));

        let maximal = RetryPolicy {
            max_retries: u32::MAX,
            base_delay: Duration::MAX,
            max_delay: Duration::MAX,
            ..RetryPolicy::default()
        };
        let adapted = maximal.adapt_for_error("HTTP 503 Service Unavailable");
        assert_eq!(adapted.max_retries, u32::MAX);
        assert_eq!(adapted.base_delay, Duration::MAX);
        assert_eq!(adapted.max_delay, Duration::MAX);
    }

    #[test]
    fn retry_state_counters_saturate() {
        let mut state = RetryState {
            attempt: u32::MAX,
            total_retries: u32::MAX,
            last_error: None,
        };
        state.record_failure("overflow-safe".to_owned());
        assert_eq!(state.attempt, u32::MAX);
        assert_eq!(state.total_retries, u32::MAX);
    }

    #[test]
    fn adapt_for_error_connection_refused_increases_backoff() {
        let policy = RetryPolicy::default();
        let adapted = policy.adapt_for_error("Connection refused");
        assert!(adapted.backoff_multiplier >= policy.backoff_multiplier);
    }

    #[test]
    fn adapt_for_unknown_error_returns_clone() {
        let policy = RetryPolicy::default();
        let adapted = policy.adapt_for_error("unknown error");
        assert_eq!(adapted.max_retries, policy.max_retries);
        assert_eq!(adapted.base_delay, policy.base_delay);
    }
}
