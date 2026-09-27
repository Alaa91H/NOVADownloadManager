use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::config::global_config;

const MIN_CONNECTIONS: u32 = 1;

#[derive(Clone, Debug)]
pub struct AdaptiveConfig {
    pub min_connections: u32,
    pub max_connections: u32,
    pub speed_high_threshold: u64,
    pub speed_low_threshold: u64,
    pub stall_threshold: Duration,
    pub eval_interval: Duration,
}

impl Default for AdaptiveConfig {
    fn default() -> Self {
        let cfg = global_config();
        let max_conns = cfg.max_connections_per_download;
        let avg_cores = (cfg.worker_threads / 2).max(1);
        let speed_high = (u64::from(avg_cores) * 2 * 1024 * 1024).max(2 * 1024 * 1024);
        let speed_low = (u64::from(avg_cores) * 64 * 1024).max(100 * 1024);
        Self {
            min_connections: MIN_CONNECTIONS,
            max_connections: max_conns,
            speed_high_threshold: speed_high,
            speed_low_threshold: speed_low,
            stall_threshold: Duration::from_secs(5),
            eval_interval: Duration::from_secs(2),
        }
    }
}

#[derive(Clone)]
pub struct AdaptiveConnectionManager {
    pub current_connections: Arc<AtomicU32>,
    pub max_connections: Arc<AtomicU32>,
    pub current_speed: Arc<AtomicU64>,
    pub peak_speed: Arc<AtomicU64>,
}

impl AdaptiveConnectionManager {
    pub fn new(initial_connections: u32, config: AdaptiveConfig) -> Self {
        // `AdaptiveConfig` is public and can be supplied by callers other than
        // the validated global configuration. Normalize its bounds before
        // calling `clamp`, which panics when min > max, and preserve the
        // invariant that a live manager always represents at least one slot.
        let max_connections = config.max_connections.max(MIN_CONNECTIONS);
        let min_connections = config
            .min_connections
            .clamp(MIN_CONNECTIONS, max_connections);
        let conns = initial_connections.clamp(min_connections, max_connections);
        Self {
            current_connections: Arc::new(AtomicU32::new(conns)),
            max_connections: Arc::new(AtomicU32::new(max_connections)),
            current_speed: Arc::new(AtomicU64::new(0)),
            peak_speed: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Update the reported live connection count while preserving the manager's
    /// configured bounds. The transfer engine calls this after bandwidth-aware
    /// planning and every adaptive handle rebuild, so API consumers do not see
    /// the stale user-requested count while a different number is actually live.
    pub fn set_connections(&self, connections: u32) {
        let max_connections = self
            .max_connections
            .load(Ordering::Relaxed)
            .max(MIN_CONNECTIONS);
        self.current_connections.store(
            connections.clamp(MIN_CONNECTIONS, max_connections),
            Ordering::Relaxed,
        );
    }

    pub fn report_speed(&self, bytes_per_sec: u64) {
        self.current_speed.store(bytes_per_sec, Ordering::Relaxed);
        self.peak_speed.fetch_max(bytes_per_sec, Ordering::Relaxed);
    }

    pub fn connections(&self) -> u32 {
        self.current_connections.load(Ordering::Relaxed)
    }

    pub fn speed(&self) -> u64 {
        self.current_speed.load(Ordering::Relaxed)
    }

    pub fn peak_speed(&self) -> u64 {
        self.peak_speed.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_config() -> AdaptiveConfig {
        AdaptiveConfig {
            min_connections: 1,
            max_connections: 16,
            speed_high_threshold: 1024 * 1024,
            speed_low_threshold: 100 * 1024,
            stall_threshold: Duration::from_millis(50),
            eval_interval: Duration::from_millis(1),
        }
    }

    #[test]
    fn new_clamps_to_config_bounds() {
        let mgr = AdaptiveConnectionManager::new(100, fast_config());
        assert_eq!(mgr.connections(), 16);
        let mgr = AdaptiveConnectionManager::new(0, fast_config());
        assert_eq!(mgr.connections(), 1);
    }

    #[test]
    fn report_speed_updates_speed_and_peak() {
        let mgr = AdaptiveConnectionManager::new(4, fast_config());
        mgr.report_speed(500_000);
        assert_eq!(mgr.speed(), 500_000);
        assert_eq!(mgr.peak_speed(), 500_000);
        mgr.report_speed(200_000);
        assert_eq!(mgr.speed(), 200_000);
        assert_eq!(mgr.peak_speed(), 500_000);
    }

    #[test]
    fn invalid_config_bounds_are_normalized_without_panicking() {
        let config = AdaptiveConfig {
            min_connections: 8,
            max_connections: 0,
            ..fast_config()
        };
        let mgr = AdaptiveConnectionManager::new(0, config);
        assert_eq!(mgr.connections(), 1);
        assert_eq!(mgr.max_connections.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn set_connections_tracks_live_count_within_bounds() {
        let mgr = AdaptiveConnectionManager::new(4, fast_config());
        mgr.set_connections(7);
        assert_eq!(mgr.connections(), 7);
        mgr.set_connections(100);
        assert_eq!(mgr.connections(), 16);
        mgr.set_connections(0);
        assert_eq!(mgr.connections(), 1);
    }
}
