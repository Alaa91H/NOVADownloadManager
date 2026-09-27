use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::daemon::engine::adaptive_connections::AdaptiveConfig;
use crate::daemon::engine::retry::RetryPolicy;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_connections: u32,
    pub max_connections: u32,
    pub adaptive: bool,
    pub adaptive_config: AdaptiveProfileConfig,
    pub retry_policy: RetryProfileConfig,
    pub dynamic_segmentation: bool,
    pub checksum_algorithm: Option<String>,
    pub rate_limit_kbps: Option<u64>,
    pub segment_size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AdaptiveProfileConfig {
    pub enabled: bool,
    pub speed_high_threshold_mbps: f64,
    pub speed_low_threshold_kbps: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RetryProfileConfig {
    pub max_retries: u32,
    pub base_delay_secs: u64,
    pub max_delay_secs: u64,
    pub backoff_multiplier: f64,
    pub jitter: bool,
}

impl DownloadProfile {
    pub const BUILTIN_IDS: [&'static str; 4] =
        ["maximum-speed", "balanced", "economical", "background"];

    pub fn is_builtin_id(id: &str) -> bool {
        Self::BUILTIN_IDS.contains(&id)
    }

    pub fn maximum_speed() -> Self {
        Self {
            id: "maximum-speed".to_owned(),
            name: "Maximum Speed".to_owned(),
            description: "Aggressive settings for fastest downloads".to_owned(),
            default_connections: 16,
            max_connections: 48,
            adaptive: true,
            adaptive_config: AdaptiveProfileConfig {
                enabled: true,
                speed_high_threshold_mbps: 10.0,
                speed_low_threshold_kbps: 50.0,
            },
            retry_policy: RetryProfileConfig {
                max_retries: 10,
                base_delay_secs: 1,
                max_delay_secs: 300,
                backoff_multiplier: 1.5,
                jitter: true,
            },
            dynamic_segmentation: true,
            checksum_algorithm: Some("sha256".to_owned()),
            rate_limit_kbps: None,
            segment_size_bytes: Some(2 * 1024 * 1024),
        }
    }

    pub fn balanced() -> Self {
        Self {
            id: "balanced".to_owned(),
            name: "Balanced".to_owned(),
            description: "Balanced speed and resource usage".to_owned(),
            default_connections: 8,
            max_connections: 32,
            adaptive: true,
            adaptive_config: AdaptiveProfileConfig {
                enabled: true,
                speed_high_threshold_mbps: 5.0,
                speed_low_threshold_kbps: 100.0,
            },
            retry_policy: RetryProfileConfig {
                max_retries: 5,
                base_delay_secs: 1,
                max_delay_secs: 120,
                backoff_multiplier: 2.0,
                jitter: true,
            },
            dynamic_segmentation: true,
            checksum_algorithm: Some("sha256".to_owned()),
            rate_limit_kbps: None,
            segment_size_bytes: None,
        }
    }

    pub fn economical() -> Self {
        Self {
            id: "economical".to_owned(),
            name: "Economical".to_owned(),
            description: "Conservative settings to save bandwidth".to_owned(),
            default_connections: 2,
            max_connections: 8,
            adaptive: false,
            adaptive_config: AdaptiveProfileConfig {
                enabled: false,
                speed_high_threshold_mbps: 2.0,
                speed_low_threshold_kbps: 200.0,
            },
            retry_policy: RetryProfileConfig {
                max_retries: 3,
                base_delay_secs: 5,
                max_delay_secs: 60,
                backoff_multiplier: 3.0,
                jitter: false,
            },
            dynamic_segmentation: false,
            checksum_algorithm: Some("md5".to_owned()),
            rate_limit_kbps: Some(1024),
            segment_size_bytes: Some(4 * 1024 * 1024),
        }
    }

    pub fn background() -> Self {
        Self {
            id: "background".to_owned(),
            name: "Background".to_owned(),
            description: "Minimal resource usage for background downloads".to_owned(),
            default_connections: 1,
            max_connections: 4,
            adaptive: false,
            adaptive_config: AdaptiveProfileConfig {
                enabled: false,
                speed_high_threshold_mbps: 1.0,
                speed_low_threshold_kbps: 10.0,
            },
            retry_policy: RetryProfileConfig {
                max_retries: 15,
                base_delay_secs: 10,
                max_delay_secs: 600,
                backoff_multiplier: 2.0,
                jitter: true,
            },
            dynamic_segmentation: false,
            checksum_algorithm: None,
            rate_limit_kbps: Some(256),
            segment_size_bytes: Some(8 * 1024 * 1024),
        }
    }

    pub fn to_adaptive_config(&self) -> AdaptiveConfig {
        // Only the evaluation cadence and stall tolerance survive the overlay
        // below; every other base value (connection bounds and speed
        // thresholds) is replaced by the profile's own values. Compute just
        // those two fields directly instead of building a whole
        // aggressive()/conservative()/default() config that is mostly thrown
        // away.
        let (stall_threshold, eval_interval) = if !self.adaptive {
            (
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(5),
            )
        } else if self.max_connections >= 40 {
            (
                std::time::Duration::from_secs(3),
                std::time::Duration::from_millis(1500),
            )
        } else {
            (
                std::time::Duration::from_secs(5),
                std::time::Duration::from_secs(2),
            )
        };
        // Profiles can arrive through the public HTTP API, so normalize every
        // caller-provided bound and floating-point threshold before exposing it
        // to the live connection manager. This keeps the profile endpoint and
        // runtime behavior aligned even for zero, negative, NaN, or infinite
        // values supplied by an external client.
        let max_connections = self.max_connections.max(1);
        let min_connections = self.default_connections.clamp(1, max_connections);
        let threshold_to_bps = |value: f64, multiplier: f64| {
            if value.is_finite() && value > 0.0 {
                (value * multiplier).clamp(0.0, u64::MAX as f64) as u64
            } else {
                0
            }
        };
        AdaptiveConfig {
            min_connections,
            max_connections,
            speed_high_threshold: threshold_to_bps(
                self.adaptive_config.speed_high_threshold_mbps,
                125_000.0,
            ),
            speed_low_threshold: threshold_to_bps(
                self.adaptive_config.speed_low_threshold_kbps,
                125.0,
            ),
            stall_threshold,
            eval_interval,
        }
    }

    pub const fn to_retry_policy(&self) -> RetryPolicy {
        RetryPolicy {
            max_retries: self.retry_policy.max_retries,
            base_delay: std::time::Duration::from_secs(self.retry_policy.base_delay_secs),
            max_delay: std::time::Duration::from_secs(self.retry_policy.max_delay_secs),
            backoff_multiplier: self.retry_policy.backoff_multiplier,
            jitter: self.retry_policy.jitter,
        }
    }
}

#[derive(Clone)]
pub struct ProfileManager {
    profiles: Arc<Mutex<HashMap<String, DownloadProfile>>>,
    active_profile: Arc<Mutex<String>>,
}

impl ProfileManager {
    pub fn new() -> Self {
        let mut profiles = HashMap::new();
        let ms = DownloadProfile::maximum_speed();
        let ba = DownloadProfile::balanced();
        let ec = DownloadProfile::economical();
        let bg = DownloadProfile::background();
        profiles.insert(ms.id.clone(), ms);
        profiles.insert(ba.id.clone(), ba);
        profiles.insert(ec.id.clone(), ec);
        profiles.insert(bg.id.clone(), bg);
        Self {
            profiles: Arc::new(Mutex::new(profiles)),
            active_profile: Arc::new(Mutex::new("balanced".to_owned())),
        }
    }

    pub fn active_profile(&self) -> DownloadProfile {
        let active_guard = match self.active_profile.lock() {
            Ok(g) => g,
            Err(_) => return DownloadProfile::balanced(),
        };
        let profiles_guard = match self.profiles.lock() {
            Ok(g) => g,
            Err(_) => return DownloadProfile::balanced(),
        };
        // Both locks held — set_active() cannot change the ID under us
        profiles_guard
            .get(&*active_guard)
            .cloned()
            .unwrap_or_else(DownloadProfile::balanced)
    }

    pub fn set_active(&self, profile_id: &str) -> bool {
        // Always lock `active_profile` before `profiles` to match
        // `active_profile()` and prevent ABBA deadlocks. Reject an unknown id
        // rather than reporting success while silently falling back to balanced.
        let Ok(mut active) = self.active_profile.lock() else {
            return false;
        };
        let Ok(profiles) = self.profiles.lock() else {
            return false;
        };
        if !profiles.contains_key(profile_id) {
            return false;
        }
        *active = profile_id.to_owned();
        true
    }

    pub fn get_profile(&self, id: &str) -> Option<DownloadProfile> {
        self.profiles.lock().ok().and_then(|p| p.get(id).cloned())
    }

    pub fn list_profiles(&self) -> Vec<DownloadProfile> {
        self.profiles
            .lock()
            .map(|p| {
                let mut profiles: Vec<_> = p.values().cloned().collect();
                profiles.sort_by(|left, right| left.id.cmp(&right.id));
                profiles
            })
            .unwrap_or_default()
    }

    /// Add or replace a custom profile. Built-in profile ids are immutable so
    /// an HTTP client cannot overwrite the safe defaults used as fallbacks.
    pub fn add_profile(&self, profile: DownloadProfile) -> bool {
        if profile.id.trim().is_empty() || DownloadProfile::is_builtin_id(&profile.id) {
            return false;
        }
        if let Ok(mut profiles) = self.profiles.lock() {
            profiles.insert(profile.id.clone(), profile);
            true
        } else {
            false
        }
    }

    pub fn remove_profile(&self, id: &str) -> bool {
        if DownloadProfile::is_builtin_id(id) {
            return false;
        }
        // Keep lock ordering consistent with active_profile()/set_active().
        let Ok(mut active) = self.active_profile.lock() else {
            return false;
        };
        let Ok(mut profiles) = self.profiles.lock() else {
            return false;
        };
        let removed = profiles.remove(id).is_some();
        if removed && active.as_str() == id {
            *active = "balanced".to_owned();
        }
        removed
    }
}

impl Default for ProfileManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_four_builtin_profiles() {
        let pm = ProfileManager::new();
        let profiles = pm.list_profiles();
        assert_eq!(profiles.len(), 4);
    }

    #[test]
    fn get_profile_returns_builtin() {
        let pm = ProfileManager::new();
        assert!(pm.get_profile("maximum-speed").is_some());
        assert!(pm.get_profile("balanced").is_some());
        assert!(pm.get_profile("economical").is_some());
        assert!(pm.get_profile("background").is_some());
    }

    #[test]
    fn get_profile_returns_none_for_unknown() {
        let pm = ProfileManager::new();
        assert!(pm.get_profile("nonexistent").is_none());
    }

    #[test]
    fn set_active_profile() {
        let pm = ProfileManager::new();
        assert!(pm.set_active("balanced"));
        assert_eq!(pm.active_profile().id, "balanced");
    }

    #[test]
    fn set_active_nonexistent_is_rejected_without_changing_profile() {
        let pm = ProfileManager::new();
        assert!(!pm.set_active("nonexistent"));
        assert_eq!(pm.active_profile().id, "balanced");
    }

    #[test]
    fn add_and_remove_custom_profile() {
        let pm = ProfileManager::new();
        let custom = DownloadProfile {
            id: "custom".to_string(),
            name: "Custom".to_string(),
            description: "Custom profile".to_string(),
            default_connections: 4,
            max_connections: 8,
            rate_limit_kbps: None,
            adaptive: false,
            adaptive_config: AdaptiveProfileConfig {
                enabled: false,
                speed_high_threshold_mbps: 1.0,
                speed_low_threshold_kbps: 10.0,
            },
            retry_policy: RetryProfileConfig {
                max_retries: 3,
                base_delay_secs: 5,
                max_delay_secs: 60,
                backoff_multiplier: 2.0,
                jitter: true,
            },
            dynamic_segmentation: false,
            checksum_algorithm: None,
            segment_size_bytes: None,
        };
        assert!(pm.add_profile(custom));
        assert!(pm.get_profile("custom").is_some());
        assert_eq!(pm.list_profiles().len(), 5);
        assert!(pm.remove_profile("custom"));
        assert!(pm.get_profile("custom").is_none());
        assert_eq!(pm.list_profiles().len(), 4);
    }

    #[test]
    fn remove_nonexistent_profile_returns_false() {
        let pm = ProfileManager::new();
        assert!(!pm.remove_profile("nonexistent"));
    }

    #[test]
    fn builtins_cannot_be_overwritten_or_removed() {
        let pm = ProfileManager::new();
        let mut replacement = DownloadProfile::balanced();
        replacement.name = "Replacement".to_owned();
        assert!(!pm.add_profile(replacement));
        assert_eq!(pm.get_profile("balanced").unwrap().name, "Balanced");
        assert!(!pm.remove_profile("balanced"));
    }

    #[test]
    fn removing_active_custom_profile_restores_balanced() {
        let pm = ProfileManager::new();
        let mut custom = DownloadProfile::background();
        custom.id = "custom-active".to_owned();
        assert!(pm.add_profile(custom));
        assert!(pm.set_active("custom-active"));
        assert!(pm.remove_profile("custom-active"));
        assert_eq!(pm.active_profile().id, "balanced");
    }

    #[test]
    fn adaptive_config_normalizes_untrusted_bounds_and_thresholds() {
        let mut profile = DownloadProfile::balanced();
        profile.default_connections = 0;
        profile.max_connections = 0;
        profile.adaptive_config.speed_high_threshold_mbps = f64::NAN;
        profile.adaptive_config.speed_low_threshold_kbps = -1.0;
        let config = profile.to_adaptive_config();
        assert_eq!(config.min_connections, 1);
        assert_eq!(config.max_connections, 1);
        assert_eq!(config.speed_high_threshold, 0);
        assert_eq!(config.speed_low_threshold, 0);
    }

    #[test]
    fn maximum_speed_profile_config() {
        let pm = ProfileManager::new();
        let p = pm.get_profile("maximum-speed").unwrap();
        assert_eq!(p.default_connections, 16);
        assert!(p.adaptive);
    }

    #[test]
    fn background_profile_config() {
        let pm = ProfileManager::new();
        let p = pm.get_profile("background").unwrap();
        assert_eq!(p.default_connections, 1);
        assert!(p.rate_limit_kbps.is_some());
    }
}
