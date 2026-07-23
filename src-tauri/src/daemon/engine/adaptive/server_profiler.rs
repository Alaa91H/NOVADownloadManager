use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::AdaptiveThresholds;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ProtocolVersion {
    #[default]
    Unknown,
    Http11,
    Http2,
    Http3,
    Ftp,
    Sftp,
    Scp,
}

impl ProtocolVersion {
    pub fn from_curl_http_version(version: u32) -> Self {
        match version {
            1 => Self::Http11,
            2 => Self::Http2,
            3 => Self::Http3,
            _ => Self::Unknown,
        }
    }

    pub fn from_scheme(scheme: &str) -> Self {
        match scheme.to_ascii_lowercase().as_str() {
            "ftp" => Self::Ftp,
            "sftp" => Self::Sftp,
            "scp" => Self::Scp,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ServerProfile {
    pub host: String,
    pub protocol: ProtocolVersion,
    pub supports_range: TriState,
    pub supports_resume: TriState,
    pub server_software: Option<String>,
    pub tls_version: Option<String>,
    pub alpn_protocol: Option<String>,

    pub initial_rtt_us: u64,
    pub initial_throughput: u64,
    pub handshake_time_us: u64,

    pub rtt_samples: Vec<u64>,
    pub throughput_samples: Vec<u64>,
    pub median_rtt_us: u64,
    pub p95_rtt_us: u64,
    pub throughput_ceiling: u64,
    pub per_connection_ceiling: u64,
    pub rate_limit_detected: bool,
    pub rate_limit_cooldown_until: Option<Instant>,
    pub optimal_connections: u32,
    pub error_rate: f32,
    pub stability_score: f32,

    pub total_probes: u64,
    pub successful_probes: u64,
    pub consecutive_failures: u32,
    pub last_observed: Option<Instant>,
}

impl ServerProfile {
    pub fn new(host: &str) -> Self {
        Self {
            host: host.to_string(),
            ..Default::default()
        }
    }

    pub fn recommended_connections(&self, file_size: u64, cpu_count: u32) -> u32 {
        if self.optimal_connections > 0 {
            return self.optimal_connections;
        }
        let base = match self.protocol {
            ProtocolVersion::Http2 | ProtocolVersion::Http3 => (cpu_count * 2).min(16),
            ProtocolVersion::Http11 => (cpu_count * 2).min(32),
            ProtocolVersion::Ftp | ProtocolVersion::Sftp | ProtocolVersion::Scp => 1,
            ProtocolVersion::Unknown => (cpu_count * 2).min(16),
        };
        if file_size < 1024 * 1024 {
            return 1;
        }
        if file_size < 10 * 1024 * 1024 {
            return base.min(4);
        }
        if self.stability_score < 0.5 {
            return base.max(2).min(4);
        }
        base
    }

    pub fn derive_thresholds(&self) -> AdaptiveThresholds {
        let speed_high = if self.per_connection_ceiling > 0 {
            (self.per_connection_ceiling as f64 * 0.8) as u64
        } else {
            5 * 1024 * 1024
        };
        let speed_low = if self.per_connection_ceiling > 0 {
            (self.per_connection_ceiling as f64 * 0.1) as u64
        } else {
            100 * 1024
        };
        let stall_ms = if self.p95_rtt_us > 0 {
            (self.p95_rtt_us / 1000 * 3).max(1000)
        } else {
            5000
        };
        let eval_ms = if self.median_rtt_us > 0 {
            ((self.median_rtt_us / 1000) * 2).max(500).min(10000)
        } else {
            2000
        };
        AdaptiveThresholds {
            speed_high_threshold: speed_high,
            speed_low_threshold: speed_low,
            stall_threshold_ms: stall_ms,
            eval_interval_ms: eval_ms,
            max_adjustments_per_minute: 15,
        }
    }

    pub fn is_rate_limited(&self) -> bool {
        if !self.rate_limit_detected {
            return false;
        }
        match self.rate_limit_cooldown_until {
            Some(cooldown) => Instant::now() < cooldown,
            None => true,
        }
    }

    fn update_statistics(&mut self) {
        if !self.rtt_samples.is_empty() {
            let mut sorted = self.rtt_samples.clone();
            sorted.sort_unstable();
            let len = sorted.len();
            self.median_rtt_us = sorted[len / 2];
            let p95_idx = ((len as f64) * 0.95) as usize;
            self.p95_rtt_us = sorted[p95_idx.min(len - 1)];
        }
        if !self.throughput_samples.is_empty() {
            self.throughput_ceiling = self.throughput_samples.iter().copied().max().unwrap_or(0);
            self.per_connection_ceiling = self.throughput_ceiling;
        }
        let total = self.total_probes;
        if total > 0 {
            self.error_rate = 1.0 - (self.successful_probes as f32 / total as f32);
        }
        self.stability_score = if self.consecutive_failures > 3 {
            0.1
        } else if self.consecutive_failures > 1 {
            0.5
        } else if self.error_rate > 0.3 {
            0.4
        } else if self.error_rate > 0.1 {
            0.7
        } else {
            0.95
        };
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum TriState {
    #[default]
    Unknown,
    Yes,
    No,
}

pub struct ServerProfiler {
    profiles: HashMap<String, ServerProfile>,
}

impl ServerProfiler {
    pub fn new() -> Self {
        Self {
            profiles: HashMap::new(),
        }
    }

    pub fn get(&self, host: &str) -> Option<&ServerProfile> {
        self.profiles.get(host)
    }

    pub fn get_mut(&mut self, host: &str) -> Option<&mut ServerProfile> {
        self.profiles.get_mut(host)
    }

    pub fn get_or_create(&mut self, host: &str) -> &mut ServerProfile {
        self.profiles
            .entry(host.to_string())
            .or_insert_with(|| ServerProfile::new(host))
    }

    pub fn seed_from_preflight(
        &mut self,
        host: &str,
        protocol: ProtocolVersion,
        supports_range: bool,
        tls_version: Option<String>,
        alpn: Option<String>,
        server_header: Option<String>,
        initial_rtt_us: u64,
        handshake_us: u64,
    ) {
        let profile = self.get_or_create(host);
        profile.protocol = protocol;
        profile.supports_range = if supports_range {
            TriState::Yes
        } else {
            TriState::No
        };
        profile.supports_resume = profile.supports_range.clone();
        profile.tls_version = tls_version;
        profile.alpn_protocol = alpn;
        profile.server_software = server_header;
        profile.initial_rtt_us = initial_rtt_us;
        profile.handshake_time_us = handshake_us;
        if initial_rtt_us > 0 {
            profile.rtt_samples.push(initial_rtt_us);
        }
        profile.total_probes += 1;
        profile.successful_probes += 1;
        profile.last_observed = Some(Instant::now());
        profile.update_statistics();
    }

    pub fn update_from_telemetry(
        &mut self,
        host: &str,
        rtt_us: u64,
        speed: u64,
        http_status: u16,
        error: bool,
    ) {
        let profile = self.get_or_create(host);
        if rtt_us > 0 {
            profile.rtt_samples.push(rtt_us);
            if profile.rtt_samples.len() > 100 {
                profile.rtt_samples.remove(0);
            }
        }
        if speed > 0 {
            profile.throughput_samples.push(speed);
            if profile.throughput_samples.len() > 100 {
                profile.throughput_samples.remove(0);
            }
        }
        profile.total_probes += 1;
        if error {
            profile.consecutive_failures += 1;
        } else {
            profile.successful_probes += 1;
            profile.consecutive_failures = 0;
        }
        match http_status {
            429 | 503 => {
                profile.rate_limit_detected = true;
                profile.rate_limit_cooldown_until =
                    Some(Instant::now() + Duration::from_secs(30));
            }
            200..=299 => {
                if profile.rate_limit_detected
                    && profile
                        .rate_limit_cooldown_until
                        .map(|t| Instant::now() >= t)
                        .unwrap_or(false)
                {
                    profile.rate_limit_detected = false;
                    profile.rate_limit_cooldown_until = None;
                }
            }
            _ => {}
        }
        profile.last_observed = Some(Instant::now());
        profile.update_statistics();
    }

    pub fn report_success(&mut self, host: &str) {
        if let Some(profile) = self.profiles.get_mut(host) {
            profile.successful_probes += 1;
            profile.total_probes += 1;
            profile.consecutive_failures = 0;
            profile.last_observed = Some(Instant::now());
            profile.update_statistics();
        }
    }

    pub fn report_failure(&mut self, host: &str) {
        if let Some(profile) = self.profiles.get_mut(host) {
            profile.total_probes += 1;
            profile.consecutive_failures += 1;
            profile.last_observed = Some(Instant::now());
            profile.update_statistics();
        }
    }

    pub fn learn_optimal_connections(&mut self, host: &str, connections: u32, speed: u64) {
        let profile = self.get_or_create(host);
        if profile.per_connection_ceiling == 0 || speed > profile.per_connection_ceiling {
            profile.per_connection_ceiling = speed;
        }
        if speed > 0 && connections > 0 {
            let per_conn = speed / connections as u64;
            if per_conn > 0 {
                profile.optimal_connections = connections;
            }
        }
        profile.update_statistics();
    }

    pub fn active_hosts(&self) -> Vec<&str> {
        self.profiles.keys().map(|s| s.as_str()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host_profile<'a>(profiler: &'a mut ServerProfiler, host: &str) -> &'a mut ServerProfile {
        profiler.get_or_create(host)
    }

    #[test]
    fn new_profiler_is_empty() {
        let p = ServerProfiler::new();
        assert!(p.get("example.com").is_none());
    }

    #[test]
    fn get_or_create_creates_profile() {
        let mut p = ServerProfiler::new();
        let prof = host_profile(&mut p, "example.com");
        assert_eq!(prof.host, "example.com");
        assert_eq!(prof.protocol, ProtocolVersion::Unknown);
    }

    #[test]
    fn seed_from_preflight_populates_fields() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight(
            "cdn.example.com",
            ProtocolVersion::Http2,
            true,
            Some("TLSv1.3".to_string()),
            Some("h2".to_string()),
            Some("nginx".to_string()),
            15000,
            8000,
        );
        let prof = p.get("cdn.example.com").unwrap();
        assert_eq!(prof.protocol, ProtocolVersion::Http2);
        assert_eq!(prof.supports_range, TriState::Yes);
        assert_eq!(prof.tls_version.as_deref(), Some("TLSv1.3"));
        assert_eq!(prof.alpn_protocol.as_deref(), Some("h2"));
        assert_eq!(prof.server_software.as_deref(), Some("nginx"));
        assert_eq!(prof.initial_rtt_us, 15000);
        assert_eq!(prof.handshake_time_us, 8000);
        assert_eq!(prof.total_probes, 1);
    }

    #[test]
    fn update_from_telemetry_records_rtt_and_speed() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 10000, 5000);
        p.update_from_telemetry("h", 12000, 500_000, 200, false);
        p.update_from_telemetry("h", 9000, 600_000, 200, false);
        let prof = p.get("h").unwrap();
        assert_eq!(prof.rtt_samples.len(), 3);
        assert_eq!(prof.throughput_samples.len(), 2);
        assert_eq!(prof.successful_probes, 3);
    }

    #[test]
    fn update_from_telemetry_detects_rate_limit() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 10000, 5000);
        p.update_from_telemetry("h", 10000, 100_000, 429, false);
        let prof = p.get("h").unwrap();
        assert!(prof.rate_limit_detected);
        assert!(prof.is_rate_limited());
    }

