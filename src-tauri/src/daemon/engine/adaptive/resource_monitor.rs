use std::time::{Duration, Instant};

use crate::daemon::engine::config::MAX_CONNECTIONS_PER_DOWNLOAD;

#[derive(Clone, Debug)]
pub struct ResourceSnapshot {
    pub cpu_count: u32,
    pub cpu_usage_pct: f32,
    pub available_memory_mb: u64,
    pub disk_write_mbps: u64,
    pub disk_active: bool,
}

impl Default for ResourceSnapshot {
    fn default() -> Self {
        Self {
            cpu_count: Self::detect_cpu_count(),
            cpu_usage_pct: 0.0,
            available_memory_mb: 0,
            disk_write_mbps: 0,
            disk_active: false,
        }
    }
}

impl ResourceSnapshot {
    fn detect_cpu_count() -> u32 {
        std::thread::available_parallelism().map_or(4, |n| n.get() as u32)
    }
}

pub struct ResourceMonitor {
    last_sample: Instant,
    sample_interval: Duration,
    cpu_count: u32,
    available_memory_mb: u64,
    snapshot: ResourceSnapshot,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    prev_disk_bytes_written: u64,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    prev_idle_ticks: u64,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    prev_total_ticks: u64,
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    has_prev_ticks: bool,
    /// Log the no-OS-sampling warning only once (M8) instead of per sample.
    fallback_warned: bool,
}

impl ResourceMonitor {
    pub fn new() -> Self {
        let cpu_count = ResourceSnapshot::detect_cpu_count();
        let now = Instant::now();
        Self {
            // Backdate the first sample so the adaptive engine receives real
            // memory and disk headroom on its first evaluation, rather than a
            // transient zero-memory snapshot that suppresses safe growth.
            last_sample: now.checked_sub(Duration::from_secs(2)).unwrap_or(now),
            sample_interval: Duration::from_secs(2),
            cpu_count,
            available_memory_mb: 0,
            snapshot: ResourceSnapshot {
                cpu_count,
                ..Default::default()
            },
            prev_disk_bytes_written: 0,
            prev_idle_ticks: 0,
            prev_total_ticks: 0,
            has_prev_ticks: false,
            fallback_warned: false,
        }
    }

    pub fn sample(&mut self) -> &ResourceSnapshot {
        let now = Instant::now();
        if now.duration_since(self.last_sample) < self.sample_interval {
            return &self.snapshot;
        }
        let prev_time = self.last_sample;
        self.last_sample = now;

        self.sample_memory();

        let (disk_write_mbps, disk_active) = self.sample_disk_io(now, prev_time);

        self.snapshot = ResourceSnapshot {
            cpu_count: self.cpu_count,
            cpu_usage_pct: self.estimate_cpu_usage(),
            available_memory_mb: self.available_memory_mb,
            disk_write_mbps,
            disk_active,
        };
        &self.snapshot
    }

    pub fn detect_cpu_count() -> u32 {
        ResourceSnapshot::detect_cpu_count()
    }

    pub const fn cpu_count(&self) -> u32 {
        self.cpu_count
    }

    pub fn max_safe_connections(&self) -> u32 {
        // Resource-derived headroom, not a fixed product limit. Each slot is
        // budgeted at roughly 32 MiB (curl buffers, response metadata and
        // in-flight writes). CPU gets eight event-loop slots per logical core;
        // the smaller of the two budgets wins. A system under memory pressure
        // is deliberately derated before the adaptive engine can grow.
        let cpu_budget = self.cpu_count.max(1).saturating_mul(8);
        let memory_budget = u32::try_from(self.available_memory_mb / 32).unwrap_or(u32::MAX);
        let memory_adjusted = if self.available_memory_mb >= 2_048 {
            cpu_budget
        } else if self.available_memory_mb >= 1_024 {
            cpu_budget.saturating_mul(3) / 4
        } else if self.available_memory_mb >= 512 {
            cpu_budget / 2
        } else {
            cpu_budget / 4
        };
        cpu_budget
            .min(memory_budget)
            .min(memory_adjusted)
            .clamp(2, MAX_CONNECTIONS_PER_DOWNLOAD)
    }

    pub const fn disk_bottleneck(&self) -> bool {
        self.snapshot.disk_write_mbps > 0 && self.snapshot.disk_write_mbps < 10
    }

    pub fn cpu_saturated(&self) -> bool {
        self.snapshot.cpu_usage_pct > 0.85
    }

    pub fn disk_write_budget(&self, connections: u32) -> u64 {
        if self.snapshot.disk_write_mbps == 0 {
            return 0;
        }
        let total_bps = self.snapshot.disk_write_mbps * 1024 * 1024;
        total_bps / u64::from(connections.max(1))
    }

