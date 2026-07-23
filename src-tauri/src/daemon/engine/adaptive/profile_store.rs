use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use super::server_profiler::{ProtocolVersion, ServerProfile};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedProfile {
    pub host: String,
    pub protocol: String,
    pub supports_range: bool,
    pub supports_resume: bool,
    pub tls_version: String,
    pub alpn_protocol: String,
    pub server_software: String,
    pub initial_rtt_us: u64,
    pub handshake_time_us: u64,
    pub median_rtt_us: u64,
    pub p95_rtt_us: u64,
    pub throughput_ceiling: u64,
    pub per_connection_ceiling: u64,
    pub optimal_connections: u32,
    pub stability_score: f64,
    pub total_probes: u64,
    pub successful_probes: u64,
    pub rate_limit_cooldown_until: Option<u64>,
    pub last_updated: u64,
    pub bandwidth_plateau_detected: bool,
    pub detected_rate_limit_headers: Vec<String>,
}

impl From<&ServerProfile> for PersistedProfile {
    fn from(p: &ServerProfile) -> Self {
        Self {
            host: p.host.clone(),
            protocol: format!("{:?}", p.protocol),
            supports_range: p.supports_range == super::server_profiler::TriState::Yes,
            supports_resume: p.supports_resume == super::server_profiler::TriState::Yes,
            tls_version: p.tls_version.clone().unwrap_or_default(),
            alpn_protocol: p.alpn_protocol.clone().unwrap_or_default(),
            server_software: p.server_software.clone().unwrap_or_default(),
            initial_rtt_us: p.initial_rtt_us,
            handshake_time_us: p.handshake_time_us,
            median_rtt_us: p.median_rtt_us,
            p95_rtt_us: p.p95_rtt_us,
            throughput_ceiling: p.throughput_ceiling,
            per_connection_ceiling: p.per_connection_ceiling,
            optimal_connections: p.optimal_connections,
            stability_score: p.stability_score as f64,
            total_probes: p.total_probes,
            successful_probes: p.successful_probes,
            rate_limit_cooldown_until: None,
            last_updated: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            bandwidth_plateau_detected: false,
            detected_rate_limit_headers: Vec::new(),
        }
    }
}

impl PersistedProfile {
    pub fn to_server_profile(&self) -> ServerProfile {
        let protocol = match self.protocol.as_str() {
            "Http11" => ProtocolVersion::Http11,
            "Http2" => ProtocolVersion::Http2,
            "Http3" => ProtocolVersion::Http3,
            "Ftp" => ProtocolVersion::Ftp,
            "Sftp" => ProtocolVersion::Sftp,
            "Scp" => ProtocolVersion::Scp,
            _ => ProtocolVersion::Http11,
        };
        let range_tristate = if self.supports_range {
            super::server_profiler::TriState::Yes
        } else {
            super::server_profiler::TriState::No
        };
        let resume_tristate = if self.supports_resume {
            super::server_profiler::TriState::Yes
        } else {
            super::server_profiler::TriState::No
        };
        ServerProfile {
            host: self.host.clone(),
            protocol,
            supports_range: range_tristate,
            supports_resume: resume_tristate,
            tls_version: if self.tls_version.is_empty() {
                None
            } else {
                Some(self.tls_version.clone())
            },
            alpn_protocol: if self.alpn_protocol.is_empty() {
                None
            } else {
                Some(self.alpn_protocol.clone())
            },
            server_software: if self.server_software.is_empty() {
                None
            } else {
                Some(self.server_software.clone())
            },
            initial_rtt_us: self.initial_rtt_us,
            initial_throughput: self.throughput_ceiling,
            handshake_time_us: self.handshake_time_us,
            rtt_samples: Vec::new(),
            throughput_samples: Vec::new(),
            median_rtt_us: self.median_rtt_us,
            p95_rtt_us: self.p95_rtt_us,
            throughput_ceiling: self.throughput_ceiling,
            per_connection_ceiling: self.per_connection_ceiling,
            optimal_connections: self.optimal_connections,
            error_rate: 0.0,
            stability_score: self.stability_score as f32,
            total_probes: self.total_probes,
            successful_probes: self.successful_probes,
            consecutive_failures: 0,
            last_observed: None,
            rate_limit_detected: self.rate_limit_cooldown_until.is_some(),
            rate_limit_cooldown_until: self.rate_limit_cooldown_until.and_then(|ts| {
                let now_secs = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                if ts > now_secs {
                    Some(Instant::now() + Duration::from_secs(ts - now_secs))
                } else {
                    None
                }
            }),
        }
    }
}

