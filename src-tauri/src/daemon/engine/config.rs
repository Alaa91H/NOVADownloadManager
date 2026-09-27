use std::sync::OnceLock;
use std::time::Duration;

/// Safety bounds for concurrent connections assigned to a single download.
/// They are internal engine limits, not user-facing controls. The adaptive
/// ceiling grows only when both processor and memory headroom justify it.
pub const MIN_CONNECTIONS_PER_DOWNLOAD: u32 = 1;
pub const DEFAULT_CONNECTIONS_PER_DOWNLOAD_CEILING: u32 = 32;
pub const MAX_CONNECTIONS_PER_DOWNLOAD: u32 = 512;
pub const MAX_TOTAL_CONNECTIONS: u32 = 2_048;

/// Unified autonomous engine configuration. All values are either system-derived
/// at startup or adapted at runtime by the Download Intelligence Engine. No value
/// here is ever exposed to the user as a setting.
#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub max_connections_per_download: u32,
    pub max_total_connections: u32,
    pub min_segment_bytes: u64,
    pub initial_segments: u32,
    pub max_retries: u32,
    pub base_retry_delay_ms: u64,
    pub max_retry_delay_ms: u64,
    pub backoff_multiplier: f64,
    pub write_buffer_bytes: usize,
    pub read_buffer_bytes: usize,
    pub flush_interval_ms: u64,
    pub worker_threads: u32,
    /// Hard cap for the default overall transfer timeout (seconds) applied
    /// when no per-download `timeoutSec` is set. Prevents hung transfers
    /// (stuck DNS, stalled TLS handshake, silent server) from running forever.
    pub default_timeout_sec: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self::detect()
    }
}

fn cpu_count() -> u32 {
    std::thread::available_parallelism().map_or(4, |n| n.get() as u32)
}

/// Returns a shared singleton `EngineConfig`. First call detects system resources.
pub fn global_config() -> &'static EngineConfig {
    static INSTANCE: OnceLock<EngineConfig> = OnceLock::new();
    INSTANCE.get_or_init(EngineConfig::detect)
}

impl EngineConfig {
    /// Detect system resources and build the initial autonomous config.
    pub fn detect() -> Self {
        let cpus = cpu_count();
        let total_ram = crate::daemon::engine::sysinfo::total_physical_memory_bytes();

        // Permit growth beyond the former fixed 32-connection ceiling only
        // when the host can sustain it. Eight connections per logical core is
        // deliberately conservative for libcurl's event loop, while 32 MiB of
        // available RAM per live transfer slot prevents memory pressure from
        // turning parallelism into instability. The absolute cap is a final
        // circuit-breaker, not a normal operating target.
        let cpu_ceiling = cpus.saturating_mul(8);
        let memory_ceiling = u32::try_from(total_ram / (32 * 1024 * 1024)).unwrap_or(u32::MAX);
        let max_connections_per_download = cpu_ceiling
            .min(memory_ceiling)
            .max(DEFAULT_CONNECTIONS_PER_DOWNLOAD_CEILING.min(cpu_ceiling))
            .clamp(MIN_CONNECTIONS_PER_DOWNLOAD, MAX_CONNECTIONS_PER_DOWNLOAD);
        let max_total_connections = cpus.saturating_mul(16).clamp(
            DEFAULT_CONNECTIONS_PER_DOWNLOAD_CEILING,
            MAX_TOTAL_CONNECTIONS,
        );

        let min_segment_bytes = 256 * 1024;
        let initial_segments = cpus.clamp(1, 4);

        let max_retries = 5;
        let base_retry_delay_ms = 1000;
        let max_retry_delay_ms = 30_000;
        let backoff_multiplier = 2.0;

        let write_buffer_bytes = if total_ram > 4 * 1024 * 1024 * 1024 {
            256 * 1024
        } else {
            64 * 1024
        };
        let read_buffer_bytes = if total_ram > 4 * 1024 * 1024 * 1024 {
            128 * 1024
        } else {
            32 * 1024
        };

        let flush_interval_ms = 100;
        let worker_threads = cpus;

        Self {
            max_connections_per_download,
            max_total_connections,
            min_segment_bytes,
            initial_segments,
            max_retries,
            base_retry_delay_ms,
            max_retry_delay_ms,
            backoff_multiplier,
            write_buffer_bytes,
            read_buffer_bytes,
            flush_interval_ms,
            worker_threads,
            default_timeout_sec: 7200,
        }
    }

