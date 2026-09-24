use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;

use crate::daemon::engine::bandwidth::BandwidthManager;
use crate::daemon::engine::priority_queue::{
    DownloadPriority, PriorityBandwidthQueue, QueueEntry,
};
use crate::daemon::torrent_bandwidth::TorrentBandwidthLimiter;

pub struct TorrentNovaPolicyLease {
    task_id: String,
    queue: PriorityBandwidthQueue,
    allocated_kbps: Arc<AtomicU64>,
    limiter: Arc<TorrentBandwidthLimiter>,
    active: bool,
}

impl TorrentNovaPolicyLease {
    pub fn start(
        task_id: String,
        priority: DownloadPriority,
        size_bytes: u64,
        queue: PriorityBandwidthQueue,
        bandwidth: BandwidthManager,
    ) -> Result<Self, String> {
        if task_id.trim().is_empty() {
            return Err("Torrent task id cannot be empty".to_owned());
        }
        if queue
            .entries()
            .iter()
            .any(|entry| entry.task_id == task_id)
        {
            return Err(format!(
                "Torrent task {task_id} is already registered in the priority queue"
            ));
        }

        let allocated_kbps = Arc::new(AtomicU64::new(0));
        queue.enqueue(QueueEntry {
            task_id: task_id.clone(),
            priority,
            added_at: Instant::now(),
            size_bytes,
            bandwidth_kbps: allocated_kbps.clone(),
        });
        queue.start_download();

        let limiter = Arc::new(TorrentBandwidthLimiter::for_nova_task(
            task_id.clone(),
            allocated_kbps.clone(),
            bandwidth,
        ));

        Ok(Self {
            task_id,
            queue,
            allocated_kbps,
            limiter,
            active: true,
        })
    }

    pub fn limiter(&self) -> Arc<TorrentBandwidthLimiter> {
        self.limiter.clone()
    }

    pub fn allocated_kbps(&self) -> u64 {
        self.allocated_kbps
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn stop(mut self) {
        self.release();
    }

    fn release(&mut self) {
        if self.active {
            self.queue.stop_download(&self.task_id);
            self.active = false;
        }
    }
}

impl Drop for TorrentNovaPolicyLease {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::engine::bandwidth::{BandwidthConfig, RateLimit};
    use crate::daemon::torrent_bandwidth::TorrentRateLimit;

    #[test]
    fn policy_lease_registers_allocation_and_releases_queue_slot() {
        let queue = PriorityBandwidthQueue::new(1_000);
        let bandwidth = BandwidthManager::new(BandwidthConfig {
            global_limit_kbps: 500,
            ..Default::default()
        });

        {
            let lease = TorrentNovaPolicyLease::start(
                "torrent-policy-test".to_owned(),
                DownloadPriority::Normal,
                8 * 1024 * 1024,
                queue.clone(),
                bandwidth.clone(),
            )
            .unwrap();

            assert_eq!(queue.active_count(), 1);
            assert_eq!(queue.entries().len(), 1);
            assert_eq!(lease.allocated_kbps(), 200);
            assert_eq!(
                lease.limiter().effective_rate(),
                TorrentRateLimit::Limit(200 * 1024)
            );
            assert_eq!(
                bandwidth.rate_limit_for("torrent-policy-test"),
                RateLimit::Limit(500)
            );
        }

        assert_eq!(queue.active_count(), 0);
        assert!(queue.entries().is_empty());
    }

    #[test]
    fn duplicate_task_registration_is_rejected_without_incrementing_active_count() {
        let queue = PriorityBandwidthQueue::new(1_000);
        let bandwidth = BandwidthManager::default();
        let first = TorrentNovaPolicyLease::start(
            "same-task".to_owned(),
            DownloadPriority::High,
            10,
            queue.clone(),
            bandwidth.clone(),
        )
        .unwrap();

        assert!(TorrentNovaPolicyLease::start(
            "same-task".to_owned(),
            DownloadPriority::Normal,
            10,
            queue.clone(),
            bandwidth,
        )
        .is_err());
        assert_eq!(queue.active_count(), 1);
        drop(first);
        assert_eq!(queue.active_count(), 0);
    }
}