pub struct UnifiedProfileStore {
    profiles: HashMap<String, PersistedProfile>,
    dirty: bool,
    save_path: PathBuf,
}

impl UnifiedProfileStore {
    pub fn new() -> Self {
        let save_path = Self::default_save_path();
        let profiles = Self::load_from_disk(&save_path);
        Self {
            profiles,
            dirty: false,
            save_path,
        }
    }

    pub fn with_path(path: PathBuf) -> Self {
        let profiles = Self::load_from_disk(&path);
        Self {
            profiles,
            dirty: false,
            save_path: path,
        }
    }

    pub fn get_or_create(&mut self, host: &str) -> &PersistedProfile {
        if !self.profiles.contains_key(host) {
            self.profiles.insert(
                host.to_string(),
                PersistedProfile {
                    host: host.to_string(),
                    ..Default::default()
                },
            );
            self.dirty = true;
        }
        &self.profiles[host]
    }

    pub fn merge_preflight(&mut self, host: &str, profile: &ServerProfile) {
        let existing = self.profiles.get(host);
        let mut persisted = PersistedProfile::from(profile);

        if let Some(old) = existing {
            if old.total_probes > 0 {
                persisted.total_probes = old.total_probes + 1;
                persisted.successful_probes = old.successful_probes + 1;
            }
            if old.median_rtt_us > 0 && persisted.initial_rtt_us > 0 {
                let alpha = 0.3;
                persisted.median_rtt_us = ((old.median_rtt_us as f64 * (1.0 - alpha))
                    + (persisted.initial_rtt_us as f64 * alpha))
                    as u64;
            }
            persisted.bandwidth_plateau_detected = old.bandwidth_plateau_detected;
            persisted.detected_rate_limit_headers = old.detected_rate_limit_headers.clone();
        }

        self.profiles.insert(host.to_string(), persisted);
        self.dirty = true;
    }

    pub fn merge_telemetry(&mut self, host: &str, rtt_us: u64, speed: u64, http_status: u16) {
        let entry = self
            .profiles
            .entry(host.to_string())
            .or_insert_with(|| PersistedProfile {
                host: host.to_string(),
                ..Default::default()
            });

        entry.total_probes += 1;
        if rtt_us > 0 {
            let alpha = 0.2;
            entry.median_rtt_us = if entry.median_rtt_us == 0 {
                rtt_us
            } else {
                ((entry.median_rtt_us as f64 * (1.0 - alpha)) + (rtt_us as f64 * alpha)) as u64
            };
        }
        if speed > entry.throughput_ceiling {
            entry.throughput_ceiling = speed;
        }
        if http_status == 200 || http_status == 206 {
            entry.successful_probes += 1;
        }
        if http_status == 429 || http_status == 503 {
            entry.rate_limit_cooldown_until = Some(
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    + 30,
            );
        }
        entry.last_updated = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.dirty = true;
    }

