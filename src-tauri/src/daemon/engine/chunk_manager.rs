use std::time::{Duration, Instant};

/// Sliding window for tracking recent samples.
struct SlidingWindow {
    samples: Vec<f64>,
    capacity: usize,
}

impl SlidingWindow {
    fn new(capacity: usize) -> Self {
        Self {
            samples: Vec::with_capacity(capacity),
            capacity,
        }
    }

    fn push(&mut self, value: f64) {
        if self.samples.len() >= self.capacity {
            self.samples.remove(0);
        }
        self.samples.push(value);
    }

    fn mean(&self) -> f64 {
        if self.samples.is_empty() {
            0.0
        } else {
            self.samples.iter().sum::<f64>() / self.samples.len() as f64
        }
    }

    fn len(&self) -> usize {
        self.samples.len()
    }
}

/// Dynamic chunk manager that continuously adapts chunk/buffer sizes
/// based on network speed, disk speed, RTT, remaining size, and memory pressure.
pub struct ChunkManager {
    current_chunk_bytes: u64,
    min_chunk: u64,
    max_chunk: u64,
    total_size: u64,
    network_samples: SlidingWindow,
    disk_samples: SlidingWindow,
    write_latencies: SlidingWindow,
    memory_pressure: f64,
    last_adjustment: Instant,
}

impl ChunkManager {
    pub fn new(total_size: u64) -> Self {
        let min_chunk = 32 * 1024;
        let max_chunk = total_size / 2;
        Self {
            current_chunk_bytes: 256 * 1024,
            min_chunk,
            max_chunk: max_chunk.max(min_chunk),
            total_size,
            network_samples: SlidingWindow::new(30),
            disk_samples: SlidingWindow::new(10),
            write_latencies: SlidingWindow::new(20),
            memory_pressure: 0.0,
            last_adjustment: Instant::now(),
        }
    }

    /// Recommend a chunk size based on current conditions.
    /// Called periodically by the engine to determine optimal write/read chunk sizes.
    pub fn recommend_chunk_size(&mut self, rtt_us: u64, network_speed: u64, disk_speed: u64) -> u64 {
        // Only recompute every 500ms to avoid oscillation
        if self.last_adjustment.elapsed() < Duration::from_millis(500) {
            return self.current_chunk_bytes;
        }
        self.last_adjustment = Instant::now();

        // Base chunk = 100ms worth of network data (ensures we have enough buffered)
        let rtt_fraction = if rtt_us > 0 {
            (network_speed as f64) * (rtt_us as f64 / 1_000_000.0)
        } else {
            network_speed as f64 * 0.1
        };

        // Ensure minimum of 16KB for efficiency
        let ideal_chunk = rtt_fraction.max(16.0 * 1024.0);

        // Adjust for disk speed: if disk is slower, use smaller chunks
        // to avoid backing up writes
        let disk_ratio = if disk_speed > 0 && network_speed > 0 {
            (disk_speed as f64 / network_speed as f64).min(1.0)
        } else {
            1.0
        };

        let adjusted = ideal_chunk * disk_ratio;

        // Reduce chunk size under memory pressure
        let memory_factor = 1.0 - self.memory_pressure * 0.5;
        let adjusted = adjusted * memory_factor;

        // Reduce chunk if remaining data is small
        let remaining = self.total_size.saturating_sub(
            self.network_samples.len() as u64 * self.current_chunk_bytes / 4,
        );
        let remaining_factor = if remaining > 0 {
            (remaining as f64 / self.min_chunk as f64).min(1.0).max(0.1)
        } else {
            0.1
        };
        let adjusted = adjusted * remaining_factor;

        // Smooth the transition (EMA with alpha=0.3)
        let new_chunk = (self.current_chunk_bytes as f64 * 0.7 + adjusted * 0.3) as u64;

        self.current_chunk_bytes = new_chunk.clamp(self.min_chunk, self.max_chunk);
        self.current_chunk_bytes
    }

    /// Record a network speed sample (bytes/sec).
    pub fn record_network_speed(&mut self, bytes_per_sec: u64) {
        self.network_samples.push(bytes_per_sec as f64);
    }

    /// Record a disk write: bytes written and time taken.
    pub fn record_write(&mut self, bytes: u64, duration: Duration) {
        let us = duration.as_micros() as f64;
        if us > 0.0 {
            let speed = bytes as f64 / (us / 1_000_000.0);
            self.disk_samples.push(speed);
        }
        self.write_latencies.push(us);
    }

    /// Update memory pressure (0.0 = no pressure, 1.0 = critical).
    pub fn update_memory_pressure(&mut self, used_ratio: f64) {
        self.memory_pressure = used_ratio.clamp(0.0, 1.0);
    }

    /// Update total remaining size (used during resume or segment changes).
    pub fn update_total_size(&mut self, total_size: u64) {
        self.total_size = total_size;
        self.max_chunk = (total_size / 2).max(self.min_chunk);
    }

