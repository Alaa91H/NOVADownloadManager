#![allow(dead_code, clippy::manual_range_contains, unused_assignments)]
use std::time::{Duration, Instant};

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
        std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4)
    }
}

pub struct ResourceMonitor {
    last_sample: Instant,
    sample_interval: Duration,
    cpu_count: u32,
    available_memory_mb: u64,
    disk_write_bytes: u64,
    last_disk_write_bytes: u64,
    last_disk_sample_time: Instant,
    disk_write_mbps: u64,
    snapshot: ResourceSnapshot,
}

impl ResourceMonitor {
    pub fn new() -> Self {
        let cpu_count = ResourceSnapshot::detect_cpu_count();
        Self {
            last_sample: Instant::now(),
            sample_interval: Duration::from_secs(2),
            cpu_count,
            available_memory_mb: 0,
            disk_write_bytes: 0,
            last_disk_write_bytes: 0,
            last_disk_sample_time: Instant::now(),
            disk_write_mbps: 0,
            snapshot: ResourceSnapshot {
                cpu_count,
                ..Default::default()
            },
        }
    }

    pub fn sample(&mut self) -> &ResourceSnapshot {
        let now = Instant::now();
        if now.duration_since(self.last_sample) < self.sample_interval {
            return &self.snapshot;
        }
        self.last_sample = now;

        self.sample_memory();
        self.sample_disk_io();

        self.snapshot = ResourceSnapshot {
            cpu_count: self.cpu_count,
            cpu_usage_pct: self.estimate_cpu_usage(),
            available_memory_mb: self.available_memory_mb,
            disk_write_mbps: self.disk_write_mbps,
            disk_active: self.disk_write_mbps > 0,
        };
        &self.snapshot
    }

    pub fn detect_cpu_count() -> u32 {
        ResourceSnapshot::detect_cpu_count()
    }

    pub fn cpu_count(&self) -> u32 {
        self.cpu_count
    }

    pub fn max_safe_connections(&self) -> u32 {
        let base = self.cpu_count * 2;
        let mem_factor = if self.available_memory_mb > 1024 {
            base
        } else if self.available_memory_mb > 512 {
            (base * 3) / 4
        } else {
            base / 2
        };
        mem_factor.clamp(2, 32)
    }

    pub fn disk_bottleneck(&self) -> bool {
        self.disk_write_mbps > 0 && self.disk_write_mbps < 10
    }

    pub fn cpu_saturated(&self) -> bool {
        self.snapshot.cpu_usage_pct > 0.85
    }

    pub fn disk_write_budget(&self, connections: u32) -> u64 {
        if self.disk_write_mbps == 0 {
            return 0;
        }
        let total_bps = self.disk_write_mbps * 1024 * 1024;
        total_bps / connections.max(1) as u64
    }

    pub fn snapshot_clone(&self) -> ResourceSnapshot {
        self.snapshot.clone()
    }

    fn estimate_cpu_usage(&self) -> f32 {
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
    fn estimate_cpu_usage_windows(&self) -> f32 {
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
            ((ft.dw_high_date_time as u64) << 32) | (ft.dw_low_date_time as u64)
        }

        let idle_ticks = file_time_to_u64(&idle);
        let kernel_ticks = file_time_to_u64(&kernel);
        let user_ticks = file_time_to_u64(&user);
        let total_busy = kernel_ticks + user_ticks;
        let total = total_busy + idle_ticks;

        if total == 0 {
            return 0.0;
        }

        static mut PREV_IDLE: u64 = 0;
        static mut PREV_TOTAL: u64 = 0;

        let cpu_pct = unsafe {
            let d_idle = idle_ticks.saturating_sub(PREV_IDLE);
            let d_total = total.saturating_sub(PREV_TOTAL);
            PREV_IDLE = idle_ticks;
            PREV_TOTAL = total;

            if d_total == 0 {
                0.0
            } else {
                (1.0 - (d_idle as f64 / d_total as f64)) as f32
            }
        };

        cpu_pct.clamp(0.0, 1.0)
    }

    fn estimate_cpu_usage_fallback(&self) -> f32 {
        let load = self.disk_write_mbps as f32 / 100.0;
        load.clamp(0.0, 1.0)
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
        self.available_memory_mb = 2048;
    }

    fn sample_disk_io(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_disk_sample_time);
        if elapsed < Duration::from_millis(500) {
            return;
        }
        self.last_disk_sample_time = now;

        let total_written = self.disk_write_bytes;
        let delta = total_written.saturating_sub(self.last_disk_write_bytes);
        self.last_disk_write_bytes = total_written;

        if elapsed.as_secs_f64() > 0.0 {
            self.disk_write_mbps =
                (delta as f64 / elapsed.as_secs_f64() / (1024.0 * 1024.0)) as u64;
        }
    }

    pub fn record_disk_write(&mut self, bytes: u64) {
        self.disk_write_bytes += bytes;
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
        assert!(max >= 4 && max <= 32);

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
        m.available_memory_mb = 8192;
        assert!(m.max_safe_connections() <= 32);
    }

    #[test]
    fn disk_bottleneck_below_threshold() {
        let mut m = ResourceMonitor::new();
        m.disk_write_mbps = 5;
        assert!(m.disk_bottleneck());
        m.disk_write_mbps = 100;
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
        m.disk_write_mbps = 100;
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
    fn record_disk_write_accumulates() {
        let mut m = ResourceMonitor::new();
        m.record_disk_write(1024);
        m.record_disk_write(2048);
        assert_eq!(m.disk_write_bytes, 3072);
    }

    #[test]
    fn snapshot_clone_returns_copy() {
        let mut m = ResourceMonitor::new();
        m.record_disk_write(1024 * 1024);
        m.sample();
        let mut snap = m.snapshot_clone();
        let original = snap.disk_write_mbps;
        snap.disk_write_mbps = 999;
        let snap2 = m.snapshot_clone();
        assert_eq!(snap2.disk_write_mbps, original);
        assert_ne!(snap2.disk_write_mbps, 999);
    }
}
