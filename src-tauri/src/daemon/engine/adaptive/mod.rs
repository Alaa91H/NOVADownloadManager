#![allow(
    dead_code,
    clippy::manual_clamp,
    clippy::manual_checked_ops,
    clippy::too_many_arguments
)]
pub mod buffer_manager;
pub mod convergence;
pub mod profile_store;
pub mod protocol_adapter;
pub mod resource_monitor;
pub mod segment_controller;
pub mod server_profiler;

use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use convergence::ConvergenceDetector;
use protocol_adapter::ProtocolAdapter;
use resource_monitor::ResourceMonitor;
use segment_controller::SegmentController;
use server_profiler::ProtocolVersion;

use crate::daemon::engine::chunk_manager::ChunkManager;
use crate::daemon::engine::config::{global_config, MAX_CONNECTIONS_PER_DOWNLOAD};

pub use buffer_manager::BufferManager;

/// Telemetry covers the engine's absolute safety ceiling, so every live
/// connection remains visible to convergence and backoff decisions.
pub const MAX_TRACKED_CONNECTIONS: usize = MAX_CONNECTIONS_PER_DOWNLOAD as usize;

#[derive(Clone, Debug)]
pub struct AdaptiveThresholds {
    pub speed_high_threshold: u64,
    pub speed_low_threshold: u64,
    pub stall_threshold_ms: u64,
    pub eval_interval_ms: u64,
    pub max_adjustments_per_minute: u32,
}

impl Default for AdaptiveThresholds {
    fn default() -> Self {
        Self {
            speed_high_threshold: 5 * 1024 * 1024,
            speed_low_threshold: 100 * 1024,
            stall_threshold_ms: 5000,
            eval_interval_ms: 2000,
            max_adjustments_per_minute: 15,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ConnectionTelemetry {
    pub bytes_downloaded: u64,
    pub rtt_us: u64,
    pub dns_us: u64,
    pub tls_us: u64,
    pub ttfb_us: u64,
    pub last_speed: u64,
    pub stall_count: u32,
    pub error_count: u32,
    pub http_status: u16,
    pub alive: bool,
}

#[derive(Clone, Debug, Default)]
pub struct AggregateTelemetry {
    pub total_bytes: u64,
    pub total_speed: u64,
    pub peak_speed: u64,
    pub active_connections: u32,
    pub completed_connections: u32,
    pub failed_connections: u32,
}

#[derive(Clone, Debug, Default)]
pub struct TelemetrySnapshot {
    pub connections: Vec<ConnectionTelemetry>,
    pub aggregate: AggregateTelemetry,
    pub timestamp_millis: u64,
}

pub struct TelemetryBus {
    connections: Vec<ConnectionSlot>,
    aggregate_speed: AtomicU64,
    aggregate_peak: AtomicU64,
    active_conns: AtomicU32,
    completed_conns: AtomicU32,
    failed_conns: AtomicU32,
    start_time: Instant,
}

struct ConnectionSlot {
    bytes: AtomicU64,
    rtt_us: AtomicU64,
    dns_us: AtomicU64,
    tls_us: AtomicU64,
    ttfb_us: AtomicU64,
    speed: AtomicU64,
    stall_count: AtomicU32,
    error_count: AtomicU32,
    http_status: AtomicU16,
    alive: AtomicBool,
}

impl ConnectionSlot {
    const fn new() -> Self {
        Self {
            bytes: AtomicU64::new(0),
            rtt_us: AtomicU64::new(0),
            dns_us: AtomicU64::new(0),
            tls_us: AtomicU64::new(0),
            ttfb_us: AtomicU64::new(0),
            speed: AtomicU64::new(0),
            stall_count: AtomicU32::new(0),
            error_count: AtomicU32::new(0),
            http_status: AtomicU16::new(0),
            alive: AtomicBool::new(false),
        }
    }
}

impl TelemetryBus {
    pub fn new() -> Self {
        let mut connections = Vec::with_capacity(MAX_TRACKED_CONNECTIONS);
        for _ in 0..MAX_TRACKED_CONNECTIONS {
            connections.push(ConnectionSlot::new());
        }
        Self {
            connections,
            aggregate_speed: AtomicU64::new(0),
            aggregate_peak: AtomicU64::new(0),
            active_conns: AtomicU32::new(0),
            completed_conns: AtomicU32::new(0),
            failed_conns: AtomicU32::new(0),
            start_time: Instant::now(),
        }
    }

    pub fn report_bytes(&self, conn_id: usize, bytes: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .bytes
                .store(bytes, Ordering::Relaxed);
        }
    }

    pub fn report_speed(&self, conn_id: usize, speed: u64) {
        // M9: store the slot speed only. The aggregate is recomputed in
        // snapshot() from the live slots, which is race-free — the old
        // fetch_add/fetch_sub delta could mis-apply under concurrent updates
        // and even underflow u64 in release builds.
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .speed
                .store(speed, Ordering::Relaxed);
            self.aggregate_peak.fetch_max(speed, Ordering::Relaxed);
        }
    }

    pub fn report_rtt(&self, conn_id: usize, rtt_us: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .rtt_us
                .store(rtt_us, Ordering::Relaxed);
        }
    }