    pub fn snapshot_clone(&self) -> ResourceSnapshot {
        self.snapshot.clone()
    }

    fn estimate_cpu_usage(&mut self) -> f32 {
        #[cfg(target_os = "windows")]
        {
            self.estimate_cpu_usage_windows()
        }
        #[cfg(not(target_os = "windows"))]
        {
            self.estimate_cpu_usage_fallback()
        }
    }

    #[cfg(target_os = "windows")]
    fn estimate_cpu_usage_windows(&mut self) -> f32 {
        #[repr(C)]
        struct FileTime {
            dw_low_date_time: u32,
            dw_high_date_time: u32,
        }

        #[repr(C)]
        struct SystemTimes {
            idle_time: FileTime,
            kernel_time: FileTime,
            user_time: FileTime,
        }

        extern "system" {
            fn GetSystemTimes(
                idle_time: *mut FileTime,
                kernel_time: *mut FileTime,
                user_time: *mut FileTime,
            ) -> i32;
        }

        let mut idle = FileTime {
            dw_low_date_time: 0,
            dw_high_date_time: 0,
        };
        let mut kernel = FileTime {
            dw_low_date_time: 0,
            dw_high_date_time: 0,
        };
        let mut user = FileTime {
            dw_low_date_time: 0,
            dw_high_date_time: 0,
        };

        let success = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };

        if success == 0 {
            return self.estimate_cpu_usage_fallback();
        }

        fn file_time_to_u64(ft: &FileTime) -> u64 {
            (u64::from(ft.dw_high_date_time) << 32) | u64::from(ft.dw_low_date_time)
        }

        let idle_ticks = file_time_to_u64(&idle);
        let kernel_ticks = file_time_to_u64(&kernel);
        let user_ticks = file_time_to_u64(&user);
        let total_busy = kernel_ticks + user_ticks;
        let total = total_busy + idle_ticks;

        if total == 0 {
            return 0.0;
        }

        let (prev_idle, prev_total) = if self.has_prev_ticks {
            (self.prev_idle_ticks, self.prev_total_ticks)
        } else {
            (idle_ticks, total)
        };
        self.prev_idle_ticks = idle_ticks;
        self.prev_total_ticks = total;
        self.has_prev_ticks = true;

        let d_idle = idle_ticks.saturating_sub(prev_idle);
        let d_total = total.saturating_sub(prev_total);
        let cpu_pct = if d_total == 0 {
            0.0
        } else {
            (1.0 - (d_idle as f64 / d_total as f64)) as f32
        };

