use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct TorrentBandwidthLimiter {
    rate_bytes_per_second: u64,
    state: Arc<Mutex<LimiterState>>,
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
            rate_bytes_per_second,
            state: Arc::new(Mutex::new(LimiterState {
                next_slot: Instant::now(),
            })),
        })
    }

    pub const fn rate_bytes_per_second(&self) -> u64 {
        self.rate_bytes_per_second
    }

    pub async fn acquire(
        &self,
        bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if bytes == 0 {
            return Ok(());
        }

        let duration = transfer_duration(bytes, self.rate_bytes_per_second);
        let now = Instant::now();
        let slot = {
            let mut state = self.state.lock().await;
            let slot = state.next_slot.max(now);
            state.next_slot = slot
                .checked_add(duration)
                .unwrap_or_else(|| slot + Duration::from_secs(24 * 60 * 60));
            slot
        };

        if slot <= now {
            return Ok(());
        }

        tokio::select! {
            _ = cancel.cancelled() => Err("Torrent bandwidth wait cancelled".to_owned()),
            _ = sleep_until(slot) => Ok(()),
        }
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
            Duration::from_millis(16)
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
    fn zero_rate_is_rejected() {
        assert!(TorrentBandwidthLimiter::new(0).is_err());
    }
}
