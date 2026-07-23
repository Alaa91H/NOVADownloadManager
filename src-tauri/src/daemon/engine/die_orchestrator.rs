#![allow(dead_code, clippy::manual_checked_ops)]
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::adaptive::profile_store::UnifiedProfileStore;
use super::config::global_config;
use super::resource_manager::ResourceManager;

pub struct DieOrchestrator {
    pub resource_manager: Arc<Mutex<ResourceManager>>,
    pub profile_store: Arc<Mutex<UnifiedProfileStore>>,
    host_connections: HashMap<String, u32>,
}

impl DieOrchestrator {
    pub fn new() -> Self {
        Self {
            resource_manager: Arc::new(Mutex::new(ResourceManager::new())),
            profile_store: Arc::new(Mutex::new(UnifiedProfileStore::new())),
            host_connections: HashMap::new(),
        }
    }

    pub fn resource_manager(&self) -> Arc<Mutex<ResourceManager>> {
        self.resource_manager.clone()
    }

    pub fn profile_store(&self) -> Arc<Mutex<UnifiedProfileStore>> {
        self.profile_store.clone()
    }

    pub fn recommended_connections_for_host(&mut self, host: &str, requested: u32) -> u32 {
        let cfg = global_config();
        let max_per_download = cfg.max_connections_per_download;
        let max_total = cfg.max_total_connections;
        let current_total: u32 = self.host_connections.values().sum();

        let host_used = self.host_connections.get(host).copied().unwrap_or(0);
        let host_available = max_per_download.saturating_sub(host_used);
        let global_available = max_total.saturating_sub(current_total);

        let learned = self
            .profile_store
            .lock()
            .ok()
            .and_then(|store| store.get_for_host(host).cloned())
            .map(|p| {
                if p.optimal_connections > 0 {
                    p.optimal_connections
                } else if p.per_connection_ceiling > 0 {
                    let target = (p.throughput_ceiling / p.per_connection_ceiling).max(1) as u32;
                    target.min(max_per_download)
                } else {
                    requested
                }
            })
            .unwrap_or(requested);

        let mut result = learned.min(host_available).min(global_available);
        result = result.max(1);
        result
    }

    pub fn register_connection(&mut self, host: &str, count: u32) {
        *self.host_connections.entry(host.to_string()).or_insert(0) = count;
    }

    pub fn release_connections(&mut self, host: &str, count: u32) {
        if let Some(current) = self.host_connections.get_mut(host) {
            *current = current.saturating_sub(count);
        }
    }

    pub fn record_telemetry(&mut self, host: &str, rtt_us: u64, speed: u64, http_status: u16) {
        if let Ok(mut store) = self.profile_store.lock() {
            store.merge_telemetry(host, rtt_us, speed, http_status);
            store.save_if_dirty();
        }
        if let Ok(mut rm) = self.resource_manager.lock() {
            rm.update_network(speed, self.host_connections.get(host).copied().unwrap_or(1));
        }
    }

    pub fn record_preflight(
        &mut self,
        host: &str,
        profile: &super::adaptive::server_profiler::ServerProfile,
    ) {
        if let Ok(mut store) = self.profile_store.lock() {
            store.merge_preflight(host, profile);
            store.save();
        }
    }

    pub fn detect_plateau(&mut self, host: &str, recent_speeds: &[u64]) -> bool {
        self.profile_store
            .lock()
            .map(|mut store| store.detect_bandwidth_plateau(host, recent_speeds))
            .unwrap_or(false)
    }

    pub fn is_rate_limited(&self, host: &str) -> bool {
        self.profile_store
            .lock()
            .map(|store| store.is_rate_limited(host))
            .unwrap_or(false)
    }

    pub fn shutdown(&self) {
        if let Ok(store) = self.profile_store.lock() {
            store.save();
        }
    }
}

impl Default for DieOrchestrator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_orchestrator() -> (DieOrchestrator, PathBuf) {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("nova_die_test_{}_{}", std::process::id(), id));
        std::fs::create_dir_all(&dir).unwrap();
        let profile_path = dir.join("profiles.json");
        let profile_store = UnifiedProfileStore::with_path(profile_path);
        let resource_manager = ResourceManager::new();
        (
            DieOrchestrator {
                resource_manager: Arc::new(Mutex::new(resource_manager)),
                profile_store: Arc::new(Mutex::new(profile_store)),
                host_connections: HashMap::new(),
            },
            dir,
        )
    }

    fn cleanup(dir: &PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn new_creates_orchestrator() {
        let (orch, dir) = temp_orchestrator();
        assert_eq!(orch.host_connections.len(), 0);
        cleanup(&dir);
    }

    #[test]
    fn recommended_connections_starts_at_requested() {
        let (mut orch, dir) = temp_orchestrator();
        let rec = orch.recommended_connections_for_host("example.com", 4);
        assert!(rec >= 1);
        assert!(rec <= 4);
        cleanup(&dir);
    }

    #[test]
    fn register_and_release_connections() {
        let (mut orch, dir) = temp_orchestrator();
        orch.register_connection("host.com", 4);
        assert_eq!(orch.host_connections.get("host.com"), Some(&4));
        orch.release_connections("host.com", 2);
        assert_eq!(orch.host_connections.get("host.com"), Some(&2));
        cleanup(&dir);
    }

    #[test]
    fn release_does_not_underflow() {
        let (mut orch, dir) = temp_orchestrator();
        orch.register_connection("host.com", 2);
        orch.release_connections("host.com", 10);
        assert_eq!(orch.host_connections.get("host.com"), Some(&0));
        cleanup(&dir);
    }

    #[test]
    fn recommended_connections_considers_global_limit() {
        let (mut orch, dir) = temp_orchestrator();
        let cfg = global_config();
        let max_total = cfg.max_total_connections;
        orch.register_connection("a.com", max_total - 1);
        let rec = orch.recommended_connections_for_host("b.com", 16);
        assert!(rec >= 1);
        assert!(rec <= 2);
        cleanup(&dir);
    }

    #[test]
    fn record_telemetry_doesnt_panic() {
        let (mut orch, dir) = temp_orchestrator();
        orch.record_telemetry("host.com", 10_000, 500_000, 200);
        orch.record_telemetry("host.com", 15_000, 400_000, 200);
        cleanup(&dir);
    }

    #[test]
    fn record_preflight_doesnt_panic() {
        let (mut orch, dir) = temp_orchestrator();
        let profile = super::super::adaptive::server_profiler::ServerProfile {
            host: "host.com".into(),
            initial_rtt_us: 50_000,
            handshake_time_us: 30_000,
            ..Default::default()
        };
        orch.record_preflight("host.com", &profile);
        cleanup(&dir);
    }

    #[test]
    fn detect_plateau_works() {
        let (mut orch, dir) = temp_orchestrator();
        let speeds = vec![1_000_000; 15];
        let detected = orch.detect_plateau("host.com", &speeds);
        assert!(detected);
        cleanup(&dir);
    }
}
