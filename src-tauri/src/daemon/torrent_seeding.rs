use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

pub const MAX_SEED_RATIO_MILLI: u32 = 1_000_000;
pub const MAX_SEED_TIME_SECONDS: u64 = 10 * 365 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TorrentSeedingPolicy {
    pub enabled: bool,
    /// Ratio multiplied by 1000. 1500 means 1.500.
    pub ratio_limit_milli: Option<u32>,
    pub time_limit_seconds: Option<u64>,
}

impl Default for TorrentSeedingPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            ratio_limit_milli: None,
            time_limit_seconds: None,
        }
    }
}

impl TorrentSeedingPolicy {
    pub fn validate(self) -> Result<Self, String> {
        if self
            .ratio_limit_milli
            .is_some_and(|value| value > MAX_SEED_RATIO_MILLI)
        {
            return Err(format!(
                "Torrent seed ratio limit exceeds maximum {:.3}",
                f64::from(MAX_SEED_RATIO_MILLI) / 1000.0
            ));
        }
        if self
            .time_limit_seconds
            .is_some_and(|value| value > MAX_SEED_TIME_SECONDS)
        {
            return Err(format!(
                "Torrent seed time limit exceeds maximum {} seconds",
                MAX_SEED_TIME_SECONDS
            ));
        }
        Ok(self)
    }