    pub const fn retry_policy(&self) -> crate::daemon::engine::retry::RetryPolicy {
        crate::daemon::engine::retry::RetryPolicy {
            max_retries: self.max_retries,
            base_delay: Duration::from_millis(self.base_retry_delay_ms),
            max_delay: Duration::from_millis(self.max_retry_delay_ms),
            backoff_multiplier: self.backoff_multiplier,
            jitter: true,
        }
    }

    pub fn connection_limits_for(
        &self,
        requested: u32,
        url: &str,
    ) -> crate::daemon::direct::ConnectionLimits {
        let requested = requested.clamp(
            MIN_CONNECTIONS_PER_DOWNLOAD,
            self.max_connections_per_download,
        ) as usize;
        let learned = crate::daemon::direct::learned_host_ceiling(url)
            .unwrap_or(self.max_connections_per_download as usize);
        let per_host = requested.min(learned).max(1);
        let total = requested.max(1);
        // M29: (total*2).max(total) is just total*2 — but cap it so a huge
        // requested count cannot blow past the global ceiling.
        let cache = (total * 2).min(self.max_total_connections as usize * 4);
        crate::daemon::direct::ConnectionLimits {
            total,
            per_host,
            cache,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_produces_valid_config() {
        let cfg = EngineConfig::detect();
        assert!(cfg.max_connections_per_download >= MIN_CONNECTIONS_PER_DOWNLOAD);
        assert!(cfg.max_connections_per_download <= MAX_CONNECTIONS_PER_DOWNLOAD);
        assert!(cfg.max_total_connections >= 4);
        assert!(cfg.initial_segments >= 1);
        assert!(cfg.min_segment_bytes >= 256 * 1024);
        assert!(cfg.max_retries >= 1);
        assert!(cfg.backoff_multiplier >= 1.0);
        assert!(cfg.write_buffer_bytes >= 32 * 1024);
        assert!(cfg.read_buffer_bytes >= 32 * 1024);
        assert!(cfg.worker_threads >= 1);
        assert!(cfg.default_timeout_sec >= 60);
    }

    #[test]
    fn global_config_returns_same_instance() {
        let a = global_config();
        let b = global_config();
        let a_ptr = a as *const EngineConfig;
        let b_ptr = b as *const EngineConfig;
        assert_eq!(a_ptr, b_ptr);
    }

    #[test]
    fn retry_policy_uses_config_values() {
        let cfg = EngineConfig::detect();
        let policy = cfg.retry_policy();
        assert_eq!(policy.max_retries, cfg.max_retries);
        assert_eq!(
            policy.base_delay,
            Duration::from_millis(cfg.base_retry_delay_ms)
        );
        assert_eq!(
            policy.max_delay,
            Duration::from_millis(cfg.max_retry_delay_ms)
        );
        assert_eq!(policy.backoff_multiplier, cfg.backoff_multiplier);
        assert!(policy.jitter);
    }

    #[test]
    fn connection_limits_respects_learned_ceiling() {
        let cfg = EngineConfig::detect();
        let limits = cfg.connection_limits_for(16, "https://example.com/file.zip");
        assert!(limits.total >= 1);
        assert!(limits.per_host >= 1);
        assert!(limits.cache >= limits.total);
    }

    #[test]
    fn detect_scales_with_memory() {
        let cfg = EngineConfig::detect();
        assert!(cfg.write_buffer_bytes >= 64 * 1024);
        assert!(cfg.read_buffer_bytes >= 32 * 1024);
    }

    #[test]
    fn dynamic_connection_ceiling_can_exceed_legacy_default() {
        let cfg = EngineConfig::detect();
        assert!(cfg.max_connections_per_download >= MIN_CONNECTIONS_PER_DOWNLOAD);
        assert!(cfg.max_connections_per_download <= MAX_CONNECTIONS_PER_DOWNLOAD);
        assert!(cfg.max_total_connections >= DEFAULT_CONNECTIONS_PER_DOWNLOAD_CEILING);
        assert!(cfg.max_total_connections <= MAX_TOTAL_CONNECTIONS);
    }
}
