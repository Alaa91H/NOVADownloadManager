use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MirrorSource {
    pub url: String,
    pub priority: u32,
    pub region: Option<String>,
    pub bandwidth_estimate: Option<u64>,
    pub last_checked: Option<String>,
    pub healthy: bool,
}

#[derive(Clone)]
struct InnerMirrorState {
    mirrors: Vec<MirrorSource>,
    active_mirror: Option<usize>,
}

#[derive(Clone)]
pub struct MirrorManager {
    mirrors: Arc<std::sync::Mutex<InnerMirrorState>>,
    failover_enabled: Arc<AtomicBool>,
}

impl MirrorManager {
    pub fn new(primary_url: &str) -> Self {
        let mirrors = vec![MirrorSource {
            url: primary_url.to_owned(),
            priority: 0,
            region: None,
            bandwidth_estimate: None,
            last_checked: None,
            healthy: true,
        }];
        Self {
            mirrors: Arc::new(std::sync::Mutex::new(InnerMirrorState {
                mirrors,
                active_mirror: Some(0),
            })),
            failover_enabled: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn add_mirror(&self, mirror: MirrorSource) {
        if let Ok(mut state) = self.mirrors.lock() {
            // Keep the active mirror by URL across the priority sort. Holding
            // a vector index here is not stable: adding a higher-priority
            // mirror can shift indices and silently redirect a live transfer
            // to a different, untested source.
            let active_url = state
                .active_mirror
                .and_then(|index| state.mirrors.get(index))
                .map(|source| source.url.clone());
            // M7: upsert by url — a duplicate URL must never be re-added
            // (the old code grew the list unboundedly on repeated failover).
            if let Some(existing) = state.mirrors.iter_mut().find(|m| m.url == mirror.url) {
                existing.priority = mirror.priority;
                existing.region = mirror.region.clone();
                existing.bandwidth_estimate = mirror.bandwidth_estimate;
                existing.healthy = existing.healthy || mirror.healthy;
            } else {
                state.mirrors.push(mirror);
            }
            state.mirrors.sort_by_key(|m| m.priority);
            state.active_mirror = active_url
                .as_deref()
                .and_then(|url| state.mirrors.iter().position(|source| source.url == url))
                .or_else(|| (!state.mirrors.is_empty()).then_some(0));
        }
    }

    pub fn set_mirrors(&self, mirrors: Vec<MirrorSource>) {
        if let Ok(mut state) = self.mirrors.lock() {
            let is_empty = mirrors.is_empty();
            state.mirrors = mirrors;
            state.mirrors.sort_by_key(|m| m.priority);
            state.active_mirror = if is_empty { None } else { Some(0) };
        }
    }

    pub fn active_url(&self) -> String {
        let state = match self.mirrors.lock() {
            Ok(g) => g,
            Err(_) => return String::new(),
        };
        let idx = state.active_mirror.unwrap_or(0);
        state
            .mirrors
            .get(idx)
            .map(|m| m.url.clone())
            .or_else(|| state.mirrors.first().map(|m| m.url.clone()))
            .unwrap_or_default()
    }

    pub fn report_failure(&self, url: &str, _error: &str) -> Option<String> {
        if !self.failover_enabled.load(Ordering::Relaxed) {
            return None;
        }
        // Single lock for both mirrors and active_mirror — no ABBA risk.
        let mut state = match self.mirrors.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        // Only a failure from the source currently serving the task may advance
        // the active pointer. A late completion from an old source can still be
        // marked unhealthy, but must never undo a newer failover decision.
        let failed_active_source = state
            .active_mirror
            .and_then(|index| state.mirrors.get(index))
            .is_some_and(|source| source.url == url);

        // Mark EVERY copy of the dead URL unhealthy so failover cannot select a
        // duplicate healthy copy from a legacy state.
        let mut any_marked = false;
        for m in state.mirrors.iter_mut() {
            if m.url == url {
                m.healthy = false;
                any_marked = true;
            }
        }
        if !any_marked || !failed_active_source {
            return None;
        }
        let dead_indices: Vec<usize> = state
            .mirrors
            .iter()
            .enumerate()
            .filter(|(_, m)| m.url == url)
            .map(|(i, _)| i)
            .collect();
        if let Some(new_idx) = state
            .mirrors
            .iter()
            .enumerate()
            .filter(|(i, m)| !dead_indices.contains(i) && m.healthy)
            .min_by_key(|(_, m)| m.priority)
            .map(|(i, _)| i)
        {
            state.active_mirror = Some(new_idx);
            return state
                .mirrors
                .get(new_idx)
                .map(|m| m.url.clone())
                .or_else(|| state.mirrors.first().map(|m| m.url.clone()))
                .unwrap_or_default()
                .into();
        }
        None
    }

    pub fn report_success(&self, url: &str) {
        if let Ok(mut state) = self.mirrors.lock() {
            if let Some(m) = state.mirrors.iter_mut().find(|m| m.url == url) {
                m.healthy = true;
            }
        }
    }

    pub fn mirrors(&self) -> Vec<MirrorSource> {
        self.mirrors
            .lock()
            .map(|state| state.mirrors.clone())
            .unwrap_or_default()
    }

    pub fn enable_failover(&self) {
        self.failover_enabled.store(true, Ordering::Relaxed);
    }

    pub fn disable_failover(&self) {
        self.failover_enabled.store(false, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mirror(url: &str, priority: u32) -> MirrorSource {
        MirrorSource {
            url: url.to_string(),
            priority,
            region: None,
            bandwidth_estimate: None,
            last_checked: None,
            healthy: true,
        }
    }

    #[test]
    fn new_creates_primary_as_active() {
        let mgr = MirrorManager::new("https://primary.example.com");
        assert_eq!(mgr.active_url(), "https://primary.example.com");
        assert_eq!(mgr.mirrors().len(), 1);
        assert!(mgr.mirrors()[0].healthy);
        assert_eq!(mgr.mirrors()[0].priority, 0);
    }

    #[test]
    fn add_mirror_adds_and_sorts_by_priority() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://low.example.com", 5));
        mgr.add_mirror(mirror("https://high.example.com", 1));
        mgr.add_mirror(mirror("https://mid.example.com", 3));

        let urls: Vec<String> = mgr.mirrors().iter().map(|m| m.url.clone()).collect();
        assert_eq!(
            urls,
            vec![
                "https://primary.example.com",
                "https://high.example.com",
                "https://mid.example.com",
                "https://low.example.com",
            ]
        );
    }

    #[test]
    fn set_mirrors_replaces_all() {
        let mgr = MirrorManager::new("https://old.example.com");
        mgr.set_mirrors(vec![
            mirror("https://b.example.com", 2),
            mirror("https://a.example.com", 1),
        ]);

        let mirrors = mgr.mirrors();
        assert_eq!(mirrors.len(), 2);
        assert_eq!(mirrors[0].url, "https://a.example.com");
        assert_eq!(mirrors[1].url, "https://b.example.com");
    }

    #[test]
    fn active_url_returns_current_active() {
        let mgr = MirrorManager::new("https://primary.example.com");
        assert_eq!(mgr.active_url(), "https://primary.example.com");

        mgr.add_mirror(mirror("https://secondary.example.com", 1));
        assert_eq!(mgr.active_url(), "https://primary.example.com");
    }

    #[test]
    fn report_failure_marks_unhealthy_and_switches() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));

        let result = mgr.report_failure("https://primary.example.com", "timeout");
        assert_eq!(result.as_deref(), Some("https://backup.example.com"));
        assert_eq!(mgr.active_url(), "https://backup.example.com");

        let mirrors = mgr.mirrors();
        let primary = mirrors
            .iter()
            .find(|m| m.url == "https://primary.example.com")
            .unwrap();
        assert!(!primary.healthy);
    }