    pub fn report_handshake(&self, conn_id: usize, dns_us: u64, tls_us: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .dns_us
                .store(dns_us, Ordering::Relaxed);
            self.connections[conn_id]
                .tls_us
                .store(tls_us, Ordering::Relaxed);
        }
    }

    pub fn report_ttfb(&self, conn_id: usize, ttfb_us: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .ttfb_us
                .store(ttfb_us, Ordering::Relaxed);
        }
    }

    pub fn report_stall(&self, conn_id: usize) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .stall_count
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn report_error(&self, conn_id: usize) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .error_count
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn report_http_status(&self, conn_id: usize, status: u16) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id]
                .http_status
                .store(status, Ordering::Relaxed);
        }
    }

    /// Set the alive flag for a connection slot. Returns the previous value
    /// so callers can detect state transitions (H16: a double `false` must
    /// not decrement active_conns twice).
    pub fn set_alive(&self, conn_id: usize, alive: bool) -> bool {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            let prev = self.connections[conn_id]
                .alive
                .swap(alive, Ordering::Relaxed);
            if prev != alive {
                if alive {
                    self.active_conns.fetch_add(1, Ordering::Relaxed);
                } else {
                    self.active_conns.fetch_sub(1, Ordering::Relaxed);
                }
            }
            prev
        } else {
            false
        }
    }

    pub fn mark_completed(&self, conn_id: usize) {
        self.set_alive(conn_id, false);
        self.completed_conns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn mark_failed(&self, conn_id: usize) {
        self.set_alive(conn_id, false);
        self.failed_conns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> TelemetrySnapshot {
        let mut connections = Vec::with_capacity(MAX_TRACKED_CONNECTIONS);
        for slot in &self.connections {
            connections.push(ConnectionTelemetry {
                bytes_downloaded: slot.bytes.load(Ordering::Relaxed),
                rtt_us: slot.rtt_us.load(Ordering::Relaxed),
                dns_us: slot.dns_us.load(Ordering::Relaxed),
                tls_us: slot.tls_us.load(Ordering::Relaxed),
                ttfb_us: slot.ttfb_us.load(Ordering::Relaxed),
                last_speed: slot.speed.load(Ordering::Relaxed),
                stall_count: slot.stall_count.load(Ordering::Relaxed),
                error_count: slot.error_count.load(Ordering::Relaxed),
                http_status: slot.http_status.load(Ordering::Relaxed),
                alive: slot.alive.load(Ordering::Relaxed),
            });
        }
        let total_bytes: u64 = connections.iter().map(|c| c.bytes_downloaded).sum();
        // M9: recompute the aggregate speed from the live slots instead of
        // reading a delta-maintained counter (which could underflow and went
        // stale when a connection finished).
        let total_speed: u64 = connections.iter().map(|c| c.last_speed).sum();
        TelemetrySnapshot {
            connections,
            aggregate: AggregateTelemetry {
                total_bytes,
                total_speed,
                peak_speed: self.aggregate_peak.load(Ordering::Relaxed),
                active_connections: self.active_conns.load(Ordering::Relaxed),
                completed_connections: self.completed_conns.load(Ordering::Relaxed),
                failed_connections: self.failed_conns.load(Ordering::Relaxed),
            },
            timestamp_millis: self.start_time.elapsed().as_millis() as u64,
        }
    }

    pub fn reset(&self) {
        for slot in &self.connections {
            slot.bytes.store(0, Ordering::Relaxed);
            slot.rtt_us.store(0, Ordering::Relaxed);
            slot.dns_us.store(0, Ordering::Relaxed);
            slot.tls_us.store(0, Ordering::Relaxed);
            slot.ttfb_us.store(0, Ordering::Relaxed);
            slot.speed.store(0, Ordering::Relaxed);
            slot.stall_count.store(0, Ordering::Relaxed);
            slot.error_count.store(0, Ordering::Relaxed);
            slot.http_status.store(0, Ordering::Relaxed);
            slot.alive.store(false, Ordering::Relaxed);
        }
        self.aggregate_speed.store(0, Ordering::Relaxed);
        self.aggregate_peak.store(0, Ordering::Relaxed);
        self.active_conns.store(0, Ordering::Relaxed);
        self.completed_conns.store(0, Ordering::Relaxed);
        self.failed_conns.store(0, Ordering::Relaxed);
    }
}

#[derive(Clone, Debug)]
pub enum AdaptationAction {
    AdjustConnections {
        old_count: u32,
        new_count: u32,
    },
    SplitSegment {
        segment_id: u32,
        at_byte: u64,
    },
    MergeSegments {
        a: u32,
        b: u32,
    },
    Redistribute {
        from_seg: u32,
        to_seg: u32,
        bytes: u64,
    },
    ThrottleAll {
        per_conn_bytes_per_sec: u64,
    },
    NoChange,
}

#[derive(Clone, Debug)]
pub struct AdaptationDecision {
    pub target_connections: u32,
    pub actions: Vec<AdaptationAction>,
    pub per_connection_limit: Option<u64>,
    pub reason: String,
    pub confidence: f32,
}

impl Default for AdaptationDecision {
    fn default() -> Self {
        Self {
            target_connections: 0,
            actions: Vec::new(),
            per_connection_limit: None,
            reason: String::new(),
            confidence: 0.0,
        }
    }
}

pub struct AdaptiveEngine {
    pub profiler: server_profiler::ServerProfiler,
    pub convergence: ConvergenceDetector,
    pub resources: ResourceMonitor,
    pub protocol: ProtocolAdapter,
    pub segment_ctrl: SegmentController,
    pub chunk_manager: ChunkManager,
    pub buffer_manager: BufferManager,
    host: String,
    total_size: u64,
    current_connections: u32,
    last_decision: AdaptationDecision,
    last_tick: Instant,
    /// Time of the last upward connection adjustment. Growing geometry needs a
    /// settling window before another growth can be trusted.
    last_growth: Instant,
    tick_interval: Duration,
}

impl AdaptiveEngine {
    pub fn new(
        host: String,
        total_size: u64,
        connections: u32,
        protocol: ProtocolVersion,
        min_segment_bytes: u64,
    ) -> Self {
        let max_connections = global_config().max_connections_per_download;
        let now = Instant::now();
        let mut segment_ctrl = SegmentController::new(total_size, min_segment_bytes);
        segment_ctrl.set_max_segments(max_connections);
        Self {
            profiler: server_profiler::ServerProfiler::new(),
            convergence: ConvergenceDetector::new(),
            resources: ResourceMonitor::new(),
            protocol: ProtocolAdapter::new(protocol),
            segment_ctrl,
            chunk_manager: ChunkManager::new(total_size),
            buffer_manager: BufferManager::new(),
            host,
            total_size,
            current_connections: connections.clamp(1, max_connections),
            last_decision: AdaptationDecision::default(),
            last_tick: now.checked_sub(Duration::from_secs(10)).unwrap_or(now),
            last_growth: now.checked_sub(Duration::from_secs(10)).unwrap_or(now),
            tick_interval: Duration::from_secs(2),
        }
    }

    pub fn with_profile(
        host: String,
        total_size: u64,
        connections: u32,
        profile: server_profiler::ServerProfile,
        min_segment_bytes: u64,
    ) -> Self {
        let protocol = profile.protocol;
        let mut engine = Self::new(
            host.clone(),
            total_size,
            connections,
            protocol,
            min_segment_bytes,
        );
        let p = engine.profiler.get_or_create(&host);
        p.protocol = profile.protocol;
        p.supports_range = profile.supports_range;
        p.supports_resume = profile.supports_resume;
        p.tls_version = profile.tls_version;
        p.alpn_protocol = profile.alpn_protocol;
        p.server_software = profile.server_software;
        p.initial_rtt_us = profile.initial_rtt_us;
        p.handshake_time_us = profile.handshake_time_us;
        p.rtt_samples = profile.rtt_samples;
        p.throughput_samples = profile.throughput_samples;
        p.median_rtt_us = profile.median_rtt_us;
        p.p95_rtt_us = profile.p95_rtt_us;
        p.throughput_ceiling = profile.throughput_ceiling;
        p.per_connection_ceiling = profile.per_connection_ceiling;
        p.optimal_connections = profile.optimal_connections;
        p.stability_score = profile.stability_score;
        p.total_probes = profile.total_probes;
        p.successful_probes = profile.successful_probes;
        engine
    }

    pub fn set_tick_interval(&mut self, interval: Duration) {
        self.tick_interval = interval;
    }

    pub fn seed_profile(
        &mut self,
        protocol: ProtocolVersion,
        supports_range: bool,
        supports_resume: bool,
        tls_version: Option<String>,
        alpn: Option<String>,
        server_header: Option<String>,
        initial_rtt_us: u64,
        handshake_us: u64,
        ttfb_us: u64,
    ) {
        self.protocol = ProtocolAdapter::new(protocol);
        self.profiler.seed_from_preflight(
            &self.host,
            protocol,
            supports_range,
            supports_resume,
            tls_version,
            alpn,
            server_header,
            initial_rtt_us,
            handshake_us,
            ttfb_us,
        );
    }

    pub fn evaluate(&mut self, bus: &TelemetryBus) -> AdaptationDecision {
        let now = Instant::now();
        if now.duration_since(self.last_tick) < self.tick_interval {
            return self.last_decision.clone();
        }
        self.last_tick = now;

        let snapshot = bus.snapshot();
        self.resources.sample();

        for conn in &snapshot.connections {
            if conn.alive {
                self.profiler.update_from_telemetry(
                    &self.host,
                    conn.rtt_us,
                    conn.last_speed,
                    conn.http_status,
                    false,
                );
                if conn.error_count > 0 {
                    for _ in 0..conn.error_count.min(10) {
                        self.profiler
                            .update_from_telemetry(&self.host, 0, 0, 0, true);
                    }
                }
            }
        }

        let agg_speed = snapshot
            .connections
            .iter()
            .filter(|c| c.alive)
            .map(|c| c.last_speed)
            .sum::<u64>();

        self.convergence
            .record_speed(agg_speed, snapshot.aggregate.active_connections);

        let mut decision = AdaptationDecision {
            target_connections: self.current_connections,
            actions: Vec::new(),
            per_connection_limit: None,
            reason: String::new(),
            confidence: 0.5,
        };

        if self.protocol.is_single_stream() {
            decision.reason = "single-stream protocol, no connection adjustment".into();
            decision.confidence = 1.0;
            self.last_decision = decision.clone();
            return decision;
        }

        let mut target;

        let host_profile = self.profiler.get(&self.host);
        let profile_conns = if let Some(profile) = host_profile {
            profile.recommended_connections(self.total_size, self.resources.cpu_count())
        } else {
            let (min_c, max_c) = self.protocol.connection_range(self.resources.cpu_count());
            ((min_c + max_c) / 2).max(min_c)
        };

        let (_, max_proto) = self.protocol.connection_range(self.resources.cpu_count());
        let resource_max = self.resources.max_safe_connections();
        let effective_max = max_proto.min(resource_max);

        target = profile_conns.clamp(1, effective_max);

        // Expand additively rather than jumping to a resource-derived ceiling.
        // A large one-tick geometry rewrite can interrupt healthy range writes
        // and make a fast host look unstable. The step grows with the current
        // level (2→4→6→9…) and remains reversible by the existing backoff
        // guards, eventually allowing >32 only after sustained evaluations.
        let mut growth_settling = false;
        if target > self.current_connections {
            // Let the new geometry write and report at least several samples
            // before any further expansion. This avoids overlapping rebuilds
            // from turning a healthy range transfer into a corrupt merge.
            if now.duration_since(self.last_growth) < Duration::from_secs(10) {
                target = self.current_connections;
                growth_settling = true;
                decision.reason.push_str("[growth-settling] ");
            } else {
                let growth_step = (self.current_connections / 2).max(2);
                let gradual_ceiling = self.current_connections.saturating_add(growth_step);
                if target > gradual_ceiling {
                    target = gradual_ceiling.min(effective_max);
                    decision.reason.push_str("[gradual-growth] ");
                }
            }
        }

        if self.resources.cpu_saturated() {
            target = target.saturating_sub(1).max(1);
            decision.reason.push_str("[cpu-saturated] ");
        }

        if let Some(profile) = host_profile {
            if profile.is_rate_limited() {
                target = target.saturating_sub(2).max(1);
                decision.reason.push_str("[rate-limited] ");
            }
            if profile.stability_score < 0.3 && target > 2 {
                target = (target / 2).max(2);
                decision.reason.push_str("[unstable-server] ");
            }
        }

        if self.resources.disk_bottleneck() {
            let disk_budget = self.resources.disk_write_budget(target);
            if disk_budget > 0 && disk_budget < 1024 * 1024 {
                target = target.saturating_sub(1).max(1);
                decision.reason.push_str("[disk-bottleneck] ");
            }
        }

        // Diminishing returns: once recent adjustments stopped producing
        // meaningful speed gains, don't keep growing the connection count.
        if self.convergence.diminishing_returns() && target > self.current_connections {
            target = self.current_connections;
            decision.reason.push_str("[diminishing-returns] ");
        }

        // A declining speed trend across the recent sample window means more
        // connections are hurting throughput; back off one connection.
        if self.convergence.speed_trend(8) < -0.1 && target > 1 {
            target = target.saturating_sub(1).max(1);
            decision.reason.push_str("[speed-declining] ");
        }

        // M22: evaluate the segment plan exactly once per tick, then use it
        // on either path below (the old code called evaluate() twice).
        // Segment-only changes are geometry rewrites too. Suppress them
        // during the same settling interval as connection growth so handles
        // are never rebuilt repeatedly before the prior layout is validated.
        let seg_plan = (!growth_settling)
            .then(|| self.segment_ctrl.evaluate(&snapshot.connections))
            .flatten();

        if !self.convergence.should_adjust(&AdaptiveThresholds {
            eval_interval_ms: self.tick_interval.as_millis() as u64,
            ..AdaptiveThresholds::default()
        }) && target == self.current_connections
        {
            if let Some(plan) = seg_plan {
                self.segment_ctrl.apply_plan(&plan);
                decision.actions.push(match plan {
                    segment_controller::SegmentPlan::SplitSegment { segment_id } => {
                        AdaptationAction::SplitSegment {
                            segment_id,
                            at_byte: 0,
                        }
                    }
                    segment_controller::SegmentPlan::MergeSegments { a, b } => {
                        AdaptationAction::MergeSegments { a, b }
                    }
                    segment_controller::SegmentPlan::Rebalance {
                        from_seg,
                        to_seg,
                        bytes,
                    } => AdaptationAction::Redistribute {
                        from_seg,
                        to_seg,
                        bytes,
                    },
                    _ => AdaptationAction::NoChange,
                });
                decision.confidence = 0.7;
                if decision.reason.is_empty() {
                    decision.reason = "segment-level adjustment only".into();
                }
            }
            decision.target_connections = self.current_connections;
            self.last_decision = decision.clone();
            return decision;
        }

        if target != self.current_connections {
            decision.actions.push(AdaptationAction::AdjustConnections {
                old_count: self.current_connections,
                new_count: target,
            });
            decision.reason.push_str(&format!(
                "connections {}→{} ",
                self.current_connections, target
            ));
        }

        if let Some(plan) = seg_plan {
            self.segment_ctrl.apply_plan(&plan);
            decision.actions.push(match plan {
                segment_controller::SegmentPlan::SplitSegment { segment_id } => {
                    AdaptationAction::SplitSegment {
                        segment_id,
                        at_byte: 0,
                    }
                }
                segment_controller::SegmentPlan::MergeSegments { a, b } => {
                    AdaptationAction::MergeSegments { a, b }
                }
                segment_controller::SegmentPlan::Rebalance {
                    from_seg,
                    to_seg,
                    bytes,
                } => AdaptationAction::Redistribute {
                    from_seg,
                    to_seg,
                    bytes,
                },
                _ => AdaptationAction::NoChange,
            });
        }

        if let Some(profile) = host_profile {
            if profile.per_connection_ceiling > 0 && self.protocol.prefer_multiplexing() {
                let total_budget = profile
                    .per_connection_ceiling
                    .saturating_mul(u64::from(target));
                decision.per_connection_limit = Some(total_budget / u64::from(target.max(1)));
            }
        }

        decision.target_connections = target;

        if decision.actions.is_empty() {
            decision.reason = "steady-state, no action needed".into();
            decision.confidence = 0.8;
        } else if decision.reason.is_empty() {
            decision.reason = "adjustment applied".into();
            decision.confidence = 0.6;
        }

        if target != self.current_connections {
            self.convergence.record_adjustment(agg_speed);
            if target > self.current_connections {
                self.last_growth = now;
            }
            self.current_connections = target;
        }

        log::trace!(
            "adaptive evaluate: conns={} target={} actions={} reason={}",
            self.current_connections,
            target,
            decision.actions.len(),
            decision.reason
        );

        self.last_decision = decision.clone();
        decision
    }

    pub const fn current_connections(&self) -> u32 {
        self.current_connections
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub const fn last_decision(&self) -> &AdaptationDecision {
        &self.last_decision
    }

    pub const fn segment_controller(&self) -> &SegmentController {
        &self.segment_ctrl
    }

    pub fn segment_controller_mut(&mut self) -> &mut SegmentController {
        &mut self.segment_ctrl
    }

    pub const fn chunk_manager(&self) -> &ChunkManager {
        &self.chunk_manager
    }

    pub fn chunk_manager_mut(&mut self) -> &mut ChunkManager {
        &mut self.chunk_manager
    }

    pub const fn buffer_manager(&self) -> &BufferManager {
        &self.buffer_manager
    }

    pub fn buffer_manager_mut(&mut self) -> &mut BufferManager {
        &mut self.buffer_manager
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_bus_basic() {
        let bus = TelemetryBus::new();
        bus.report_bytes(0, 1024);
        bus.report_speed(0, 500);
        bus.report_rtt(0, 12000);
        bus.set_alive(0, true);

        let snap = bus.snapshot();
        assert_eq!(snap.connections[0].bytes_downloaded, 1024);
        assert_eq!(snap.connections[0].last_speed, 500);
        assert_eq!(snap.connections[0].rtt_us, 12000);
        assert!(snap.connections[0].alive);
        assert_eq!(snap.aggregate.active_connections, 1);
    }

    #[test]
    fn telemetry_bus_out_of_bounds_is_safe() {
        let bus = TelemetryBus::new();
        bus.report_bytes(99, 1024);
        bus.set_alive(99, true);
        let snap = bus.snapshot();
        assert_eq!(snap.connections.len(), MAX_TRACKED_CONNECTIONS);
    }

    #[test]
    fn telemetry_bus_peak_tracking() {
        let bus = TelemetryBus::new();
        bus.report_speed(0, 100);
        bus.report_speed(1, 500);
        bus.report_speed(2, 200);
        let snap = bus.snapshot();
        assert_eq!(snap.aggregate.peak_speed, 500);
    }

    #[test]
    fn telemetry_bus_completed_failed() {
        let bus = TelemetryBus::new();
        bus.set_alive(0, true);
        bus.set_alive(1, true);
        bus.mark_completed(0);
        bus.mark_failed(1);
        let snap = bus.snapshot();
        assert_eq!(snap.aggregate.completed_connections, 1);
        assert_eq!(snap.aggregate.failed_connections, 1);
        assert_eq!(snap.aggregate.active_connections, 0);
    }

    #[test]
    fn telemetry_bus_reset() {
        let bus = TelemetryBus::new();
        bus.report_bytes(0, 1024);
        bus.set_alive(0, true);
        bus.reset();
        let snap = bus.snapshot();
        assert_eq!(snap.connections[0].bytes_downloaded, 0);
        assert!(!snap.connections[0].alive);
        assert_eq!(snap.aggregate.active_connections, 0);
    }

    #[test]
    fn adaptive_thresholds_default() {
        let t = AdaptiveThresholds::default();
        assert_eq!(t.speed_high_threshold, 5 * 1024 * 1024);
        assert_eq!(t.speed_low_threshold, 100 * 1024);
        assert_eq!(t.stall_threshold_ms, 5000);
        assert_eq!(t.eval_interval_ms, 2000);
    }

    #[test]
    fn adaptive_engine_new() {
        let engine = AdaptiveEngine::new(
            "example.com".into(),
            1024 * 1024,
            4,
            ProtocolVersion::Http2,
            256 * 1024,
        );
        assert_eq!(engine.current_connections(), 4);
        assert_eq!(engine.host(), "example.com");
    }

    #[test]
    fn adaptive_engine_single_stream_passthrough() {
        let mut engine = AdaptiveEngine::new(
            "ftp.example.com".into(),
            1024 * 1024,
            1,
            ProtocolVersion::Ftp,
            256 * 1024,
        );
        let bus = TelemetryBus::new();
        bus.set_alive(0, true);
        bus.report_speed(0, 50000);
        let decision = engine.evaluate(&bus);
        assert_eq!(decision.target_connections, 1);
        assert_eq!(decision.confidence, 1.0);
        assert!(decision.actions.is_empty());
    }

    #[test]
    fn adaptive_engine_tick_interval_throttled() {
        let mut engine = AdaptiveEngine::new(
            "example.com".into(),
            1024 * 1024,
            4,
            ProtocolVersion::Http2,
            256 * 1024,
        );
        engine.set_tick_interval(Duration::from_secs(60));
        let bus = TelemetryBus::new();
        bus.set_alive(0, true);
        let d1 = engine.evaluate(&bus);
        let d2 = engine.evaluate(&bus);
        assert_eq!(d1.target_connections, d2.target_connections);
    }

    #[test]
    fn adaptive_engine_seeds_profile() {
        let mut engine = AdaptiveEngine::new(
            "example.com".into(),
            1024 * 1024,
            4,
            ProtocolVersion::Http11,
            256 * 1024,
        );
        engine.seed_profile(
            ProtocolVersion::Http2,
            true,
            true,
            Some("TLSv1.3".into()),
            Some("h2".into()),
            Some("nginx".into()),
            15000,
            20000,
            0,
        );
        let profile = engine.profiler.get("example.com").unwrap();
        assert_eq!(profile.protocol, ProtocolVersion::Http2);
        assert!(profile.supports_range == server_profiler::TriState::Yes);
        assert_eq!(profile.initial_rtt_us, 15000);
    }

    #[test]
    fn adaptive_engine_produces_decision() {
        let mut engine = AdaptiveEngine::new(
            "example.com".into(),
            10 * 1024 * 1024,
            4,
            ProtocolVersion::Http2,
            256 * 1024,
        );
        engine.seed_profile(
            ProtocolVersion::Http2,
            true,
            true,
            Some("TLSv1.3".into()),
            Some("h2".into()),
            None,
            20000,
            30000,
            0,
        );
        engine.set_tick_interval(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));

        let bus = TelemetryBus::new();
        for i in 0..4 {
            bus.set_alive(i, true);
            bus.report_speed(i, 500 * 1024);
            bus.report_rtt(i, 20000);
        }
        let decision = engine.evaluate(&bus);
        assert!(decision.target_connections >= 1);
        assert!(decision.target_connections <= 32);
        assert!(!decision.reason.is_empty());
    }

    #[test]
    fn adaptive_engine_last_decision_cached() {
        let mut engine = AdaptiveEngine::new(
            "example.com".into(),
            1024 * 1024,
            4,
            ProtocolVersion::Http2,
            256 * 1024,
        );
        engine.set_tick_interval(Duration::from_secs(60));
        let bus = TelemetryBus::new();
        let d1 = engine.evaluate(&bus);
        let cached = engine.last_decision();
        assert_eq!(cached.target_connections, d1.target_connections);
    }

    #[test]
    fn adaptive_engine_segment_controller_access() {
        let engine = AdaptiveEngine::new(
            "example.com".into(),
            10 * 1024 * 1024,
            4,
            ProtocolVersion::Http2,
            256 * 1024,
        );
        assert_eq!(engine.segment_controller().segment_count(), 1);
    }

    #[test]
    fn telemetry_speed_aggregate_is_recomputed_not_delta() {
        // M9 regression: total_speed must equal the sum of live slot speeds
        // (no delta counter that can underflow or go stale).
        let bus = TelemetryBus::new();
        bus.report_speed(0, 1000);
        bus.report_speed(1, 2000);
        bus.report_speed(2, 3000);
        let snap = bus.snapshot();
        assert_eq!(snap.aggregate.total_speed, 6000);

        // Update one slot downward; aggregate must follow exactly.
        bus.report_speed(1, 500);
        let snap2 = bus.snapshot();
        assert_eq!(snap2.aggregate.total_speed, 4500);

        // Peak tracks the maximum ever reported.
        assert_eq!(snap2.aggregate.peak_speed, 3000);
    }

    #[test]
    fn telemetry_set_alive_counts_transitions_once() {
        // H16 regression: setting alive=false twice must decrement the active
        // count only once (no underflow).
        let bus = TelemetryBus::new();
        bus.set_alive(0, true);
        bus.set_alive(0, true); // no-op
        assert_eq!(bus.snapshot().aggregate.active_connections, 1);

        bus.set_alive(0, false);
        bus.set_alive(0, false); // no-op
        assert_eq!(bus.snapshot().aggregate.active_connections, 0);

        // mark_completed twice on the same slot: completed counts once, and
        // active never goes negative.
        bus.set_alive(1, true);
        bus.mark_completed(1);
        bus.mark_completed(1);
        let snap = bus.snapshot();
        assert_eq!(snap.aggregate.active_connections, 0);
        assert_eq!(snap.aggregate.completed_connections, 2);
    }

    #[test]
    fn telemetry_concurrent_report_speed_does_not_underflow() {
        // M9: concurrent writers on the same slot must never corrupt the
        // aggregate (the old fetch_sub path could underflow u64).
        let bus = std::sync::Arc::new(TelemetryBus::new());
        let mut handles = Vec::new();
        for t in 0..8usize {
            let bus = bus.clone();
            handles.push(std::thread::spawn(move || {
                for i in 0..200usize {
                    bus.report_speed(t % 4, (i as u64) * 10);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let snap = bus.snapshot();
        // No underflow: total is the sum of the last written values, each
        // ≤ 1990, so the total is bounded well below u64::MAX.
        assert!(snap.aggregate.total_speed < 10_000_000);
        assert!(snap.aggregate.peak_speed < 10_000_000);
    }
}
