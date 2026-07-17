use super::types::{ErrorCategory, ResolutionError, RetryDecision, RetryStrategy};
use std::time::Duration;

const MAX_RETRY_ATTEMPTS: u32 = 5;
const MAX_RETRY_BUDGET: u32 = 10;
const CIRCUIT_BREAKER_THRESHOLD: u32 = 3;
const BASE_BACKOFF_MS: u64 = 1000;
const MAX_BACKOFF_MS: u64 = 30_000;

pub fn decide_retry(
    error: &ResolutionError,
    attempt_count: u32,
    total_failures: u32,
    stability_score: f64,
) -> RetryDecision {
    // Never retry non-retryable errors.
    if !error.retryable {
        return RetryDecision {
            should_retry: false,
            delay: Duration::ZERO,
            max_attempts: MAX_RETRY_ATTEMPTS,
            attempt_count,
            strategy: RetryStrategy::DoNotRetry,
            reason: format!("Error category {:?} is not retryable", error.category),
            budget_remaining: 0,
            circuit_breaker_active: false,
        };
    }

    // Circuit breaker: too many consecutive failures.
    if total_failures >= CIRCUIT_BREAKER_THRESHOLD && stability_score < 0.3 {
        return RetryDecision {
            should_retry: false,
            delay: Duration::ZERO,
            max_attempts: MAX_RETRY_ATTEMPTS,
            attempt_count,
            strategy: RetryStrategy::CircuitBreaker,
            reason: format!(
                "Circuit breaker active: {total_failures} consecutive failures, stability {stability_score:.2}"
            ),
            budget_remaining: 0,
            circuit_breaker_active: true,
        };
    }

    // Budget check.
    if attempt_count >= MAX_RETRY_ATTEMPTS {
        return RetryDecision {
            should_retry: false,
            delay: Duration::ZERO,
            max_attempts: MAX_RETRY_ATTEMPTS,
            attempt_count,
            strategy: RetryStrategy::DoNotRetry,
            reason: format!("Max attempts ({MAX_RETRY_ATTEMPTS}) reached"),
            budget_remaining: 0,
            circuit_breaker_active: false,
        };
    }

    // Use server-provided Retry-After if available.
    if let Some(retry_after) = error.retry_after {
        return RetryDecision {
            should_retry: true,
            delay: retry_after,
            max_attempts: MAX_RETRY_ATTEMPTS,
            attempt_count,
            strategy: RetryStrategy::FixedDelay,
            reason: format!("Server provided Retry-After: {}s", retry_after.as_secs()),
            budget_remaining: MAX_RETRY_ATTEMPTS.saturating_sub(attempt_count + 1),
            circuit_breaker_active: false,
        };
    }

    // Adaptive strategy based on error category.
    let (strategy, base_delay) = match error.category {
        ErrorCategory::RateLimited => (
            RetryStrategy::ExponentialBackoffWithJitter,
            Duration::from_secs(30),
        ),
        ErrorCategory::Timeout | ErrorCategory::ConnectionFailure => {
            let delay_ms = calculate_backoff(attempt_count, stability_score);
            (
                RetryStrategy::ExponentialBackoffWithJitter,
                Duration::from_millis(delay_ms),
            )
        }
        ErrorCategory::HttpFailure if error.http_status.is_some_and(|s| s >= 500) => (
            RetryStrategy::ExponentialBackoff,
            Duration::from_millis(calculate_backoff(attempt_count, stability_score)),
        ),
        ErrorCategory::DnsFailure => (
            RetryStrategy::ExponentialBackoffWithJitter,
            Duration::from_millis(calculate_backoff(attempt_count, stability_score)),
        ),
        _ => (
            RetryStrategy::ExponentialBackoff,
            Duration::from_millis(calculate_backoff(attempt_count, stability_score)),
        ),
    };

    RetryDecision {
        should_retry: true,
        delay: base_delay,
        max_attempts: MAX_RETRY_ATTEMPTS,
        attempt_count,
        strategy,
        reason: format!(
            "Retryable {:?} error, attempt {}/{}",
            error.category,
            attempt_count + 1,
            MAX_RETRY_ATTEMPTS
        ),
        budget_remaining: MAX_RETRY_ATTEMPTS.saturating_sub(attempt_count + 1),
        circuit_breaker_active: false,
    }
}

fn calculate_backoff(attempt: u32, stability_score: f64) -> u64 {
    // Exponential backoff with jitter, adjusted by stability.
    let base = BASE_BACKOFF_MS as f64;
    let exponential = base * 2f64.powi(attempt as i32);

    // Jitter: random factor between 0.5 and 1.5.
    // Use a simple deterministic pseudo-random based on attempt for reproducibility.
    let jitter_factor = 1.0 + ((attempt as f64 * 7.31).sin() * 0.5);

    // Stability adjustment: less stable = longer backoff.
    let stability_factor = 1.0 + (1.0 - stability_score);

    let delay = exponential * jitter_factor * stability_factor;
    (delay as u64).min(MAX_BACKOFF_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retryable_error(category: ErrorCategory) -> ResolutionError {
        ResolutionError {
            category,
            phase: super::super::types::ErrorPhase::HttpRequest,
            message: "test".to_string(),
            http_status: None,
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: true,
            retry_after: None,
            user_action_required: false,
        }
    }

    #[test]
    fn non_retryable_errors_are_not_retried() {
        let mut err = retryable_error(ErrorCategory::NotFound);
        err.retryable = false;
        let decision = decide_retry(&err, 0, 0, 1.0);
        assert!(!decision.should_retry);
    }

    #[test]
    fn circuit_breaker_kicks_in() {
        let err = retryable_error(ErrorCategory::Timeout);
        let decision = decide_retry(&err, 2, 3, 0.2);
        assert!(!decision.should_retry);
        assert!(decision.circuit_breaker_active);
    }

    #[test]
    fn respects_max_attempts() {
        let err = retryable_error(ErrorCategory::ConnectionFailure);
        let decision = decide_retry(&err, 5, 0, 1.0);
        assert!(!decision.should_retry);
    }
}
