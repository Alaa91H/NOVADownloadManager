use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
pub struct MirrorManager {
    mirrors: Arc<std::sync::Mutex<Vec<MirrorSource>>>,
    active_mirror: Arc<std::sync::Mutex<Option<usize>>>,
    failover_enabled: Arc<AtomicBool>,
    last_failover: Arc<std::sync::Mutex<Instant>>,
    failover_cooldown: Duration,
}

impl MirrorManager {
    pub fn new(primary_url: &str) -> Self {
        let mirrors = vec![MirrorSource {
            url: primary_url.to_string(),
            priority: 0,
            region: None,
            bandwidth_estimate: None,
            last_checked: None,
            healthy: true,
        }];
        Self {
            mirrors: Arc::new(std::sync::Mutex::new(mirrors)),
            active_mirror: Arc::new(std::sync::Mutex::new(Some(0))),
            failover_enabled: Arc::new(AtomicBool::new(true)),
            last_failover: Arc::new(std::sync::Mutex::new(
                Instant::now() - Duration::from_secs(60),
            )),
            failover_cooldown: Duration::from_secs(30),
        }
    }

    pub fn add_mirror(&self, mirror: MirrorSource) {
        if let Ok(mut mirrors) = self.mirrors.lock() {
            mirrors.push(mirror);
            mirrors.sort_by_key(|m| m.priority);
        }
    }

    pub fn set_mirrors(&self, mirrors: Vec<MirrorSource>) {
        if let Ok(mut m) = self.mirrors.lock() {
            *m = mirrors;
            m.sort_by_key(|m| m.priority);
        }
        if let Ok(mut active) = self.active_mirror.lock() {
            *active = if self.mirrors.lock().map(|m| !m.is_empty()).unwrap_or(false) {
                Some(0)
            } else {
                None
            };
        }
    }

    pub fn active_url(&self) -> String {
        let mirrors = match self.mirrors.lock() {
            Ok(g) => g,
            Err(_) => return String::new(),
        };
        let idx = self.active_mirror.lock().ok().and_then(|i| *i).unwrap_or(0);
        mirrors
            .get(idx)
            .map(|m| m.url.clone())
            .or_else(|| mirrors.first().map(|m| m.url.clone()))
            .unwrap_or_default()
    }

    pub fn report_failure(&self, url: &str, _error: &str) -> Option<String> {
        if !self.failover_enabled.load(Ordering::Relaxed) {
            return None;
        }
        let mut last = match self.last_failover.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        if last.elapsed() < self.failover_cooldown {
            return None;
        }

        let mut mirrors = match self.mirrors.lock() {
            Ok(g) => g,
            Err(_) => return None,
        };
        if let Some(m) = mirrors.iter_mut().find(|m| m.url == url) {
            m.healthy = false;
        }
        if let Some(idx) = mirrors.iter().position(|m| m.url == url) {
            let next = mirrors
                .iter()
                .enumerate()
                .filter(|(i, m)| *i != idx && m.healthy)
                .min_by_key(|(_, m)| m.priority)
                .map(|(i, _)| i);

            if let Some(new_idx) = next {
                drop(mirrors);
                if let Ok(mut active) = self.active_mirror.lock() {
                    *active = Some(new_idx);
                }
                *last = Instant::now();
                return self.active_url().into();
            }
        }
        None
    }

    pub fn report_success(&self, url: &str) {
        if let Ok(mut mirrors) = self.mirrors.lock() {
            if let Some(m) = mirrors.iter_mut().find(|m| m.url == url) {
                m.healthy = true;
            }
        }
    }

    pub fn mirrors(&self) -> Vec<MirrorSource> {
        self.mirrors.lock().map(|g| g.clone()).unwrap_or_default()
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
    fn report_failure_respects_cooldown() {
        let mgr = MirrorManager::new("https://primary.example.com");
        mgr.add_mirror(mirror("https://backup.example.com", 1));

        let first = mgr.report_failure("https://primary.example.com", "error");
        assert!(first.is_some());

        let second = mgr.report_failure("https://backup.example.com", "error");
        assert!(
            second.is_none(),
            "should return None within cooldown period"
        );
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
}
