#![allow(dead_code)]
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::daemon::engine::policy_engine::{
    DecisionContext, PolicyDecision, PolicyEngine, RecoveryAction,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    Degraded { reason: String },
    Critical { reason: String },
    Failed { reason: String },
}

#[derive(Clone, Debug)]
pub struct HealthSnapshot {
    pub status: HealthStatus,
    pub uptime_secs: u64,
    pub total_recoveries: u32,
    pub current_consecutive_failures: u32,
    pub last_recovery: Option<Instant>,
    pub active_warnings: Vec<String>,
}

struct FailureRecord {
    timestamp: Instant,
    error: String,
    host: String,
    recovery_applied: String,
    succeeded: bool,
}

pub struct SelfHealer {
    policy_engine: Arc<Mutex<PolicyEngine>>,
    failure_history: VecDeque<FailureRecord>,
    recovery_counts: HashMap<String, u32>,
    max_history: usize,
    started_at: Instant,
    last_recovery: Option<Instant>,
    total_recoveries: u32,
    max_recoveries_per_minute: u32,
    recovery_window: Duration,
    recovery_window_start: Instant,
}

impl SelfHealer {
    pub fn new(policy_engine: Arc<Mutex<PolicyEngine>>) -> Self {
        Self {
            policy_engine,
            failure_history: VecDeque::new(),
            recovery_counts: HashMap::new(),
            max_history: 500,
            started_at: Instant::now(),
            last_recovery: None,
            total_recoveries: 0,
            max_recoveries_per_minute: 20,
            recovery_window: Duration::from_secs(60),
            recovery_window_start: Instant::now(),
        }
    }

    pub fn on_failure(&mut self, host: &str, error: &str, ctx: &DecisionContext) -> PolicyDecision {
        self.failure_history.push_back(FailureRecord {
            timestamp: Instant::now(),
            error: error.to_string(),
            host: host.to_string(),
            recovery_applied: String::new(),
            succeeded: false,
        });
        if self.failure_history.len() > self.max_history {
            self.failure_history.pop_front();
        }

        *self.recovery_counts.entry(host.to_string()).or_insert(0) += 1;

        if !self.can_recover() {
            return PolicyDecision::Recovery {
                action: RecoveryAction::Abort,
                reason: "recovery rate exceeded: too many recoveries in window".into(),
            };
        }

        let decision = {
            let pe = self.policy_engine.lock().unwrap();
            pe.decide_recovery(ctx)
        };

        if let PolicyDecision::Recovery { ref action, .. } = decision {
            self.total_recoveries += 1;
            self.last_recovery = Some(Instant::now());
            if let Some(last) = self.failure_history.back_mut() {
                last.recovery_applied = format!("{:?}", action);
            }
        }

        decision
    }

    pub fn on_success(&mut self, host: &str) {
        self.recovery_counts.remove(host);
    }

    fn can_recover(&self) -> bool {
        let window_start = Instant::now() - self.recovery_window;
        let recent = self
            .failure_history
            .iter()
            .filter(|r| r.timestamp >= window_start && !r.succeeded)
            .count() as u32;
        recent < self.max_recoveries_per_minute
    }

    pub fn health_status(&self) -> HealthStatus {
        let recent_failures = self
            .failure_history
            .iter()
            .filter(|r| r.timestamp.elapsed() < Duration::from_secs(60))
            .count() as u32;

        if recent_failures == 0 {
            HealthStatus::Healthy
        } else if recent_failures <= 3 {
            HealthStatus::Degraded {
                reason: format!("{} failures in last 60s", recent_failures),
            }
        } else if recent_failures <= 10 {
            HealthStatus::Critical {
                reason: format!("{} failures in last 60s", recent_failures),
            }
        } else {
            HealthStatus::Failed {
                reason: format!("{} failures in last 60s", recent_failures),
            }
        }
    }