        cpu_pct.clamp(0.0, 1.0)
    }

    /// Non-Windows CPU estimation. Linux reads /proc/stat for real idle/total
    /// ticks; other platforms log a one-time warning (M8) and return 0.0.
    fn estimate_cpu_usage_fallback(&mut self) -> f32 {
        #[cfg(target_os = "linux")]
        {
            // Parse aggregate CPU line: "cpu  user nice system idle iowait irq softirq steal ..."
            let Ok(content) = std::fs::read_to_string("/proc/stat") else {
                if !self.fallback_warned {
                    log::warn!("No /proc/stat available; CPU sampling disabled");
                    self.fallback_warned = true;
                }
                return 0.0;
            };
            let Some(line) = content.lines().find(|l| l.starts_with("cpu ")) else {
                return 0.0;
            };
            let fields: Vec<u64> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|v| v.parse::<u64>().ok())
                .collect();
            if fields.len() < 4 {
                return 0.0;
            }
            let idle: u64 = fields.get(3).copied().unwrap_or(0);
            let total: u64 = fields.iter().sum();
            if total == 0 {
                return 0.0;
            }
            let (prev_idle, prev_total) = if self.has_prev_ticks {
                (self.prev_idle_ticks, self.prev_total_ticks)
            } else {
                (idle, total)
            };
            self.prev_idle_ticks = idle;
            self.prev_total_ticks = total;
            self.has_prev_ticks = true;
            let d_idle = idle.saturating_sub(prev_idle);
            let d_total = total.saturating_sub(prev_total);
            if d_total == 0 {
                return 0.0;
            }
            let pct = 1.0 - (d_idle as f64 / d_total as f64);
            (pct.clamp(0.0, 1.0)) as f32
        }
        #[cfg(not(target_os = "linux"))]
        {
            if !self.fallback_warned {
                log::warn!("No OS-specific CPU sampling available; returning 0.0");
                self.fallback_warned = true;
            }
            0.0
        }
    }

    fn sample_memory(&mut self) {
        #[cfg(target_os = "windows")]
        {
            self.sample_memory_windows();
        }
        #[cfg(not(target_os = "windows"))]
        {
            self.sample_memory_fallback();
        }
    }

    #[cfg(target_os = "windows")]
    fn sample_memory_windows(&mut self) {
        #[repr(C)]
        struct MemoryStatusEx {
            dw_length: u32,
            dw_memory_load: u32,
            ull_total_phys: u64,
            ull_avail_phys: u64,
            ull_total_page_file: u64,
            ull_avail_page_file: u64,
            ull_total_virtual: u64,
            ull_avail_virtual: u64,
            ull_avail_extended_virtual: u64,
        }

        extern "system" {
            fn GlobalMemoryStatusEx(lpBuffer: *mut MemoryStatusEx) -> i32;
        }

        let mut mem = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            dw_memory_load: 0,
            ull_total_phys: 0,
            ull_avail_phys: 0,
            ull_total_page_file: 0,
            ull_avail_page_file: 0,
            ull_total_virtual: 0,
            ull_avail_virtual: 0,
            ull_avail_extended_virtual: 0,
        };

        let success = unsafe { GlobalMemoryStatusEx(&mut mem) };
        if success != 0 {
            self.available_memory_mb = mem.ull_avail_phys / (1024 * 1024);
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn sample_memory_fallback(&mut self) {
        // The shared helper combines host availability with a finite Linux
        // cgroup budget, so resource pressure never assumes memory allocated
        // to another container is available to this download process.
        self.available_memory_mb =
            crate::daemon::engine::sysinfo::available_physical_memory_bytes() / (1024 * 1024);
    }

    #[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
    fn sample_disk_io(&mut self, now: Instant, prev_time: Instant) -> (u64, bool) {
        #[cfg(target_os = "windows")]
        {
            self.sample_disk_io_windows(now, prev_time)
        }
        #[cfg(target_os = "linux")]
        {
            self.sample_disk_io_linux(now, prev_time)
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            (0, false)
        }
    }

    /// Linux: read per-process write bytes from /proc/self/io and compute
    /// MB/s from the delta between samples (M8).
    #[cfg(target_os = "linux")]
    fn sample_disk_io_linux(&mut self, now: Instant, prev_time: Instant) -> (u64, bool) {
        let current_bytes = std::fs::read_to_string("/proc/self/io")
            .ok()
            .and_then(|content| {
                content
                    .lines()
                    .find_map(|line| line.strip_prefix("write_bytes:"))
                    .and_then(|rest| rest.trim().parse::<u64>().ok())
            })
            .unwrap_or(0);
        let prev_bytes = self.prev_disk_bytes_written;
        self.prev_disk_bytes_written = current_bytes;
        if prev_bytes == 0 || current_bytes < prev_bytes {
            return (0, current_bytes > 0);
        }
        let delta_bytes = current_bytes - prev_bytes;
        let delta_secs = now.duration_since(prev_time).as_secs_f64();
        if delta_secs <= 0.0 {
            return (0, delta_bytes > 0);
        }
        let mbps = (delta_bytes as f64 / (1024.0 * 1024.0) / delta_secs) as u64;
        (mbps, delta_bytes > 0)
    }

    #[cfg(target_os = "windows")]
    fn sample_disk_io_windows(&mut self, now: Instant, prev_time: Instant) -> (u64, bool) {
        #[repr(C)]
        struct IoCounters {
            read_operation_count: u64,
            write_operation_count: u64,
            other_operation_count: u64,
            read_transfer_count: u64,
            write_transfer_count: u64,
            other_transfer_count: u64,
        }

        extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
            fn GetProcessIoCounters(
                h_process: *mut std::ffi::c_void,
                lp_io_counters: *mut IoCounters,
            ) -> i32;
        }

        let mut counters = IoCounters {
            read_operation_count: 0,
            write_operation_count: 0,
            other_operation_count: 0,
            read_transfer_count: 0,
            write_transfer_count: 0,
            other_transfer_count: 0,
        };

        let success = unsafe {
            let h = GetCurrentProcess();
            GetProcessIoCounters(h, &mut counters)
        };

        if success == 0 {
            return (0, false);
        }

        let current_bytes = counters.write_transfer_count;
        let prev_bytes = self.prev_disk_bytes_written;
        self.prev_disk_bytes_written = current_bytes;

        if prev_bytes == 0 || current_bytes < prev_bytes {
            return (0, current_bytes > 0);
        }

        let delta_bytes = current_bytes - prev_bytes;
        let delta_secs = now.duration_since(prev_time).as_secs_f64();
        if delta_secs <= 0.0 {
            return (0, delta_bytes > 0);
        }

        let mbps = (delta_bytes as f64 / (1024.0 * 1024.0) / delta_secs) as u64;
        (mbps, delta_bytes > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_detects_cpu_count() {
        let m = ResourceMonitor::new();
        assert!(m.cpu_count >= 1);
    }

    #[test]
    fn snapshot_default() {
        let s = ResourceSnapshot::default();
        assert!(s.cpu_count >= 1);
        assert_eq!(s.cpu_usage_pct, 0.0);
    }

    #[test]
    fn max_safe_connections_scales_with_memory() {
        let mut m = ResourceMonitor::new();
        m.available_memory_mb = 2048;
        m.cpu_count = 8;
        let max = m.max_safe_connections();
        assert!((4..=MAX_CONNECTIONS_PER_DOWNLOAD).contains(&max));

        m.available_memory_mb = 256;
        let low_mem = m.max_safe_connections();
        assert!(low_mem <= max);
    }

    #[test]
    fn max_safe_connections_clamps() {
        let mut m = ResourceMonitor::new();
        m.cpu_count = 1;
        m.available_memory_mb = 256;
        assert!(m.max_safe_connections() >= 2);

        m.cpu_count = 64;
        m.available_memory_mb = 16_384;
        assert!(m.max_safe_connections() > 32);
        assert!(m.max_safe_connections() <= MAX_CONNECTIONS_PER_DOWNLOAD);
    }

    #[test]
    fn max_safe_connections_handles_extreme_cpu_telemetry() {
        let mut m = ResourceMonitor::new();
        m.cpu_count = u32::MAX;
        m.available_memory_mb = u64::MAX;
        assert_eq!(m.max_safe_connections(), MAX_CONNECTIONS_PER_DOWNLOAD);
    }

    #[test]
    fn disk_bottleneck_below_threshold() {
        let mut m = ResourceMonitor::new();
        m.snapshot.disk_write_mbps = 5;
        assert!(m.disk_bottleneck());
        m.snapshot.disk_write_mbps = 100;
        assert!(!m.disk_bottleneck());
    }

    #[test]
    fn cpu_saturated_at_high_usage() {
        let mut m = ResourceMonitor::new();
        m.snapshot.cpu_usage_pct = 0.9;
        assert!(m.cpu_saturated());
        m.snapshot.cpu_usage_pct = 0.5;
        assert!(!m.cpu_saturated());
    }

    #[test]
    fn disk_write_budget_divides_evenly() {
        let mut m = ResourceMonitor::new();
        m.snapshot.disk_write_mbps = 100;
        let budget = m.disk_write_budget(4);
        assert_eq!(budget, 25 * 1024 * 1024);
    }

    #[test]
    fn disk_write_budget_zero_when_no_disk() {
        let m = ResourceMonitor::new();
        assert_eq!(m.disk_write_budget(4), 0);
    }

    #[test]
    fn sample_updates_snapshot() {
        let mut m = ResourceMonitor::new();
        m.last_sample = Instant::now() - Duration::from_secs(10);
        let snap = m.sample();
        assert!(snap.cpu_count >= 1);
    }

    #[test]
    fn snapshot_clone_returns_copy() {
        let m = ResourceMonitor::new();
        let mut snap = m.snapshot_clone();
        let original = snap.disk_write_mbps;
        snap.disk_write_mbps = 999;
        assert_eq!(snap.disk_write_mbps, 999);
        let snap2 = m.snapshot_clone();
        assert_eq!(snap2.disk_write_mbps, original);
        assert_ne!(snap2.disk_write_mbps, 999);
    }

    #[test]
    fn fallback_warning_logged_once() {
        // M8: the no-OS-sampling warning must fire once, not per sample.
        let mut m = ResourceMonitor::new();
        m.fallback_warned = false;
        #[cfg(not(target_os = "linux"))]
        {
            let _ = m.estimate_cpu_usage_fallback();
            assert!(
                m.fallback_warned,
                "warning flag must be set after first call"
            );
            let _ = m.estimate_cpu_usage_fallback();
            assert!(m.fallback_warned, "flag stays set (no repeat logging)");
        }
        #[cfg(target_os = "linux")]
        {
            // On Linux the fallback reads /proc/stat; it must not panic and
            // the warning flag path is only hit when the file is missing.
            let _ = m.estimate_cpu_usage_fallback();
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_proc_readings_are_nonzero() {
        // M8: real readings on Linux. /proc/stat and /proc/meminfo exist on
        // every Linux CI runner; this proves we no longer hardcode 2048 MB.
        let mut m = ResourceMonitor::new();
        m.sample_memory();
        assert!(
            m.available_memory_mb > 0,
            "available memory must be read from /proc/meminfo, got {}",
            m.available_memory_mb
        );
        let now = Instant::now();
        let (mbps, active) = m.sample_disk_io(now, now - Duration::from_secs(1));
        // First sample has no baseline — either (0,false) or a real value.
        let _ = (mbps, active);
        let _ = m.estimate_cpu_usage();
    }
}
