use std::collections::HashMap;
use std::sync::Mutex;

use super::types::{CapabilityState, ProbeResult, ServerProfile, StabilityAnalysis};

pub struct ServerProfileStore {
    profiles: Mutex<HashMap<String, ServerProfile>>,
    probe_history: Mutex<HashMap<String, Vec<ProbeRecord>>>,
}

struct ProbeRecord {
    success: bool,
    response_time_ms: f64,
    rate_limited: bool,
    timestamp: String,
}

impl Clone for ProbeRecord {
    fn clone(&self) -> Self {
        Self {
            success: self.success,
            response_time_ms: self.response_time_ms,
            rate_limited: self.rate_limited,
            timestamp: self.timestamp.clone(),
        }
    }
}

impl ServerProfileStore {
    pub fn new() -> Self {
        Self {
            profiles: Mutex::new(HashMap::new()),
            probe_history: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, host: &str) -> Option<ServerProfile> {
        self.profiles.lock().ok().and_then(|m| m.get(host).cloned())
    }

    pub fn record_probe(&self, host: &str, result: &ProbeResult, range_confirmed: bool) {
        let success = result.status_code >= 200 && result.status_code < 400;
        let rate_limited = result.status_code == 429;
        let response_time_ms = result.duration.as_secs_f64() * 1000.0;

        // Record the probe.
        {
            if let Ok(mut history) = self.probe_history.lock() {
                let records = history.entry(host.to_string()).or_insert_with(Vec::new);
                records.push(ProbeRecord {
                    success,
                    response_time_ms,
                    rate_limited,
                    timestamp: chrono::Local::now()
                        .naive_local()
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string(),
                });
                // Keep last 100 records.
                if records.len() > 100 {
                    records.drain(0..records.len() - 100);
                }
            }
        }

        // Update the profile.
        let mut profiles = match self.profiles.lock() {
            Ok(p) => p,
            Err(_) => return,
        };
        let profile = profiles
            .entry(host.to_string())
            .or_insert_with(ServerProfile::default);

        profile.host = host.to_string();
        profile.total_probes += 1;
        if success {
            profile.successful_probes += 1;
            profile.consecutive_failures = 0;
        } else {
            profile.consecutive_failures += 1;
        }
        profile.historical_error_rate =
            1.0 - (profile.successful_probes as f64 / profile.total_probes as f64);
        profile.last_observed = chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();

        // Update rolling average response time.
        let alpha = 0.3;
        profile.avg_response_time_ms =
            alpha * response_time_ms + (1.0 - alpha) * profile.avg_response_time_ms;

        // Rate limit detection.
        if rate_limited {
            profile.rate_limit_detected = true;
        }

        // Range support.
        if range_confirmed {
            profile.range_support = CapabilityState::Confirmed;
        }

        // Stability score: weighted combination of success rate, consecutive failures,
        // and rate limit detection.
        let success_rate = profile.successful_probes as f64 / profile.total_probes.max(1) as f64;
        let failure_penalty = (profile.consecutive_failures as f64 * 0.1).min(1.0);
        let rate_limit_penalty = if profile.rate_limit_detected {
            0.2
        } else {
            0.0
        };
        profile.stability_score =
            (success_rate - failure_penalty - rate_limit_penalty).clamp(0.0, 1.0);

        // Adaptive connection recommendation based on stability.
        profile.recommended_connections = if profile.stability_score > 0.8
            && profile.range_support == CapabilityState::Confirmed
        {
            8
        } else if profile.stability_score > 0.5 {
            4
        } else {
            1
        };
    }

    pub fn analyze(&self, host: &str) -> StabilityAnalysis {
        let history = self
            .probe_history
            .lock()
            .ok()
            .and_then(|m| m.get(host).cloned())
            .unwrap_or_default();

        if history.is_empty() {
            return StabilityAnalysis::default();
        }

        let total = history.len() as f64;
        let successes = history.iter().filter(|r| r.success).count() as f64;
        let rate_limited = history.iter().filter(|r| r.rate_limited).count() as f64;

        let response_times: Vec<f64> = history.iter().map(|r| r.response_time_ms).collect();
        let mean = response_times.iter().sum::<f64>() / response_times.len().max(1) as f64;
        let variance = response_times
            .iter()
            .map(|t| (t - mean).powi(2))
            .sum::<f64>()
            / response_times.len().max(1) as f64;

        let error_rate = 1.0 - (successes / total);
        let rate_limit_freq = rate_limited / total;

        // Check consecutive failures at the end of the history.
        let mut consecutive_failures = 0u32;
        for record in history.iter().rev() {
            if !record.success {
                consecutive_failures += 1;
            } else {
                break;
            }
        }

        let connection_failures = consecutive_failures as f64 / total;
        let overall =
            (successes / total - rate_limit_freq * 0.3 - connection_failures * 0.2).clamp(0.0, 1.0);

        StabilityAnalysis {
            response_stability: if variance < 1000.0 { 1.0 } else { 0.5 },
            connection_stability: 1.0 - connection_failures,
            timeout_frequency: 0.0,
            speed_variance: variance,
            error_rate,
            rate_limiting_detected: rate_limit_freq > 0.05,
            retry_frequency: 0.0,
            connection_failure_frequency: connection_failures,
            overall_stability: overall,
        }
    }
}