    pub fn detect_bandwidth_plateau(&mut self, host: &str, recent_speeds: &[u64]) -> bool {
        if recent_speeds.len() < 5 {
            return false;
        }
        let window = &recent_speeds[recent_speeds.len().saturating_sub(10)..];
        let avg = window.iter().sum::<u64>() / window.len() as u64;
        if avg == 0 {
            return false;
        }
        let variance: f64 = window
            .iter()
            .map(|&s| {
                let diff = s as f64 - avg as f64;
                diff * diff
            })
            .sum::<f64>()
            / window.len() as f64;
        let cv = variance.sqrt() / avg as f64;
        let is_plateau = cv < 0.15;

        if let Some(entry) = self.profiles.get_mut(host) {
            if is_plateau && !entry.bandwidth_plateau_detected {
                entry.bandwidth_plateau_detected = true;
                entry.per_connection_ceiling = avg;
                self.dirty = true;
            }
        } else if is_plateau {
            self.profiles.insert(
                host.to_string(),
                PersistedProfile {
                    host: host.to_string(),
                    bandwidth_plateau_detected: true,
                    per_connection_ceiling: avg,
                    ..Default::default()
                },
            );
            self.dirty = true;
        }
        is_plateau
    }

    pub fn store_rate_limit_header(&mut self, host: &str, header: &str) {
        let entry = self
            .profiles
            .entry(host.to_string())
            .or_insert_with(|| PersistedProfile {
                host: host.to_string(),
                ..Default::default()
            });
        if !entry
            .detected_rate_limit_headers
            .contains(&header.to_string())
        {
            entry.detected_rate_limit_headers.push(header.to_string());
            self.dirty = true;
        }
    }

    pub fn get_for_host(&self, host: &str) -> Option<&PersistedProfile> {
        self.profiles.get(host)
    }

    pub fn is_rate_limited(&self, host: &str) -> bool {
        self.profiles
            .get(host)
            .and_then(|p| p.rate_limit_cooldown_until)
            .map(|until| {
                let now = SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                until > now
            })
            .unwrap_or(false)
    }

    pub fn save_if_dirty(&mut self) {
        if !self.dirty {
            return;
        }
        self.save();
        self.dirty = false;
    }