    /// Current recommended chunk size.
    pub fn current_chunk(&self) -> u64 {
        self.current_chunk_bytes
    }

    /// Average disk write speed from recent samples (bytes/sec).
    pub fn avg_disk_speed(&self) -> u64 {
        self.disk_samples.mean() as u64
    }

    /// Average write latency from recent samples (microseconds).
    pub fn avg_write_latency_us(&self) -> u64 {
        self.write_latencies.mean() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_valid_manager() {
        let cm = ChunkManager::new(100 * 1024 * 1024);
        assert!(cm.current_chunk() >= cm.min_chunk);
        assert!(cm.current_chunk() <= cm.max_chunk);
        assert_eq!(cm.total_size, 100 * 1024 * 1024);
    }

    #[test]
    fn chunk_grows_on_fast_network() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        let initial = cm.current_chunk();
        // Simulate fast network, fast disk — bypass 500ms throttle by resetting last_adjustment
        for _ in 0..10 {
            cm.record_network_speed(50 * 1024 * 1024);
            cm.record_write(256 * 1024, Duration::from_millis(1));
            cm.last_adjustment = Instant::now() - Duration::from_secs(1);
            cm.recommend_chunk_size(20_000, 50 * 1024 * 1024, 100 * 1024 * 1024);
        }
        assert!(cm.current_chunk() > initial, "chunk should grow on fast network: {} > {}", cm.current_chunk(), initial);
    }

    #[test]
    fn chunk_shrinks_under_memory_pressure() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        // Let chunk converge first at fast speed
        for _ in 0..10 {
            cm.record_network_speed(50 * 1024 * 1024);
            cm.last_adjustment = Instant::now() - Duration::from_secs(1);
            cm.recommend_chunk_size(20_000, 50 * 1024 * 1024, 100 * 1024 * 1024);
        }
        let before_pressure = cm.current_chunk();

        // Now apply memory pressure — chunk target should drop
        cm.update_memory_pressure(0.9);
        cm.last_adjustment = Instant::now() - Duration::from_secs(1);
        cm.recommend_chunk_size(20_000, 50 * 1024 * 1024, 100 * 1024 * 1024);
        let after_pressure = cm.current_chunk();
        assert!(after_pressure < before_pressure, "chunk should shrink under memory pressure: {} < {}", after_pressure, before_pressure);
    }

    #[test]
    fn chunk_respects_min_bounds() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        cm.update_memory_pressure(1.0);
        for _ in 0..20 {
            cm.record_network_speed(0);
            cm.last_adjustment = Instant::now() - Duration::from_secs(1);
            cm.recommend_chunk_size(0, 0, 0);
        }
        assert!(cm.current_chunk() >= cm.min_chunk);
    }

    #[test]
    fn chunk_respects_max_bounds() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        for _ in 0..20 {
            cm.record_network_speed(1_000_000_000); // 1 GB/s
            cm.last_adjustment = Instant::now() - Duration::from_secs(1);
            cm.recommend_chunk_size(1_000, 1_000_000_000, 2_000_000_000);
        }
        assert!(cm.current_chunk() <= cm.max_chunk);
    }

    #[test]
    fn disk_slow_reduces_chunk() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        cm.record_network_speed(10 * 1024 * 1024);
        cm.last_adjustment = Instant::now() - Duration::from_secs(1);
        cm.recommend_chunk_size(10_000, 10 * 1024 * 1024, 10 * 1024 * 1024);
        let balanced = cm.current_chunk();

        cm.record_network_speed(10 * 1024 * 1024);
        cm.last_adjustment = Instant::now() - Duration::from_secs(1);
        cm.recommend_chunk_size(10_000, 10 * 1024 * 1024, 100 * 1024);
        let disk_limited = cm.current_chunk();
        assert!(disk_limited < balanced, "slow disk should reduce chunk: {} < {}", disk_limited, balanced);
    }

    #[test]
    fn avg_disk_speed_returns_zero_with_no_samples() {
        let cm = ChunkManager::new(100 * 1024 * 1024);
        assert_eq!(cm.avg_disk_speed(), 0);
    }

    #[test]
    fn update_total_size_adjusts_bounds() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        cm.update_total_size(1024);
        assert_eq!(cm.total_size, 1024);
        assert!(cm.max_chunk >= cm.min_chunk);
    }

    #[test]
    fn record_write_tracks_disk_speed() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        cm.record_write(1024 * 1024, Duration::from_millis(1));
        assert!(cm.avg_disk_speed() > 0);
    }

    #[test]
    fn adjustment_throttled_to_500ms() {
        let mut cm = ChunkManager::new(100 * 1024 * 1024);
        cm.record_network_speed(10 * 1024 * 1024);
        let c1 = cm.recommend_chunk_size(10_000, 10 * 1024 * 1024, 10 * 1024 * 1024);
        let c2 = cm.recommend_chunk_size(10_000, 10 * 1024 * 1024, 10 * 1024 * 1024);
        assert_eq!(c1, c2, "should not recompute within 500ms");
    }
}