    #[test]
    fn report_failure_cascades_to_next_healthy_source_without_cooldown() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup-one.example.com", 1));
        mgr.add_mirror(mirror("https://backup-two.example.com", 2));

        assert_eq!(
            mgr.report_failure("https://primary.example.com", "error")
                .as_deref(),
            Some("https://backup-one.example.com")
        );
        assert_eq!(
            mgr.report_failure("https://backup-one.example.com", "error")
                .as_deref(),
            Some("https://backup-two.example.com")
        );
        assert_eq!(mgr.active_url(), "https://backup-two.example.com");
    }

    #[test]
    fn report_failure_with_disabled_failover_returns_none() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));
        mgr.disable_failover();

        let result = mgr.report_failure("https://primary.example.com", "error");
        assert!(result.is_none());
        assert_eq!(mgr.active_url(), "https://primary.example.com");
    }

    #[test]
    fn report_success_marks_mirror_healthy() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));

        mgr.report_failure("https://primary.example.com", "error");
        assert!(
            !mgr.mirrors()
                .iter()
                .find(|m| m.url == "https://primary.example.com")
                .unwrap()
                .healthy
        );

        mgr.report_success("https://primary.example.com");
        assert!(
            mgr.mirrors()
                .iter()
                .find(|m| m.url == "https://primary.example.com")
                .unwrap()
                .healthy
        );
    }

    #[test]
    fn failover_to_higher_priority_mirror() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup-low.example.com", 10));
        mgr.add_mirror(mirror("https://backup-high.example.com", 2));

        let result = mgr.report_failure("https://primary.example.com", "error");
        assert_eq!(result.as_deref(), Some("https://backup-high.example.com"));
    }

    #[test]
    fn no_failover_when_all_mirrors_unhealthy() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));

        mgr.report_failure("https://primary.example.com", "error");
        assert_eq!(mgr.active_url(), "https://backup.example.com");

        let result = mgr.report_failure("https://backup.example.com", "error");
        assert!(result.is_none());
        assert_eq!(mgr.active_url(), "https://backup.example.com");
    }

    #[test]
    fn enable_failover_after_disable_restores_behavior() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));

        mgr.disable_failover();
        assert!(mgr
            .report_failure("https://primary.example.com", "error")
            .is_none());

        mgr.enable_failover();
        let result = mgr.report_failure("https://primary.example.com", "error");
        assert_eq!(result.as_deref(), Some("https://backup.example.com"));
    }

    #[test]
    fn late_failure_from_a_non_active_source_does_not_change_active_source() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));
        assert_eq!(
            mgr.report_failure("https://primary.example.com", "timeout")
                .as_deref(),
            Some("https://backup.example.com")
        );
        assert!(mgr
            .report_failure("https://primary.example.com", "late failure")
            .is_none());
        assert_eq!(mgr.active_url(), "https://backup.example.com");
    }

    #[test]
    fn report_failure_for_unknown_url_does_nothing() {
        let mgr = MirrorManager::new("https://primary.example.com");
        let result = mgr.report_failure("https://unknown.example.com", "error");
        assert!(result.is_none());
        assert_eq!(mgr.active_url(), "https://primary.example.com");
    }

    #[test]
    fn set_mirrors_with_empty_vec() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.set_mirrors(vec![]);
        assert!(mgr.mirrors().is_empty());
        assert_eq!(mgr.active_url(), "");
    }

    #[test]
    fn failover_picks_lowest_priority_number() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://c.example.com", 30));
        mgr.add_mirror(mirror("https://a.example.com", 1));
        mgr.add_mirror(mirror("https://b.example.com", 10));

        let result = mgr.report_failure("https://primary.example.com", "error");
        assert_eq!(result.as_deref(), Some("https://a.example.com"));
    }

    #[test]
    fn add_mirror_deduplicates_by_url() {
        // M7 regression: adding the same URL twice must not duplicate it.
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://m.example.com", 5));
        mgr.add_mirror(mirror("https://m.example.com", 5));
        mgr.add_mirror(mirror("https://m.example.com", 5));
        assert_eq!(mgr.mirrors().len(), 2, "duplicate urls must be upserted");
    }

    #[test]
    fn adding_a_higher_priority_mirror_preserves_the_active_failover_source() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 10));
        assert_eq!(
            mgr.report_failure("https://primary.example.com", "timeout")
                .as_deref(),
            Some("https://backup.example.com")
        );

        // This insertion moves indices after sorting, but it must not change
        // the currently active backup until a real failover decision does so.
        mgr.add_mirror(mirror("https://new.example.com", 1));
        assert_eq!(mgr.active_url(), "https://backup.example.com");
    }

    #[test]
    fn report_failure_marks_all_copies_unhealthy() {
        // M7 regression: every copy of the dead URL must be marked unhealthy
        // so failover cannot select a duplicate healthy copy. (With the
        // upsert fix duplicates no longer accumulate, but the marking logic
        // must still handle legacy states that already contain duplicates.)
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));
        // Force a legacy duplicated state directly (bypassing the upsert).
        {
            let mut state = mgr.mirrors.lock().unwrap();
            state.mirrors.push(mirror("https://backup.example.com", 1));
            state.mirrors.sort_by_key(|m| m.priority);
        }

        let result = mgr.report_failure("https://backup.example.com", "error");
        // A delayed report from a non-active source must not redirect the
        // current transfer, but every duplicate must be marked unhealthy.
        assert!(result.is_none());
        assert_eq!(mgr.active_url(), "https://primary.example.com");
        assert!(mgr
            .mirrors()
            .iter()
            .filter(|source| source.url == "https://backup.example.com")
            .all(|source| !source.healthy));
    }
}
