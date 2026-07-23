use std::time::{Duration, Instant};

use crate::daemon::engine::config::global_config;

const MIN_WRITE_BUFFER: usize = 32 * 1024;
const MAX_WRITE_BUFFER: usize = 4 * 1024 * 1024;
const MIN_READ_BUFFER: usize = 16 * 1024;
const MAX_READ_BUFFER: usize = 2 * 1024 * 1024;
const MIN_FLUSH_INTERVAL_MS: u64 = 10;
const MAX_FLUSH_INTERVAL_MS: u64 = 500;

#[derive(Clone, Debug)]
pub struct BufferRecommendation {
    pub write_buffer: usize,
    pub read_buffer: usize,
    pub flush_interval_ms: u64,
}

pub struct BufferManager {
    write_buffer: usize,
    read_buffer: usize,
    flush_interval_ms: u64,
    peak_speed: u64,
    memory_pressure: f64,
    active_connections: u32,
    last_adjustment: Instant,
    adjustment_interval: Duration,
}

impl BufferManager {
    pub fn new() -> Self {
        let cfg = global_config();
        Self {
            write_buffer: cfg.write_buffer_bytes,
            read_buffer: cfg.read_buffer_bytes,
            flush_interval_ms: cfg.flush_interval_ms,
            peak_speed: 0,
            memory_pressure: 0.0,
            active_connections: 1,
            last_adjustment: Instant::now() - Duration::from_secs(10),
            adjustment_interval: Duration::from_secs(3),
        }
    }

    pub fn recommend(&mut self, speed: u64, connections: u32, memory_pressure: f64) -> BufferRecommendation {
        self.peak_speed = self.peak_speed.max(speed);
        self.active_connections = connections;
        self.memory_pressure = memory_pressure;

        if self.last_adjustment.elapsed() < self.adjustment_interval {
            return BufferRecommendation {
                write_buffer: self.write_buffer,
                read_buffer: self.read_buffer,
                flush_interval_ms: self.flush_interval_ms,
            };
        }
        self.last_adjustment = Instant::now();

        self.write_buffer = self.compute_write_buffer();
        self.read_buffer = self.compute_read_buffer();
        self.flush_interval_ms = self.compute_flush_interval();

        BufferRecommendation {
            write_buffer: self.write_buffer,
            read_buffer: self.read_buffer,
            flush_interval_ms: self.flush_interval_ms,
        }
    }

    fn compute_write_buffer(&self) -> usize {
        let cfg = global_config();
        let base = cfg.write_buffer_bytes as f64;

        let speed_factor = if self.peak_speed > 10 * 1024 * 1024 {
            2.0
        } else if self.peak_speed > 1 * 1024 * 1024 {
            1.5
        } else if self.peak_speed > 100 * 1024 {
            1.0
        } else {
            0.5
        };

        let conn_factor = 1.0 / (self.active_connections as f64).sqrt().max(1.0);
        let memory_factor = 1.0 - (self.memory_pressure * 0.7);

        let adjusted = base * speed_factor * conn_factor * memory_factor;
        (adjusted as usize).clamp(MIN_WRITE_BUFFER, MAX_WRITE_BUFFER)
    }

    fn compute_read_buffer(&self) -> usize {
        let cfg = global_config();
        let base = cfg.read_buffer_bytes as f64;

        let speed_factor = if self.peak_speed > 5 * 1024 * 1024 {
            2.0
        } else if self.peak_speed > 500 * 1024 {
            1.0
        } else {
            0.5
        };

        let memory_factor = 1.0 - (self.memory_pressure * 0.5);
        let adjusted = base * speed_factor * memory_factor;
        (adjusted as usize).clamp(MIN_READ_BUFFER, MAX_READ_BUFFER)
    }

    fn compute_flush_interval(&self) -> u64 {
        if self.memory_pressure > 0.8 {
            MAX_FLUSH_INTERVAL_MS
        } else if self.memory_pressure > 0.5 {
            200
        } else if self.peak_speed > 5 * 1024 * 1024 {
            MIN_FLUSH_INTERVAL_MS
        } else if self.peak_speed > 1 * 1024 * 1024 {
            50
        } else {
            100
        }
    }

