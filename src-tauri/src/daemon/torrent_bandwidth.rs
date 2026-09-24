use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;

use crate::daemon::engine::bandwidth::{BandwidthManager, RateLimit};

#[derive(Clone)]
pub struct TorrentBandwidthLimiter {
    source: TorrentRateSource,
    state: Arc<Mutex<LimiterState>>,
}

#[derive(Clone)]
enum TorrentRateSource {
    Fixed(u64),
    NovaTask {
        task_id: Arc<str>,
        allocated_kbps: Arc<AtomicU64>,
        bandwidth: BandwidthManager,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TorrentRateLimit {
    Unlimited,
    Paused,
    Limit(u64),
}

impl std::fmt::Debug for TorrentBandwidthLimiter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TorrentBandwidthLimiter")
            .field("effective_rate", &self.effective_rate())
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct LimiterState {
    next_slot: Instant,
}

impl TorrentBandwidthLimiter {
    pub fn new(rate_bytes_per_second: u64) -> Result<Self, String> {
        if rate_bytes_per_second == 0 {
            return Err("Torrent bandwidth limit must be greater than zero".to_owned());
        }
        Ok(Self {
            source: TorrentRateSource::Fixed(rate_bytes_per_second),
            state: Arc::new(Mutex::new(LimiterState {
                next_slot: Instant::now(),
            })),
        })
    }

    pub fn for_nova_task(
        task_id: String,
        allocated_kbps: Arc<AtomicU64>,
        bandwidth: BandwidthManager,
    ) -> Self {
        Self {
            source: TorrentRateSource::NovaTask {
                task_id: Arc::<str>::from(task_id),
                allocated_kbps,
                bandwidth,
            },
            state: Arc::new(Mutex::new(LimiterState {
                next_slot: Instant::now(),
            })),
        }
    }

    pub fn effective_rate(&self) -> TorrentRateLimit {
        match &self.source {
            TorrentRateSource::Fixed(rate) => TorrentRateLimit::Limit(*rate),
            TorrentRateSource::NovaTask {
                task_id,
                allocated_kbps,
                bandwidth,
            } => {
                let allocated = allocated_kbps.load(Ordering::Relaxed);
                match bandwidth.rate_limit_for(task_id) {
                    RateLimit::Paused => TorrentRateLimit::Paused,
                    RateLimit::Unlimited if allocated == 0 => TorrentRateLimit::Unlimited,
                    RateLimit::Unlimited => {
                        TorrentRateLimit::Limit(allocated.saturating_mul(1024))
                    }
                    RateLimit::Limit(task_kbps) => {
                        let effective_kbps = if allocated == 0 {
                            task_kbps
                        } else {
                            task_kbps.min(allocated)
                        };
                        if effective_kbps == 0 {
                            TorrentRateLimit::Unlimited
                        } else {
                            TorrentRateLimit::Limit(effective_kbps.saturating_mul(1024))
                        }
                    }
                }
            }
        }
    }

    pub async fn acquire(
        &self,
        bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if bytes == 0 {
            return Ok(());
        }

        let rate = loop {
            match self.effective_rate() {
                TorrentRateLimit::Unlimited => return Ok(()),
                TorrentRateLimit::Limit(rate) if rate > 0 => break rate,
                TorrentRateLimit::Limit(_) => return Ok(()),
                TorrentRateLimit::Paused => {
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            return Err("Torrent bandwidth wait cancelled".to_owned());
                        }
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                    }
                }
            }
        };

        let duration = transfer_duration(bytes, rate);
        let mut state = self.state.lock().await;
        let now = Instant::now();
        let slot = state.next_slot.max(now);

        if slot > now {
            tokio::select! {
                _ = cancel.cancelled() => {
                    return Err("Torrent bandwidth wait cancelled".to_owned());
                }
                _ = sleep_until(slot) => {}
            }
        }

        // Reserve the following slot only after this request has actually
        // reached its turn. A cancelled waiter therefore cannot leave phantom
        // bandwidth debt that delays a later resume.
        state.next_slot = slot + duration;
        Ok(())
    }
}

fn transfer_duration(bytes: u64, rate: u64) -> Duration {
    let nanos = (u128::from(bytes) * 1_000_000_000u128)
        .div_ceil(u128::from(rate))
        .min(u128::from(u64::MAX)) as u64;
    Duration::from_nanos(nanos.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_duration_is_exact_for_common_rates() {
        assert_eq!(
            transfer_duration(16 * 1024, 1024 * 1024),
            Duration::from_micros(15_625)
        );
        assert_eq!(transfer_duration(1, 1), Duration::from_secs(1));
    }

    #[tokio::test]
    async fn cancelled_wait_does_not_block_for_reserved_slot() {
        let limiter = TorrentBandwidthLimiter::new(1).unwrap();
        let token = CancellationToken::new();
        limiter.acquire(1, &token).await.unwrap();

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = limiter.acquire(1, &cancelled).await.unwrap_err();
        assert!(error.contains("cancelled"));
    }

    #[test]
    fn nova_task_rate_uses_stricter_queue_or_bandwidth_limit() {
        use crate::daemon::engine::bandwidth::{BandwidthConfig, BandwidthManager};

        let allocation = Arc::new(AtomicU64::new(200));
        let bandwidth = BandwidthManager::new(BandwidthConfig {
            global_limit_kbps: 500,
            ..Default::default()
        });
        let limiter = TorrentBandwidthLimiter::for_nova_task(
            "torrent-task".to_owned(),
            allocation.clone(),
            bandwidth.clone(),
        );
        assert_eq!(
            limiter.effective_rate(),
            TorrentRateLimit::Limit(200 * 1024)
        );

        allocation.store(800, Ordering::Relaxed);
        assert_eq!(
            limiter.effective_rate(),
            TorrentRateLimit::Limit(500 * 1024)
        );

        bandwidth.pause_all();
        assert_eq!(limiter.effective_rate(), TorrentRateLimit::Paused);
    }

    #[test]
    fn zero_rate_is_rejected() {
        assert!(TorrentBandwidthLimiter::new(0).is_err());
    }
}
