#![allow(
    dead_code,
    clippy::too_many_arguments,
    clippy::manual_checked_ops,
    clippy::manual_clamp,
    private_interfaces
)]
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::daemon::engine::config::global_config;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecisionCategory {
    Segmentation,
    Connection,
    Retry,
    Buffer,
    Scheduling,
    Recovery,
    Resume,
    Bandwidth,
    Disk,
    Worker,
    Timeout,
    Throttle,
}

#[derive(Clone, Debug)]
pub struct DecisionContext {
    pub category: DecisionCategory,
    pub host: String,
    pub file_size: u64,
    pub current_speed: u64,
    pub current_connections: u32,
    pub active_downloads: u32,
    pub memory_pressure: f64,
    pub cpu_pressure: f32,
    pub disk_pressure: f64,
    pub server_stability: f32,
    pub is_rate_limited: bool,
    pub consecutive_failures: u32,
    pub supports_range: bool,
    pub supports_resume: bool,
    pub protocol_multiplexed: bool,
    pub rtt_us: u64,
    pub throughput_ceiling: u64,
    pub per_connection_ceiling: u64,
    pub attempted_segments: u32,
    pub completed_segments: u32,
    pub failed_segments: u32,
    pub total_downloaded: u64,
    pub elapsed_secs: f64,
}

impl Default for DecisionContext {
    fn default() -> Self {
        Self {
            category: DecisionCategory::Connection,
            host: String::new(),
            file_size: 0,
            current_speed: 0,
            current_connections: 1,
            active_downloads: 1,
            memory_pressure: 0.0,
            cpu_pressure: 0.0,
            disk_pressure: 0.0,
            server_stability: 0.5,
            is_rate_limited: false,
            consecutive_failures: 0,
            supports_range: false,
            supports_resume: false,
            protocol_multiplexed: false,
            rtt_us: 0,
            throughput_ceiling: 0,
            per_connection_ceiling: 0,
            attempted_segments: 0,
            completed_segments: 0,
            failed_segments: 0,
            total_downloaded: 0,
            elapsed_secs: 0.0,
        }
    }
}

