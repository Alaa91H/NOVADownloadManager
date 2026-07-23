use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
        let mem_gb = cfg.write_buffer_bytes / (256 * 1024);
        let speed_high = (avg_cores as u64 * 2 * 1024 * 1024).max(2 * 1024 * 1024);
        let speed_low = (avg_cores as u64 * 64 * 1024).max(100 * 1024);
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

impl AdaptiveConfig {
    pub fn aggressive() -> Self {
        let base = Self::default();
        Self {
            min_connections: 2,
            max_connections: (base.max_connections * 3 / 2).min(48),
            speed_high_threshold: base.speed_high_threshold * 2,
            speed_low_threshold: base.speed_low_threshold / 2,
            stall_threshold: Duration::from_secs(3),
            eval_interval: Duration::from_millis(1500),
        }
    }

    pub fn conservative() -> Self {
        let base = Self::default();
        Self {
            min_connections: 1,
            max_connections: (base.max_connections / 2).max(4),
            speed_high_threshold: base.speed_high_threshold / 2,
            speed_low_threshold: base.speed_low_threshold * 2,
            stall_threshold: Duration::from_secs(10),
            eval_interval: Duration::from_secs(5),
        }
    }
}

#[derive(Clone)]
pub struct AdaptiveConnectionManager {
    pub current_connections: Arc<AtomicU32>,
    pub max_connections: Arc<AtomicU32>,
    pub current_speed: Arc<AtomicU64>,
    pub peak_speed: Arc<AtomicU64>,
    last_eval: Arc<std::sync::Mutex<Instant>>,
    config: AdaptiveConfig,
    stall_start: Arc<std::sync::Mutex<Option<Instant>>>,
    speed_samples: Arc<std::sync::Mutex<std::collections::VecDeque<u64>>>,
}

impl AdaptiveConnectionManager {
    pub fn new(initial_connections: u32, config: AdaptiveConfig) -> Self {
        let conns = initial_connections.clamp(config.min_connections, config.max_connections);
        Self {
            current_connections: Arc::new(AtomicU32::new(conns)),
            max_connections: Arc::new(AtomicU32::new(config.max_connections)),
            current_speed: Arc::new(AtomicU64::new(0)),
            peak_speed: Arc::new(AtomicU64::new(0)),
            last_eval: Arc::new(std::sync::Mutex::new(Instant::now())),
            config,
            stall_start: Arc::new(std::sync::Mutex::new(None)),
            speed_samples: Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
        }
    }

    pub fn report_speed(&self, bytes_per_sec: u64) {
        self.current_speed.store(bytes_per_sec, Ordering::Relaxed);
        self.peak_speed.fetch_max(bytes_per_sec, Ordering::Relaxed);
        if let Ok(mut samples) = self.speed_samples.lock() {
            samples.push_back(bytes_per_sec);
            if samples.len() > 20 {
                samples.pop_front();
            }
        }
        if bytes_per_sec == 0 {
            if let Ok(mut stall) = self.stall_start.lock() {
                if stall.is_none() {
                    *stall = Some(Instant::now());
                }
            }
        } else {
            if let Ok(mut stall) = self.stall_start.lock() {
                *stall = None;
            }
        }
    }

    pub fn should_adjust(&self) -> Option<Adjustment> {
        let last = match self.last_eval.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        if last.elapsed() < self.config.eval_interval {
            return None;
        }
        drop(last);
        if let Ok(mut last) = self.last_eval.lock() {
            *last = Instant::now();
        }

        let speed = self.current_speed.load(Ordering::Relaxed);
        let current = self.current_connections.load(Ordering::Relaxed);
        let is_stalled = self
            .stall_start
            .lock()
            .ok()
            .and_then(|s| *s)
            .map(|t| t.elapsed() > self.config.stall_threshold)
            .unwrap_or(false);

        if is_stalled && current > self.config.min_connections {
            let new_count = (current / 2).max(self.config.min_connections);
            return Some(Adjustment {
                old_count: current,
                new_count,
                reason: format!(
                    "Speed stalled for >{}ms; reducing connections",
                    self.config.stall_threshold.as_millis()
                ),
            });
        }

        if speed > self.config.speed_high_threshold && current < self.config.max_connections {
            let speed_ratio = speed as f64 / self.config.speed_high_threshold as f64;
            let increase = ((speed_ratio - 1.0) * current as f64).ceil() as u32;
            let new_count = (current + increase).min(self.config.max_connections);
            if new_count > current {
                return Some(Adjustment {
                    old_count: current,
                    new_count,
                    reason: format!(
                        "Speed {}MB/s exceeds high threshold; increasing connections",
                        speed / (1024 * 1024)
                    ),
                });
            }
        }

        if speed < self.config.speed_low_threshold
            && current > self.config.min_connections
            && !is_stalled
        {
            let avg = self.avg_speed();
            if avg < self.config.speed_low_threshold {
                let new_count = (current - 1).max(self.config.min_connections);
                return Some(Adjustment {
                    old_count: current,
                    new_count,
                    reason: format!("Average speed {}KB/s below low threshold", avg / 1024),
                });
            }
        }

        None
    }

    pub fn apply_adjustment(&self, adj: &Adjustment) {
        self.current_connections
            .store(adj.new_count, Ordering::Relaxed);
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

    fn avg_speed(&self) -> u64 {
        self.speed_samples
            .lock()
            .map(|samples| {
                if samples.is_empty() {
                    0
                } else {
                    samples.iter().sum::<u64>() / samples.len() as u64
                }
            })
            .unwrap_or(0)
    }
}

#[derive(Clone, Debug)]
pub struct Adjustment {
    pub old_count: u32,
    pub new_count: u32,
    pub reason: String,
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
    fn apply_adjustment_updates_connections() {
        let mgr = AdaptiveConnectionManager::new(4, fast_config());
        mgr.apply_adjustment(&Adjustment {
            old_count: 4,
            new_count: 8,
            reason: "test".into(),
        });
        assert_eq!(mgr.connections(), 8);
    }

    #[test]
    fn should_adjust_returns_none_too_soon() {
        let mgr = AdaptiveConnectionManager::new(4, fast_config());
        mgr.report_speed(0);
        assert!(mgr.should_adjust().is_none());
    }

    #[test]
    fn avg_speed_empty_returns_zero() {
        let mgr = AdaptiveConnectionManager::new(4, fast_config());
        assert_eq!(mgr.avg_speed(), 0);
    }

    #[test]
    fn avg_speed_with_samples() {
        let mgr = AdaptiveConnectionManager::new(4, fast_config());
        mgr.report_speed(100);
        mgr.report_speed(200);
        mgr.report_speed(300);
        assert_eq!(mgr.avg_speed(), 200);
    }
}
