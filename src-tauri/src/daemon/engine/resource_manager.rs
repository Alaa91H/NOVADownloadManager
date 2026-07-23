#![allow(dead_code)]
use crate::daemon::engine::config::global_config;

use super::adaptive::buffer_manager::BufferManager;
use super::adaptive::resource_monitor::ResourceMonitor;
use super::thread_pool::ThreadPool;

pub struct ResourceManager {
    pub resource_monitor: ResourceMonitor,
    pub buffer_manager: BufferManager,
    pub thread_pool: ThreadPool,
    total_memory_mb: u64,
    disk_budget_per_connection: u64,
}

impl ResourceManager {
    pub fn new() -> Self {
        let cfg = global_config();
        Self {
            resource_monitor: ResourceMonitor::new(),
            buffer_manager: BufferManager::new(),
            thread_pool: ThreadPool::new(),
            total_memory_mb: Self::detect_total_memory_mb(),
            disk_budget_per_connection: Self::detect_disk_budget(cfg.max_connections_per_download),
        }
    }

    pub fn snapshot(&mut self) -> UnifiedSnapshot {
        let res = self.resource_monitor.sample().clone();
        let buf = self.buffer_manager.current();

        UnifiedSnapshot {
            cpu_count: res.cpu_count,
            cpu_usage_pct: res.cpu_usage_pct,
            available_memory_mb: res.available_memory_mb,
            total_memory_mb: self.total_memory_mb,
            memory_pressure: if self.total_memory_mb > 0 {
                1.0 - (res.available_memory_mb as f64 / self.total_memory_mb as f64)
            } else {
                0.0
            },
            disk_write_mbps: res.disk_write_mbps,
            disk_budget_per_connection: self.disk_budget_per_connection,
            write_buffer: buf.write_buffer,
            read_buffer: buf.read_buffer,
            flush_interval_ms: buf.flush_interval_ms,
            active_threads: self.thread_pool.active_count(),
            max_threads: self.thread_pool.max_size(),
        }
    }

    pub fn update_network(&mut self, speed: u64, connections: u32) {
        let pressure = self.current_memory_pressure();
        self.buffer_manager.recommend(speed, connections, pressure);
    }

    pub fn current_memory_pressure(&self) -> f64 {
        if self.total_memory_mb == 0 {
            return 0.0;
        }
        let res = self.resource_monitor.snapshot_clone();
        1.0 - (res.available_memory_mb as f64 / self.total_memory_mb as f64)
    }

    fn detect_total_memory_mb() -> u64 {
        #[cfg(target_os = "windows")]
        {
            use std::mem;
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
            unsafe {
                let mut status: MemoryStatusEx = mem::zeroed();
                status.dw_length = mem::size_of::<MemoryStatusEx>() as u32;
                if GlobalMemoryStatusEx(&mut status) != 0 {
                    status.ull_total_phys / (1024 * 1024)
                } else {
                    4096
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            4096
        }
    }

    fn detect_disk_budget(connections: u32) -> u64 {
        let total_mbps = 100 * 1024 * 1024;
        total_mbps / (connections as u64).max(1)
    }
}

#[derive(Clone, Debug)]
pub struct UnifiedSnapshot {
    pub cpu_count: u32,
    pub cpu_usage_pct: f32,
    pub available_memory_mb: u64,
    pub total_memory_mb: u64,
    pub memory_pressure: f64,
    pub disk_write_mbps: u64,
    pub disk_budget_per_connection: u64,
    pub write_buffer: usize,
    pub read_buffer: usize,
    pub flush_interval_ms: u64,
    pub active_threads: u32,
    pub max_threads: u32,
}

impl UnifiedSnapshot {
    pub fn is_memory_pressured(&self) -> bool {
        self.memory_pressure > 0.85
    }

    pub fn is_disk_bottlenecked(&self) -> bool {
        self.disk_write_mbps < 5 * 1024 * 1024 && self.disk_write_mbps > 0
    }
}

impl Default for ResourceManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_resource_manager() {
        let rm = ResourceManager::new();
        assert!(rm.total_memory_mb > 0);
    }

    #[test]
    fn snapshot_produces_valid_data() {
        let mut rm = ResourceManager::new();
        let snap = rm.snapshot();
        assert!(snap.cpu_count >= 1);
        assert!(snap.max_threads >= 1);
        assert!(snap.write_buffer >= 32 * 1024);
        assert!(snap.read_buffer >= 16 * 1024);
    }

    #[test]
    fn memory_pressure_computed() {
        let mut rm = ResourceManager::new();
        let snap = rm.snapshot();
        assert!(snap.memory_pressure >= 0.0);
        assert!(snap.memory_pressure <= 1.0);
    }

    #[test]
    fn update_network_doesnt_panic() {
        let mut rm = ResourceManager::new();
        rm.update_network(1_000_000, 4);
        rm.update_network(10_000_000, 8);
    }

    #[test]
    fn unified_snapshot_clone() {
        let mut rm = ResourceManager::new();
        let snap = rm.snapshot();
        let cloned = snap.clone();
        assert_eq!(cloned.cpu_count, snap.cpu_count);
    }

    #[test]
    fn is_memory_pressured_threshold() {
        let snap = UnifiedSnapshot {
            memory_pressure: 0.9,
            cpu_count: 1,
            cpu_usage_pct: 0.0,
            available_memory_mb: 100,
            total_memory_mb: 1000,
            disk_write_mbps: 0,
            disk_budget_per_connection: 0,
            write_buffer: 256 * 1024,
            read_buffer: 128 * 1024,
            flush_interval_ms: 100,
            active_threads: 0,
            max_threads: 4,
        };
        assert!(snap.is_memory_pressured());

        let ok = UnifiedSnapshot {
            memory_pressure: 0.3,
            cpu_count: 1,
            cpu_usage_pct: 0.0,
            available_memory_mb: 700,
            total_memory_mb: 1000,
            disk_write_mbps: 0,
            disk_budget_per_connection: 0,
            write_buffer: 256 * 1024,
            read_buffer: 128 * 1024,
            flush_interval_ms: 100,
            active_threads: 0,
            max_threads: 4,
        };
        assert!(!ok.is_memory_pressured());
    }
}