#[derive(Clone, Debug)]
pub enum PolicyDecision {
    Connections {
        target: u32,
        reason: String,
    },
    Segments {
        action: SegmentAction,
        reason: String,
    },
    Retry {
        should_retry: bool,
        delay: Duration,
        reason: String,
    },
    Buffer {
        write_buffer: usize,
        read_buffer: usize,
        flush_interval_ms: u64,
        reason: String,
    },
    Throttle {
        max_bytes_per_sec: Option<u64>,
        reason: String,
    },
    Recovery {
        action: RecoveryAction,
        reason: String,
    },
    Resume {
        should_resume: bool,
        from_byte: u64,
        reason: String,
    },
    Schedule {
        action: ScheduleAction,
        reason: String,
    },
    NoAction {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SegmentAction {
    Add,
    Remove,
    Split(u32),
    Merge(u32, u32),
    Rebalance,
    NoChange,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    RetryConnection,
    ReduceConnections,
    RestartSegment(u32),
    RestartDownload,
    ResumeFromCheckpoint,
    PauseAndRetry(Duration),
    Abort,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScheduleAction {
    Start,
    Pause,
    Resume,
    Prioritize,
    Deprioritize,
    Queue,
}

struct PolicyRecord {
    decision: PolicyDecision,
    timestamp: Instant,
    context_snapshot: String,
}

pub struct PolicyEngine {
    decision_history: Vec<PolicyRecord>,
    max_history: usize,
    rollback_threshold: f64,
    consecutive_worse: HashMap<String, u32>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        Self {
            decision_history: Vec::new(),
            max_history: 1000,
            rollback_threshold: 0.15,
            consecutive_worse: HashMap::new(),
        }
    }

    pub fn decide_connections(&self, ctx: &DecisionContext) -> PolicyDecision {
        let cfg = global_config();
        let max_per_download = cfg.max_connections_per_download;
        let max_total = cfg.max_total_connections;

        if ctx.is_rate_limited {
            let target = ctx.current_connections.saturating_sub(2).max(1);
            return PolicyDecision::Connections {
                target,
                reason: "rate-limited: reducing connections".into(),
            };
        }

        if ctx.consecutive_failures >= 3 {
            let target = (ctx.current_connections / 2).max(1);
            return PolicyDecision::Connections {
                target,
                reason: "repeated failures: halving connections".into(),
            };
        }

        if ctx.memory_pressure > 0.85 {
            let target = ctx.current_connections.saturating_sub(1).max(1);
            return PolicyDecision::Connections {
                target,
                reason: "high memory pressure: reducing connections".into(),
            };
        }

        if ctx.cpu_pressure > 0.9 {
            let target = ctx.current_connections.saturating_sub(1).max(1);
            return PolicyDecision::Connections {
                target,
                reason: "high CPU pressure: reducing connections".into(),
            };
        }

        if ctx.disk_pressure > 0.8 {
            let target = ctx.current_connections.saturating_sub(1).max(1);
            return PolicyDecision::Connections {
                target,
                reason: "disk bottleneck: reducing connections".into(),
            };
        }

        if ctx.protocol_multiplexed {
            let base = if ctx.file_size > 100 * 1024 * 1024 {
                4
            } else if ctx.file_size > 10 * 1024 * 1024 {
                2
            } else {
                1
            };
            let target = base.min(max_per_download);
            if target != ctx.current_connections {
                return PolicyDecision::Connections {
                    target,
                    reason: "multiplexed protocol: optimal connection count".into(),
                };
            }
        }

        if ctx.server_stability < 0.3 && ctx.current_connections > 2 {
            return PolicyDecision::Connections {
                target: 2,
                reason: "unstable server: reducing to minimum".into(),
            };
        }

        if ctx.per_connection_ceiling > 0 && ctx.throughput_ceiling > 0 {
            let ideal = (ctx.throughput_ceiling / ctx.per_connection_ceiling).max(1) as u32;
            let target = ideal.min(max_per_download).min(max_total);
            if (target as i32 - ctx.current_connections as i32).abs() > 1 {
                return PolicyDecision::Connections {
                    target,
                    reason: "throughput-optimal connection count".into(),
                };
            }
        }

        if ctx.current_speed > 0 && ctx.per_connection_ceiling > 0 {
            let utilization = ctx.current_speed as f64 / ctx.per_connection_ceiling as f64;
            if utilization > 0.85 && ctx.current_connections < max_per_download {
                let target = (ctx.current_connections + 1).min(max_per_download);
                return PolicyDecision::Connections {
                    target,
                    reason: "high per-connection utilization: adding connection".into(),
                };
            }
        }

        PolicyDecision::NoAction {
            reason: "connection count optimal".into(),
        }
    }

    pub fn decide_segments(&self, ctx: &DecisionContext) -> PolicyDecision {
        if !ctx.supports_range {
            return PolicyDecision::NoAction {
                reason: "server does not support range requests".into(),
            };
        }

        if ctx.file_size < 1024 * 1024 {
            return PolicyDecision::Segments {
                action: SegmentAction::NoChange,
                reason: "file too small for segmentation".into(),
            };
        }

        let active = ctx
            .attempted_segments
            .saturating_sub(ctx.completed_segments)
            .saturating_sub(ctx.failed_segments);

        if ctx.failed_segments > 0 && active > 1 {
            return PolicyDecision::Segments {
                action: SegmentAction::Merge(0, 1),
                reason: "segment failures detected: merging".into(),
            };
        }

        if ctx.current_speed > 0
            && ctx.per_connection_ceiling > 0
            && ctx.attempted_segments < ctx.current_connections
        {
            let speed_ratio = ctx.current_speed as f64 / ctx.per_connection_ceiling as f64;
            if speed_ratio > 0.8
                && ctx.attempted_segments < global_config().max_connections_per_download
            {
                return PolicyDecision::Segments {
                    action: SegmentAction::Add,
                    reason: "speed approaching ceiling: splitting to parallelize".into(),
                };
            }
        }

        PolicyDecision::Segments {
            action: SegmentAction::NoChange,
            reason: "segmentation is optimal".into(),
        }
    }

    pub fn decide_retry(&self, ctx: &DecisionContext, error: &str) -> PolicyDecision {
        let cfg = global_config();
        let policy = cfg.retry_policy();

        if ctx.consecutive_failures >= policy.max_retries {
            return PolicyDecision::Retry {
                should_retry: false,
                delay: Duration::ZERO,
                reason: "max retries exhausted".into(),
            };
        }

        if ctx.is_rate_limited {
            let delay = Duration::from_secs(30);
            return PolicyDecision::Retry {
                should_retry: true,
                delay,
                reason: "rate limited: cooldown before retry".into(),
            };
        }

        let adapted = policy.adapt_for_error(error);
        let delay = adapted.delay_for_attempt(ctx.consecutive_failures + 1);

        PolicyDecision::Retry {
            should_retry: true,
            delay,
            reason: format!(
                "retry attempt {} with adaptive backoff",
                ctx.consecutive_failures + 1
            ),
        }
    }

    pub fn decide_recovery(&self, ctx: &DecisionContext) -> PolicyDecision {
        if ctx.consecutive_failures == 0 {
            return PolicyDecision::NoAction {
                reason: "no failures".into(),
            };
        }

        if ctx.consecutive_failures == 1 {
            return PolicyDecision::Recovery {
                action: RecoveryAction::RetryConnection,
                reason: "single failure: retry connection".into(),
            };
        }

        if ctx.consecutive_failures <= 3 {
            return PolicyDecision::Recovery {
                action: RecoveryAction::ReduceConnections,
                reason: "multiple failures: reduce connections".into(),
            };
        }

        if ctx.consecutive_failures <= 5 {
            if ctx.supports_resume && ctx.total_downloaded > 0 {
                return PolicyDecision::Recovery {
                    action: RecoveryAction::ResumeFromCheckpoint,
                    reason: "persistent failures: resume from last checkpoint".into(),
                };
            }
            return PolicyDecision::Recovery {
                action: RecoveryAction::RestartDownload,
                reason: "persistent failures: restart download".into(),
            };
        }

        PolicyDecision::Recovery {
            action: RecoveryAction::Abort,
            reason: "excessive failures: aborting".into(),
        }
    }

    pub fn decide_buffer(&self, ctx: &DecisionContext) -> PolicyDecision {
        let cfg = global_config();
        let mut write_buf = cfg.write_buffer_bytes;
        let mut read_buf = cfg.read_buffer_bytes;
        let mut flush_ms = cfg.flush_interval_ms;

        if ctx.memory_pressure > 0.85 {
            write_buf = (write_buf / 2).max(32 * 1024);
            read_buf = (read_buf / 2).max(16 * 1024);
            flush_ms = 500;
        } else if ctx.memory_pressure > 0.6 {
            write_buf = (write_buf * 3 / 4).max(32 * 1024);
            read_buf = (read_buf * 3 / 4).max(16 * 1024);
            flush_ms = 200;
        }

        if ctx.current_speed > 10 * 1024 * 1024 {
            write_buf = (write_buf * 2).min(4 * 1024 * 1024);
            read_buf = (read_buf * 2).min(2 * 1024 * 1024);
            flush_ms = 10;
        } else if ctx.current_speed > 1024 * 1024 {
            write_buf = (write_buf * 3 / 2).min(2 * 1024 * 1024);
            read_buf = (read_buf * 3 / 2).min(1024 * 1024);
            flush_ms = 50;
        }

        PolicyDecision::Buffer {
            write_buffer: write_buf,
            read_buffer: read_buf,
            flush_interval_ms: flush_ms,
            reason: "adaptive buffer sizing".into(),
        }
    }

    pub fn decide_throttle(&self, ctx: &DecisionContext) -> PolicyDecision {
        if ctx.is_rate_limited {
            if let Some(ceiling) = ctx.throughput_ceiling.checked_mul(80).map(|v| v / 100) {
                if ceiling > 0 {
                    return PolicyDecision::Throttle {
                        max_bytes_per_sec: Some(ceiling),
                        reason: "rate limited: throttling to 80% of ceiling".into(),
                    };
                }
            }
        }

        if ctx.memory_pressure > 0.9 {
            return PolicyDecision::Throttle {
                max_bytes_per_sec: Some(ctx.current_speed * 70 / 100),
                reason: "critical memory: throttling to 70%".into(),
            };
        }

        PolicyDecision::NoAction {
            reason: "no throttle needed".into(),
        }
    }

    pub fn record_decision(&mut self, decision: &PolicyDecision, context: &str) {
        self.decision_history.push(PolicyRecord {
            decision: decision.clone(),
            timestamp: Instant::now(),
            context_snapshot: context.to_string(),
        });
        if self.decision_history.len() > self.max_history {
            self.decision_history
                .drain(0..self.decision_history.len() - self.max_history);
        }
    }

    pub fn should_rollback(&mut self, host: &str, performance_delta: f64) -> bool {
        if performance_delta < -self.rollback_threshold {
            let count = self.consecutive_worse.entry(host.to_string()).or_insert(0);
            *count += 1;
            if *count >= 3 {
                self.consecutive_worse.insert(host.to_string(), 0);
                return true;
            }
        } else {
            self.consecutive_worse.insert(host.to_string(), 0);
        }
        false
    }

    pub fn recent_decisions(&self) -> &[PolicyRecord] {
        &self.decision_history
    }

    pub fn decision_count(&self) -> usize {
        self.decision_history.len()
    }
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_ctx() -> DecisionContext {
        DecisionContext {
            category: DecisionCategory::Connection,
            host: "example.com".into(),
            file_size: 100 * 1024 * 1024,
            current_speed: 1_000_000,
            current_connections: 4,
            active_downloads: 1,
            memory_pressure: 0.3,
            cpu_pressure: 0.2,
            disk_pressure: 0.1,
            server_stability: 0.8,
            is_rate_limited: false,
            consecutive_failures: 0,
            supports_range: true,
            supports_resume: true,
            protocol_multiplexed: false,
            rtt_us: 20_000,
            throughput_ceiling: 10_000_000,
            per_connection_ceiling: 2_500_000,
            attempted_segments: 4,
            completed_segments: 0,
            failed_segments: 0,
            total_downloaded: 0,
            elapsed_secs: 5.0,
        }
    }

    #[test]
    fn new_policy_engine_starts_empty() {
        let pe = PolicyEngine::new();
        assert_eq!(pe.decision_count(), 0);
    }

    #[test]
    fn connections_reduced_on_rate_limit() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.is_rate_limited = true;
        ctx.current_connections = 8;
        match pe.decide_connections(&ctx) {
            PolicyDecision::Connections { target, .. } => assert!(target < 8),
            _ => panic!("expected Connections decision"),
        }
    }

    #[test]
    fn connections_reduced_on_failures() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.consecutive_failures = 5;
        ctx.current_connections = 8;
        match pe.decide_connections(&ctx) {
            PolicyDecision::Connections { target, .. } => assert!(target <= 4),
            _ => panic!("expected Connections decision"),
        }
    }