    pub fn ratio_limit(self) -> Option<f64> {
        self.ratio_limit_milli
            .map(|value| f64::from(value) / 1000.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TorrentSeedingSnapshot {
    pub policy: TorrentSeedingPolicy,
    pub uploaded_bytes: u64,
    pub seeded_seconds: u64,
}

impl Default for TorrentSeedingSnapshot {
    fn default() -> Self {
        Self {
            policy: TorrentSeedingPolicy::default(),
            uploaded_bytes: 0,
            seeded_seconds: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TorrentSeedingLimitState {
    pub ratio_reached: bool,
    pub time_reached: bool,
}

impl TorrentSeedingLimitState {
    pub const fn reached(self) -> bool {
        self.ratio_reached || self.time_reached
    }
}

#[derive(Clone)]
pub struct TorrentSeedingControl {
    policy: Arc<Mutex<TorrentSeedingPolicy>>,
    uploaded_bytes: Arc<AtomicU64>,
    seeded_seconds: Arc<AtomicU64>,
    active_since: Arc<Mutex<Option<Instant>>>,
}

impl std::fmt::Debug for TorrentSeedingControl {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TorrentSeedingControl")
            .field("policy", &self.policy())
            .field("uploaded_bytes", &self.uploaded_bytes())
            .field("seeded_seconds", &self.effective_seeded_seconds())
            .finish()
    }
}

impl Default for TorrentSeedingControl {
    fn default() -> Self {
        Self::from_snapshot(TorrentSeedingSnapshot::default())
    }
}

impl TorrentSeedingControl {
    pub fn from_snapshot(snapshot: TorrentSeedingSnapshot) -> Self {
        Self {
            policy: Arc::new(Mutex::new(snapshot.policy)),
            uploaded_bytes: Arc::new(AtomicU64::new(snapshot.uploaded_bytes)),
            seeded_seconds: Arc::new(AtomicU64::new(snapshot.seeded_seconds)),
            active_since: Arc::new(Mutex::new(None)),
        }
    }

    pub fn policy(&self) -> TorrentSeedingPolicy {
        *self
            .policy
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    pub fn replace_policy(&self, policy: TorrentSeedingPolicy) -> Result<(), String> {
        let policy = policy.validate()?;
        let mut current = self
            .policy
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *current = policy;
        Ok(())
    }

    pub fn uploaded_counter(&self) -> Arc<AtomicU64> {
        self.uploaded_bytes.clone()
    }

    pub fn uploaded_bytes(&self) -> u64 {
        self.uploaded_bytes.load(Ordering::Relaxed)
    }

    pub fn record_upload(&self, bytes: u64) {
        self.uploaded_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn start_timer(&self) {
        if !self.policy().enabled {
            return;
        }
        let mut active = self
            .active_since
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if active.is_none() {
            *active = Some(Instant::now());
        }
    }

    pub fn stop_timer(&self) {
        let started = {
            let mut active = self
                .active_since
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            active.take()
        };
        if let Some(started) = started {
            self.seeded_seconds
                .fetch_add(started.elapsed().as_secs(), Ordering::Relaxed);
        }
    }

    pub fn reset_statistics(&self) {
        self.stop_timer();
        self.uploaded_bytes.store(0, Ordering::Relaxed);
        self.seeded_seconds.store(0, Ordering::Relaxed);
    }

    pub fn effective_seeded_seconds(&self) -> u64 {
        let base = self.seeded_seconds.load(Ordering::Relaxed);
        let active = self
            .active_since
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        base.saturating_add(
            active
                .as_ref()
                .map(Instant::elapsed)
                .map(|duration| duration.as_secs())
                .unwrap_or(0),
        )
    }

    pub fn ratio(&self, downloaded_bytes: u64) -> f64 {
        if downloaded_bytes == 0 {
            return 0.0;
        }
        self.uploaded_bytes() as f64 / downloaded_bytes as f64
    }

    pub fn limit_state(&self, downloaded_bytes: u64) -> TorrentSeedingLimitState {
        let policy = self.policy();
        let uploaded = u128::from(self.uploaded_bytes());
        let ratio_reached = match (policy.ratio_limit_milli, downloaded_bytes) {
            (Some(limit), total) if total > 0 => {
                uploaded.saturating_mul(1000)
                    >= u128::from(total).saturating_mul(u128::from(limit))
            }
            _ => false,
        };
        let time_reached = policy
            .time_limit_seconds
            .is_some_and(|limit| self.effective_seeded_seconds() >= limit);
        TorrentSeedingLimitState {
            ratio_reached,
            time_reached,
        }
    }

    pub fn upload_allowed(&self, completed: bool, downloaded_bytes: u64) -> bool {
        let policy = self.policy();
        policy.enabled && (!completed || !self.limit_state(downloaded_bytes).reached())
    }

    pub fn remaining_seed_seconds(&self) -> Option<u64> {
        self.policy()
            .time_limit_seconds
            .map(|limit| limit.saturating_sub(self.effective_seeded_seconds()))
    }

    pub fn snapshot(&self) -> TorrentSeedingSnapshot {
        TorrentSeedingSnapshot {
            policy: self.policy(),
            uploaded_bytes: self.uploaded_bytes(),
            seeded_seconds: self.effective_seeded_seconds(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_limit_uses_exact_milli_units() {
        let control = TorrentSeedingControl::from_snapshot(TorrentSeedingSnapshot {
            policy: TorrentSeedingPolicy {
                enabled: true,
                ratio_limit_milli: Some(1500),
                time_limit_seconds: None,
            },
            uploaded_bytes: 1499,
            seeded_seconds: 0,
        });
        assert!(!control.limit_state(1000).ratio_reached);
        control.record_upload(1);
        assert!(control.limit_state(1000).ratio_reached);
    }

    #[test]
    fn disabled_policy_rejects_upload_even_before_completion() {
        let control = TorrentSeedingControl::from_snapshot(TorrentSeedingSnapshot {
            policy: TorrentSeedingPolicy {
                enabled: false,
                ..TorrentSeedingPolicy::default()
            },
            ..TorrentSeedingSnapshot::default()
        });
        assert!(!control.upload_allowed(false, 1000));
        assert!(!control.upload_allowed(true, 1000));
    }

    #[test]
    fn snapshot_preserves_counters() {
        let control = TorrentSeedingControl::default();
        control.record_upload(4096);
        let snapshot = control.snapshot();
        assert_eq!(snapshot.uploaded_bytes, 4096);
        assert!(snapshot.policy.enabled);
    }
}