    pub fn current(&self) -> BufferRecommendation {
        BufferRecommendation {
            write_buffer: self.write_buffer,
            read_buffer: self.read_buffer,
            flush_interval_ms: self.flush_interval_ms,
        }
    }

    pub fn write_buffer(&self) -> usize {
        self.write_buffer
    }

    pub fn read_buffer(&self) -> usize {
        self.read_buffer
    }

    pub fn flush_interval(&self) -> Duration {
        Duration::from_millis(self.flush_interval_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_uses_engine_config_defaults() {
        let bm = BufferManager::new();
        let cfg = global_config();
        assert_eq!(bm.write_buffer, cfg.write_buffer_bytes);
        assert_eq!(bm.read_buffer, cfg.read_buffer_bytes);
    }

    #[test]
    fn recommend_increases_buffer_on_fast_network() {
        let mut bm = BufferManager::new();
        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let low = bm.recommend(100 * 1024, 1, 0.0).write_buffer;

        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let high = bm.recommend(50 * 1024 * 1024, 1, 0.0).write_buffer;
        assert!(high >= low, "fast network should increase buffer: {} >= {}", high, low);
    }

    #[test]
    fn recommend_reduces_buffer_under_memory_pressure() {
        let mut bm = BufferManager::new();
        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let normal = bm.recommend(1 * 1024 * 1024, 1, 0.0).write_buffer;

        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let pressured = bm.recommend(1 * 1024 * 1024, 1, 0.9).write_buffer;
        assert!(pressured < normal, "memory pressure should reduce buffer: {} < {}", pressured, normal);
    }

    #[test]
    fn recommend_reduces_buffer_with_more_connections() {
        let mut bm = BufferManager::new();
        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let single = bm.recommend(1 * 1024 * 1024, 1, 0.0).write_buffer;

        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let many = bm.recommend(1 * 1024 * 1024, 16, 0.0).write_buffer;
        assert!(many <= single, "more connections should reduce buffer: {} <= {}", many, single);
    }

    #[test]
    fn write_buffer_never_exceeds_bounds() {
        let mut bm = BufferManager::new();
        for speed in [0, 1000, 1_000_000, 100_000_000] {
            bm.last_adjustment = Instant::now() - Duration::from_secs(10);
            let rec = bm.recommend(speed, 1, 0.0);
            assert!(rec.write_buffer >= MIN_WRITE_BUFFER);
            assert!(rec.write_buffer <= MAX_WRITE_BUFFER);
        }
    }

    #[test]
    fn read_buffer_never_exceeds_bounds() {
        let mut bm = BufferManager::new();
        for speed in [0, 1000, 1_000_000, 100_000_000] {
            bm.last_adjustment = Instant::now() - Duration::from_secs(10);
            let rec = bm.recommend(speed, 1, 0.0);
            assert!(rec.read_buffer >= MIN_READ_BUFFER);
            assert!(rec.read_buffer <= MAX_READ_BUFFER);
        }
    }

    #[test]
    fn flush_interval_shorter_on_fast_network() {
        let mut bm = BufferManager::new();
        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let slow = bm.recommend(100 * 1024, 1, 0.0).flush_interval_ms;

        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let fast = bm.recommend(10 * 1024 * 1024, 1, 0.0).flush_interval_ms;
        assert!(fast <= slow, "fast network should flush faster: {} <= {}", fast, slow);
    }

    #[test]
    fn flush_interval_slower_under_pressure() {
        let mut bm = BufferManager::new();
        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let normal = bm.recommend(1 * 1024 * 1024, 1, 0.0).flush_interval_ms;

        bm.last_adjustment = Instant::now() - Duration::from_secs(10);
        let pressured = bm.recommend(1 * 1024 * 1024, 1, 0.9).flush_interval_ms;
        assert!(pressured >= normal, "pressure should slow flush: {} >= {}", pressured, normal);
    }

    #[test]
    fn adjustment_throttled() {
        let mut bm = BufferManager::new();
        bm.last_adjustment = Instant::now();
        let rec1 = bm.recommend(50 * 1024 * 1024, 1, 0.0);
        let rec2 = bm.recommend(50 * 1024 * 1024, 1, 0.0);
        assert_eq!(rec1.write_buffer, rec2.write_buffer);
    }
}