    #[test]
    fn connections_reduced_on_memory_pressure() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.memory_pressure = 0.9;
        ctx.current_connections = 4;
        match pe.decide_connections(&ctx) {
            PolicyDecision::Connections { target, .. } => assert!(target < 4),
            _ => panic!("expected Connections decision"),
        }
    }

    #[test]
    fn connections_optimal_when_no_issues() {
        let pe = PolicyEngine::new();
        let ctx = base_ctx();
        match pe.decide_connections(&ctx) {
            PolicyDecision::NoAction { .. } => {}
            _ => panic!("expected NoAction when conditions are good"),
        }
    }

    #[test]
    fn segments_no_change_for_small_file() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.file_size = 500_000;
        match pe.decide_segments(&ctx) {
            PolicyDecision::Segments {
                action: SegmentAction::NoChange,
                ..
            } => {}
            _ => panic!("expected NoChange for small file"),
        }
    }

    #[test]
    fn segments_no_action_without_range() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.supports_range = false;
        match pe.decide_segments(&ctx) {
            PolicyDecision::NoAction { .. } => {}
            _ => panic!("expected NoAction without range"),
        }
    }

    #[test]
    fn retry_respects_max_retries() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.consecutive_failures = 100;
        match pe.decide_retry(&ctx, "timeout") {
            PolicyDecision::Retry { should_retry, .. } => assert!(!should_retry),
            _ => panic!("expected Retry decision"),
        }
    }

    #[test]
    fn retry_cooldown_on_rate_limit() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.is_rate_limited = true;
        match pe.decide_retry(&ctx, "429") {
            PolicyDecision::Retry {
                should_retry,
                delay,
                ..
            } => {
                assert!(should_retry);
                assert!(delay >= Duration::from_secs(25));
            }
            _ => panic!("expected Retry decision"),
        }
    }

    #[test]
    fn recovery_escalates_with_failures() {
        let pe = PolicyEngine::new();
        let ctx_1 = DecisionContext {
            consecutive_failures: 1,
            ..base_ctx()
        };
        let ctx_3 = DecisionContext {
            consecutive_failures: 3,
            ..base_ctx()
        };
        let ctx_6 = DecisionContext {
            consecutive_failures: 6,
            ..base_ctx()
        };

        match pe.decide_recovery(&ctx_1) {
            PolicyDecision::Recovery {
                action: RecoveryAction::RetryConnection,
                ..
            } => {}
            _ => panic!("1 failure should be RetryConnection"),
        }
        match pe.decide_recovery(&ctx_3) {
            PolicyDecision::Recovery {
                action: RecoveryAction::ReduceConnections,
                ..
            } => {}
            _ => panic!("3 failures should be ReduceConnections"),
        }
        match pe.decide_recovery(&ctx_6) {
            PolicyDecision::Recovery { .. } => {}
            _ => panic!("6 failures should trigger recovery"),
        }
    }

    #[test]
    fn buffer_reduces_under_memory_pressure() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.memory_pressure = 0.95;
        match pe.decide_buffer(&ctx) {
            PolicyDecision::Buffer { write_buffer, .. } => {
                assert!(write_buffer <= 256 * 1024);
            }
            _ => panic!("expected Buffer decision"),
        }
    }

    #[test]
    fn buffer_increases_on_fast_network() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.current_speed = 50 * 1024 * 1024;
        match pe.decide_buffer(&ctx) {
            PolicyDecision::Buffer { write_buffer, .. } => {
                assert!(write_buffer > global_config().write_buffer_bytes);
            }
            _ => panic!("expected Buffer decision"),
        }
    }

    #[test]
    fn throttle_on_rate_limit() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.is_rate_limited = true;
        ctx.throughput_ceiling = 10_000_000;
        match pe.decide_throttle(&ctx) {
            PolicyDecision::Throttle {
                max_bytes_per_sec, ..
            } => {
                assert!(max_bytes_per_sec.is_some());
                assert!(max_bytes_per_sec.unwrap() < 10_000_000);
            }
            _ => panic!("expected Throttle decision"),
        }
    }

    #[test]
    fn record_decision_stores_history() {
        let mut pe = PolicyEngine::new();
        let decision = PolicyDecision::NoAction {
            reason: "test".into(),
        };
        pe.record_decision(&decision, "test context");
        assert_eq!(pe.decision_count(), 1);
    }

    #[test]
    fn should_rollback_after_consecutive_worse() {
        let mut pe = PolicyEngine::new();
        assert!(!pe.should_rollback("host.com", -0.2));
        assert!(!pe.should_rollback("host.com", -0.2));
        assert!(pe.should_rollback("host.com", -0.2));
    }

    #[test]
    fn should_not_rollback_on_improvement() {
        let mut pe = PolicyEngine::new();
        pe.should_rollback("host.com", -0.2);
        pe.should_rollback("host.com", -0.2);
        assert!(!pe.should_rollback("host.com", 0.3));
    }

    #[test]
    fn no_action_when_no_memory_pressure() {
        let pe = PolicyEngine::new();
        let mut ctx = base_ctx();
        ctx.memory_pressure = 0.0;
        match pe.decide_throttle(&ctx) {
            PolicyDecision::NoAction { .. } => {}
            _ => panic!("expected NoAction when memory is fine"),
        }
    }
}