    pub fn save(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&self.profiles) {
            let _ =
                fs::create_dir_all(self.save_path.parent().unwrap_or(std::path::Path::new(".")));
            let _ = fs::write(&self.save_path, json);
        }
    }

    pub fn profile_count(&self) -> usize {
        self.profiles.len()
    }

    pub fn known_hosts(&self) -> Vec<&str> {
        self.profiles.keys().map(|s| s.as_str()).collect()
    }

    fn load_from_disk(path: &PathBuf) -> HashMap<String, PersistedProfile> {
        fs::read_to_string(path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn default_save_path() -> PathBuf {
        let mut dir = dirs().unwrap_or_else(|| PathBuf::from("."));
        dir.push("server_profiles.json");
        dir
    }
}

fn dirs() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(PathBuf::from)
            .map(|p| p.join("Nova"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME")
            .ok()
            .map(PathBuf::from)
            .map(|p| p.join(".nova"))
    }
}

impl Default for PersistedProfile {
    fn default() -> Self {
        Self {
            host: String::new(),
            protocol: "Http11".into(),
            supports_range: false,
            supports_resume: false,
            tls_version: String::new(),
            alpn_protocol: String::new(),
            server_software: String::new(),
            initial_rtt_us: 0,
            handshake_time_us: 0,
            median_rtt_us: 0,
            p95_rtt_us: 0,
            throughput_ceiling: 0,
            per_connection_ceiling: 0,
            optimal_connections: 4,
            stability_score: 0.5,
            total_probes: 0,
            successful_probes: 0,
            rate_limit_cooldown_until: None,
            last_updated: 0,
            bandwidth_plateau_detected: false,
            detected_rate_limit_headers: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> UnifiedProfileStore {
        let dir = std::env::temp_dir().join(format!("nova_profile_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        UnifiedProfileStore::with_path(dir.join("profiles.json"))
    }

    fn cleanup(store: &UnifiedProfileStore) {
        let _ = fs::remove_file(&store.save_path);
        if let Some(parent) = store.save_path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    #[test]
    fn new_creates_empty_store() {
        let store = UnifiedProfileStore::new();
        assert_eq!(store.profile_count(), 0);
    }

    #[test]
    fn get_or_create_inserts() {
        let mut store = temp_store();
        store.get_or_create("example.com");
        assert_eq!(store.profile_count(), 1);
        cleanup(&store);
    }

    #[test]
    fn merge_preflight_creates_profile() {
        let mut store = temp_store();
        let profile = ServerProfile {
            host: "example.com".into(),
            protocol: ProtocolVersion::Http2,
            initial_rtt_us: 50_000,
            handshake_time_us: 30_000,
            ..Default::default()
        };
        store.merge_preflight("example.com", &profile);
        assert_eq!(store.profile_count(), 1);
        let p = store.get_for_host("example.com").unwrap();
        assert_eq!(p.initial_rtt_us, 50_000);
        cleanup(&store);
    }

    #[test]
    fn merge_telemetry_updates() {
        let mut store = temp_store();
        store.merge_telemetry("host.com", 10_000, 500_000, 200);
        let p = store.get_for_host("host.com").unwrap();
        assert_eq!(p.total_probes, 1);
        assert_eq!(p.successful_probes, 1);
        cleanup(&store);
    }

    #[test]
    fn rate_limit_detection() {
        let mut store = temp_store();
        store.merge_telemetry("host.com", 10_000, 500_000, 429);
        assert!(store.is_rate_limited("host.com"));
        cleanup(&store);
    }

    #[test]
    fn bandwidth_plateau_detection() {
        let mut store = temp_store();
        let speeds: Vec<u64> = vec![1_000_000; 15];
        let detected = store.detect_bandwidth_plateau("host.com", &speeds);
        assert!(detected);
        let p = store.get_for_host("host.com").unwrap();
        assert!(p.bandwidth_plateau_detected);
        cleanup(&store);
    }

    #[test]
    fn save_and_load() {
        let mut store = temp_store();
        store.merge_telemetry("host.com", 10_000, 500_000, 200);
        store.save();

        let loaded = UnifiedProfileStore::with_path(store.save_path.clone());
        assert_eq!(loaded.profile_count(), 1);
        cleanup(&store);
    }

    #[test]
    fn store_rate_limit_header() {
        let mut store = temp_store();
        store.store_rate_limit_header("host.com", "X-RateLimit-Limit: 100");
        let p = store.get_for_host("host.com").unwrap();
        assert_eq!(p.detected_rate_limit_headers.len(), 1);
        store.store_rate_limit_header("host.com", "X-RateLimit-Limit: 100");
        let p = store.get_for_host("host.com").unwrap();
        assert_eq!(p.detected_rate_limit_headers.len(), 1);
        cleanup(&store);
    }

    #[test]
    fn persisted_profile_roundtrip() {
        let profile = ServerProfile {
            host: "example.com".into(),
            protocol: ProtocolVersion::Http2,
            supports_range: super::super::server_profiler::TriState::Yes,
            supports_resume: super::super::server_profiler::TriState::Yes,
            initial_rtt_us: 50_000,
            median_rtt_us: 45_000,
            p95_rtt_us: 80_000,
            throughput_ceiling: 10_000_000,
            per_connection_ceiling: 5_000_000,
            optimal_connections: 4,
            stability_score: 0.85,
            total_probes: 20,
            successful_probes: 18,
            ..Default::default()
        };
        let persisted = PersistedProfile::from(&profile);
        assert_eq!(persisted.protocol, "Http2");
        assert!(persisted.supports_range);

        let restored = persisted.to_server_profile();
        assert_eq!(restored.protocol, ProtocolVersion::Http2);
        assert_eq!(restored.initial_rtt_us, 50_000);
        assert_eq!(restored.stability_score, 0.85);
    }

    #[test]
    fn known_hosts_returns_all() {
        let mut store = temp_store();
        store.merge_telemetry("a.com", 1000, 100, 200);
        store.merge_telemetry("b.com", 2000, 200, 200);
        let hosts = store.known_hosts();
        assert_eq!(hosts.len(), 2);
        cleanup(&store);
    }
}