    #[test]
    fn update_from_telemetry_records_errors() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 10000, 5000);
        p.update_from_telemetry("h", 0, 0, 0, true);
        p.update_from_telemetry("h", 0, 0, 0, true);
        let prof = p.get("h").unwrap();
        assert_eq!(prof.consecutive_failures, 2);
        assert!(prof.error_rate > 0.0);
    }

    #[test]
    fn report_success_resets_consecutive_failures() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 10000, 5000);
        p.report_failure("h");
        p.report_failure("h");
        p.report_success("h");
        let prof = p.get("h").unwrap();
        assert_eq!(prof.consecutive_failures, 0);
    }

    #[test]
    fn derive_thresholds_with_data() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 20000, 5000);
        for i in 0..20 {
            p.update_from_telemetry("h", 15000 + i * 1000, 200_000 + i * 50_000, 200, false);
        }
        let prof = p.get("h").unwrap();
        let thresholds = prof.derive_thresholds();
        assert!(thresholds.speed_high_threshold > 0);
        assert!(thresholds.speed_low_threshold > 0);
        assert!(thresholds.stall_threshold_ms >= 1000);
        assert!(thresholds.eval_interval_ms >= 500);
    }

    #[test]
    fn recommended_connections_by_protocol() {
        let mut prof = ServerProfile::new("h");
        prof.protocol = ProtocolVersion::Http2;
        prof.stability_score = 0.95;
        assert_eq!(prof.recommended_connections(100 * 1024 * 1024, 8), 16);

        prof.protocol = ProtocolVersion::Http11;
        assert_eq!(prof.recommended_connections(100 * 1024 * 1024, 8), 16);

        prof.protocol = ProtocolVersion::Ftp;
        assert_eq!(prof.recommended_connections(100 * 1024 * 1024, 8), 1);
    }

    #[test]
    fn recommended_connections_small_file() {
        let mut prof = ServerProfile::new("h");
        prof.protocol = ProtocolVersion::Http2;
        assert_eq!(prof.recommended_connections(500 * 1024, 8), 1);
    }

    #[test]
    fn recommended_connections_unstable_server() {
        let mut prof = ServerProfile::new("h");
        prof.protocol = ProtocolVersion::Http11;
        prof.stability_score = 0.3;
        assert_eq!(prof.recommended_connections(100 * 1024 * 1024, 8), 4);
    }

    #[test]
    fn stability_score_calculation() {
        let mut prof = ServerProfile::new("h");
        prof.total_probes = 100;
        prof.successful_probes = 99;
        prof.consecutive_failures = 0;
        prof.update_statistics();
        assert!(prof.stability_score > 0.9);

        prof.consecutive_failures = 4;
        prof.update_statistics();
        assert!(prof.stability_score < 0.2);
    }

    #[test]
    fn protocol_from_curl_version() {
        assert_eq!(ProtocolVersion::from_curl_http_version(1), ProtocolVersion::Http11);
        assert_eq!(ProtocolVersion::from_curl_http_version(2), ProtocolVersion::Http2);
        assert_eq!(ProtocolVersion::from_curl_http_version(3), ProtocolVersion::Http3);
        assert_eq!(ProtocolVersion::from_curl_http_version(99), ProtocolVersion::Unknown);
    }

    #[test]
    fn protocol_from_scheme() {
        assert_eq!(ProtocolVersion::from_scheme("ftp"), ProtocolVersion::Ftp);
        assert_eq!(ProtocolVersion::from_scheme("sftp"), ProtocolVersion::Sftp);
        assert_eq!(ProtocolVersion::from_scheme("scp"), ProtocolVersion::Scp);
        assert_eq!(ProtocolVersion::from_scheme("https"), ProtocolVersion::Unknown);
    }

    #[test]
    fn learn_optimal_connections() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 10000, 5000);
        p.learn_optimal_connections("h", 4, 800_000);
        let prof = p.get("h").unwrap();
        assert_eq!(prof.optimal_connections, 4);
        assert_eq!(prof.per_connection_ceiling, 800_000);
    }

    #[test]
    fn active_hosts() {
        let mut p = ServerProfiler::new();
        p.get_or_create("a.com");
        p.get_or_create("b.com");
        let mut hosts = p.active_hosts();
        hosts.sort();
        assert_eq!(hosts, vec!["a.com", "b.com"]);
    }

    #[test]
    fn rtt_samples_capped_at_100() {
        let mut p = ServerProfiler::new();
        p.seed_from_preflight("h", ProtocolVersion::Http11, true, None, None, None, 10000, 5000);
        for i in 0..150 {
            p.update_from_telemetry("h", 10000 + i, 100_000, 200, false);
        }
        let prof = p.get("h").unwrap();
        assert_eq!(prof.rtt_samples.len(), 100);
    }
}