    pub fn snapshot(&self) -> HealthSnapshot {
        let active_warnings = self
            .recovery_counts
            .iter()
            .filter(|(_, &count)| count >= 3)
            .map(|(host, count)| format!("{}: {} consecutive failures", host, count))
            .collect();

        HealthSnapshot {
            status: self.health_status(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            total_recoveries: self.total_recoveries,
            current_consecutive_failures: self.failure_history.len() as u32,
            last_recovery: self.last_recovery,
            active_warnings,
        }
    }

    pub fn reset_host(&mut self, host: &str) {
        self.recovery_counts.remove(host);
        self.failure_history.retain(|r| r.host != host);
    }

    pub fn total_recoveries(&self) -> u32 {
        self.total_recoveries
    }

    pub fn host_failure_count(&self, host: &str) -> u32 {
        self.recovery_counts.get(host).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::engine::policy_engine::PolicyEngine;

    fn default_ctx() -> DecisionContext {
        DecisionContext {
            category: crate::daemon::engine::policy_engine::DecisionCategory::Connection,
            host: "test.com".into(),
            file_size: 50 * 1024 * 1024,
            current_speed: 1_000_000,
            current_connections: 4,
            active_downloads: 1,
            memory_pressure: 0.2,
            cpu_pressure: 0.1,
            disk_pressure: 0.1,
            server_stability: 0.8,
            is_rate_limited: false,
            consecutive_failures: 1,
            supports_range: true,
            supports_resume: true,
            protocol_multiplexed: false,
            rtt_us: 20_000,
            throughput_ceiling: 10_000_000,
            per_connection_ceiling: 2_500_000,
            attempted_segments: 1,
            completed_segments: 0,
            failed_segments: 0,
            total_downloaded: 0,
            elapsed_secs: 2.0,
        }
    }

    #[test]
    fn new_self_healer_starts_healthy() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let sh = SelfHealer::new(pe);
        assert_eq!(sh.health_status(), HealthStatus::Healthy);
    }

    #[test]
    fn single_failure_triggers_recovery() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let mut sh = SelfHealer::new(pe);
        let ctx = default_ctx();
        let decision = sh.on_failure("test.com", "timeout", &ctx);
        match decision {
            PolicyDecision::Recovery { .. } => {}
            _ => panic!("expected Recovery decision on failure"),
        }
    }

    #[test]
    fn on_success_resets_host() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let mut sh = SelfHealer::new(pe);
        let ctx = default_ctx();
        sh.on_failure("test.com", "err1", &ctx);
        sh.on_failure("test.com", "err2", &ctx);
        assert_eq!(sh.host_failure_count("test.com"), 2);
        sh.on_success("test.com");
        assert_eq!(sh.host_failure_count("test.com"), 0);
    }

    #[test]
    fn snapshot_tracks_recoveries() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let mut sh = SelfHealer::new(pe);
        let ctx = default_ctx();
        sh.on_failure("test.com", "err", &ctx);
        let snap = sh.snapshot();
        assert!(snap.total_recoveries >= 1);
    }

    #[test]
    fn reset_host_clears_failures() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let mut sh = SelfHealer::new(pe);
        let ctx = default_ctx();
        sh.on_failure("test.com", "err", &ctx);
        assert_eq!(sh.host_failure_count("test.com"), 1);
        sh.reset_host("test.com");
        assert_eq!(sh.host_failure_count("test.com"), 0);
    }

    #[test]
    fn multiple_failures_increase_count() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let mut sh = SelfHealer::new(pe);
        let ctx = default_ctx();
        for _ in 0..5 {
            sh.on_failure("test.com", "err", &ctx);
        }
        assert_eq!(sh.host_failure_count("test.com"), 5);
        assert_eq!(sh.total_recoveries(), 5);
    }

    #[test]
    fn health_degrades_with_failures() {
        let pe = Arc::new(Mutex::new(PolicyEngine::new()));
        let mut sh = SelfHealer::new(pe);
        let ctx = default_ctx();
        sh.on_failure("a.com", "e", &ctx);
        sh.on_failure("b.com", "e", &ctx);
        sh.on_failure("c.com", "e", &ctx);
        match sh.health_status() {
            HealthStatus::Degraded { .. } => {}
            _ => panic!("expected Degraded after multiple failures"),
        }
    }
}
