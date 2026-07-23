pub mod convergence;
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

pub const MAX_TRACKED_CONNECTIONS: usize = 32;

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

#[derive(Clone, Debug)]
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

impl Default for ConnectionTelemetry {
    fn default() -> Self {
        Self {
            bytes_downloaded: 0,
            rtt_us: 0,
            dns_us: 0,
            tls_us: 0,
            ttfb_us: 0,
            last_speed: 0,
            stall_count: 0,
            error_count: 0,
            http_status: 0,
            alive: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AggregateTelemetry {
    pub total_bytes: u64,
    pub total_speed: u64,
    pub peak_speed: u64,
    pub active_connections: u32,
    pub completed_connections: u32,
    pub failed_connections: u32,
}

impl Default for AggregateTelemetry {
    fn default() -> Self {
        Self {
            total_bytes: 0,
            total_speed: 0,
            peak_speed: 0,
            active_connections: 0,
            completed_connections: 0,
            failed_connections: 0,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct TelemetrySnapshot {
    pub connections: Vec<ConnectionTelemetry>,
    pub aggregate: AggregateTelemetry,
    pub timestamp_millis: u64,
}

pub struct TelemetryBus {
    connections: Vec<ConnectionSlot>,
    aggregate_bytes: AtomicU64,
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
    fn new() -> Self {
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
            aggregate_bytes: AtomicU64::new(0),
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
            self.connections[conn_id].bytes.store(bytes, Ordering::Relaxed);
        }
    }

    pub fn report_speed(&self, conn_id: usize, speed: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].speed.store(speed, Ordering::Relaxed);
            self.aggregate_speed.store(speed, Ordering::Relaxed);
            self.aggregate_peak.fetch_max(speed, Ordering::Relaxed);
        }
    }

    pub fn report_rtt(&self, conn_id: usize, rtt_us: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].rtt_us.store(rtt_us, Ordering::Relaxed);
        }
    }

    pub fn report_handshake(&self, conn_id: usize, dns_us: u64, tls_us: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].dns_us.store(dns_us, Ordering::Relaxed);
            self.connections[conn_id].tls_us.store(tls_us, Ordering::Relaxed);
        }
    }

    pub fn report_ttfb(&self, conn_id: usize, ttfb_us: u64) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].ttfb_us.store(ttfb_us, Ordering::Relaxed);
        }
    }

    pub fn report_stall(&self, conn_id: usize) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].stall_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn report_error(&self, conn_id: usize) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].error_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn report_http_status(&self, conn_id: usize, status: u16) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].http_status.store(status, Ordering::Relaxed);
        }
    }

    pub fn set_alive(&self, conn_id: usize, alive: bool) {
        if conn_id < MAX_TRACKED_CONNECTIONS {
            self.connections[conn_id].alive.store(alive, Ordering::Relaxed);
            if alive {
                self.active_conns.fetch_add(1, Ordering::Relaxed);
            } else {
                self.active_conns.fetch_sub(1, Ordering::Relaxed);
            }
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
        TelemetrySnapshot {
            connections,
            aggregate: AggregateTelemetry {
                total_bytes: self.aggregate_bytes.load(Ordering::Relaxed),
                total_speed: self.aggregate_speed.load(Ordering::Relaxed),
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
        self.aggregate_bytes.store(0, Ordering::Relaxed);
        self.aggregate_speed.store(0, Ordering::Relaxed);
        self.aggregate_peak.store(0, Ordering::Relaxed);
        self.active_conns.store(0, Ordering::Relaxed);
        self.completed_conns.store(0, Ordering::Relaxed);
        self.failed_conns.store(0, Ordering::Relaxed);
    }
}

#[derive(Clone, Debug)]
pub enum AdaptationAction {
    AdjustConnections { old_count: u32, new_count: u32 },
    SplitSegment { segment_id: u32, at_byte: u64 },
    MergeSegments { a: u32, b: u32 },
    Redistribute { from_seg: u32, to_seg: u32, bytes: u64 },
    ThrottleAll { per_conn_bytes_per_sec: u64 },
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
    host: String,
    total_size: u64,
    current_connections: u32,
    last_decision: AdaptationDecision,
    last_tick: Instant,
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
        Self {
            profiler: server_profiler::ServerProfiler::new(),
            convergence: ConvergenceDetector::new(),
            resources: ResourceMonitor::new(),
            protocol: ProtocolAdapter::new(protocol),
            segment_ctrl: SegmentController::new(total_size, connections, min_segment_bytes),
            host,
            total_size,
            current_connections: connections,
            last_decision: AdaptationDecision::default(),
            last_tick: Instant::now() - Duration::from_secs(10),
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
        let protocol = profile.protocol.clone();
        let mut engine = Self::new(host.clone(), total_size, connections, protocol, min_segment_bytes);
        engine.profiler.get_or_create(&host);
        let p = engine.profiler.get_mut(&host).unwrap();
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
        tls_version: Option<String>,
        alpn: Option<String>,
        server_header: Option<String>,
        initial_rtt_us: u64,
        handshake_us: u64,
    ) {
        self.protocol = ProtocolAdapter::new(protocol.clone());
        self.profiler.seed_from_preflight(
            &self.host,
            protocol,
            supports_range,
            tls_version,
            alpn,
            server_header,
            initial_rtt_us,
            handshake_us,
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
                    for _ in 0..conn.error_count {
                        self.profiler.update_from_telemetry(
                            &self.host, 0, 0, 0, true,
                        );
                    }
                }
            }
        }

        let agg_speed = snapshot.aggregate.peak_speed.max(
            snapshot.connections.iter()
                .filter(|c| c.alive)
                .map(|c| c.last_speed)
                .sum::<u64>()
        );

        self.convergence.record_speed(agg_speed, snapshot.aggregate.active_connections);

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

        if !self.convergence.should_adjust(&AdaptiveThresholds {
            eval_interval_ms: self.tick_interval.as_millis() as u64,
            ..AdaptiveThresholds::default()
        }) && target == self.current_connections {
            let seg_plan = self.segment_ctrl.evaluate(&snapshot.connections);
            if let Some(plan) = seg_plan {
                self.segment_ctrl.apply_plan(&plan);
                decision.actions.push(match plan {
                    segment_controller::SegmentPlan::SplitSegment { segment_id } => {
                        AdaptationAction::SplitSegment { segment_id, at_byte: 0 }
                    }
                    segment_controller::SegmentPlan::MergeSegments { a, b } => {
                        AdaptationAction::MergeSegments { a, b }
                    }
                    segment_controller::SegmentPlan::Rebalance { from_seg, to_seg, bytes } => {
                        AdaptationAction::Redistribute { from_seg, to_seg, bytes }
                    }
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
                "connections {}→{} ", self.current_connections, target
            ));
        }

        let seg_plan = self.segment_ctrl.evaluate(&snapshot.connections);
        if let Some(plan) = seg_plan {
            self.segment_ctrl.apply_plan(&plan);
            decision.actions.push(match plan {
                segment_controller::SegmentPlan::SplitSegment { segment_id } => {
                    AdaptationAction::SplitSegment { segment_id, at_byte: 0 }
                }
                segment_controller::SegmentPlan::MergeSegments { a, b } => {
                    AdaptationAction::MergeSegments { a, b }
                }
                segment_controller::SegmentPlan::Rebalance { from_seg, to_seg, bytes } => {
                    AdaptationAction::Redistribute { from_seg, to_seg, bytes }
                }
                _ => AdaptationAction::NoChange,
            });
        }

        if let Some(profile) = host_profile {
            if profile.per_connection_ceiling > 0 && self.protocol.prefer_multiplexing() {
                let total_budget = profile.per_connection_ceiling * target as u64;
                decision.per_connection_limit = Some(total_budget / target.max(1) as u64);
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
            self.current_connections = target;
        }

        self.last_decision = decision.clone();
        decision
    }

    pub fn current_connections(&self) -> u32 {
        self.current_connections
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn last_decision(&self) -> &AdaptationDecision {
        &self.last_decision
    }

    pub fn segment_controller(&self) -> &SegmentController {
        &self.segment_ctrl
    }

    pub fn segment_controller_mut(&mut self) -> &mut SegmentController {
        &mut self.segment_ctrl
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
            Some("TLSv1.3".into()),
            Some("h2".into()),
            Some("nginx".into()),
            15000,
            20000,
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
            Some("TLSv1.3".into()),
            Some("h2".into()),
            None,
            20000,
            30000,
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
        assert_eq!(engine.segment_controller().segment_count(), 4);
    }
}
