use chrono::Timelike;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::lock_or_err;

const SPEED_WINDOW_SIZE: usize = 30;
/// Maximum unique task IDs to track in `speed_history`. Evicts oldest entries
/// (by last update) to cap memory. At ~240 bytes/entry, 5000 = ~1.2 MB.
const MAX_SPEED_HISTORY_TASKS: usize = 5_000;

/// One `(sampled_at, bytes_per_sec)` measurement in a task's speed window.
type SpeedSample = (Instant, u64);
type SpeedHistory = HashMap<String, VecDeque<SpeedSample>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RateLimit {
    /// No bandwidth cap — transfer runs as fast as the server allows.
    Unlimited,
    /// A hard cap in kB/s.
    Limit(u64),
    /// The task is paused: the transfer loop must not move bytes.
    Paused,
}

#[derive(Clone, Debug, Default)]
pub struct BandwidthConfig {
    pub global_limit_kbps: u64,
    pub per_task_limits: HashMap<String, u64>,
    pub schedule_limits: Vec<ScheduleLimit>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScheduleLimit {
    pub start_hour: u8,
    pub end_hour: u8,
    pub limit_kbps: u64,
}

#[derive(Clone)]
pub struct BandwidthManager {
    global_limit: Arc<AtomicU64>,
    task_limits: Arc<Mutex<HashMap<String, u64>>>,
    schedule_limits: Arc<Mutex<Vec<ScheduleLimit>>>,
    speed_history: Arc<Mutex<SpeedHistory>>,
    global_paused: Arc<AtomicBool>,
    /// Tracks insertion/access order of task IDs in speed_history for O(1) eviction.
    history_order: Arc<Mutex<VecDeque<String>>>,
}

impl BandwidthManager {
    pub fn new(config: BandwidthConfig) -> Self {
        Self {
            global_limit: Arc::new(AtomicU64::new(config.global_limit_kbps)),
            task_limits: Arc::new(Mutex::new(config.per_task_limits)),
            schedule_limits: Arc::new(Mutex::new(config.schedule_limits)),
            speed_history: Arc::new(Mutex::new(HashMap::new())),
            global_paused: Arc::new(AtomicBool::new(false)),
            history_order: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn effective_global_limit(&self) -> u64 {
        let base = self.global_limit.load(Ordering::Relaxed);
        if base == 0 {
            return 0;
        }
        if let Ok(schedules) = self.schedule_limits.lock() {
            let now_hour = chrono::Local::now().hour() as u8;
            for sched in schedules.iter() {
                if sched.start_hour <= sched.end_hour {
                    if now_hour >= sched.start_hour && now_hour < sched.end_hour {
                        return sched.limit_kbps;
                    }
                } else if now_hour >= sched.start_hour || now_hour < sched.end_hour {
                    return sched.limit_kbps;
                }
            }
        }
        base
    }

    pub fn allowed_speed_for_task(&self, task_id: &str) -> u64 {
        if self.global_paused.load(Ordering::Relaxed) {
            log::trace!("bandwidth: task {task_id} allowed 0 (global paused)");
            return 0;
        }
        let global = self.effective_global_limit();
        let per_task = self
            .task_limits
            .lock()
            .ok()
            .and_then(|limits| limits.get(task_id).copied());
        let allowed = match (global, per_task) {
            (0, Some(t)) => t,
            (0, None) => 0,
            (g, Some(t)) => t.min(g),
            (g, None) => g,
        };
        log::trace!(
            "bandwidth: task {task_id} allowed {allowed} kBps (global={global}, per_task={per_task:?})"
        );
        allowed
    }

    /// Resolve the effective rate limit for a task. Unlike
    /// `allowed_speed_for_task` (which overloads 0 as "no limit"), this
    /// distinguishes **paused** from **unlimited** — the two must never be
    /// conflated: a paused transfer must stall, an unlimited one must not be
    /// throttled at all.
    pub fn rate_limit_for(&self, task_id: &str) -> RateLimit {
        if self.global_paused.load(Ordering::Relaxed) {
            return RateLimit::Paused;
        }
        let global = self.effective_global_limit();
        let per_task = self
            .task_limits
            .lock()
            .ok()
            .and_then(|limits| limits.get(task_id).copied());
        match (global, per_task) {
            // No global and no per-task cap → unlimited.
            (0, None) => RateLimit::Unlimited,
            (0, Some(t)) => RateLimit::Limit(t),
            (g, Some(t)) => RateLimit::Limit(t.min(g)),
            (g, None) => RateLimit::Limit(g),
        }
    }

    pub fn set_global_limit(&self, kbps: u64) {
        self.global_limit.store(kbps, Ordering::Relaxed);
    }

    pub fn set_task_limit(&self, task_id: String, kbps: u64) {
        if let Ok(mut limits) = self.task_limits.lock() {
            limits.insert(task_id, kbps);
        }
    }

    pub fn remove_task_limit(&self, task_id: &str) {
        if let Ok(mut limits) = self.task_limits.lock() {
            limits.remove(task_id);
        }
        let mut history = lock_or_err!(self.speed_history);
        history.remove(task_id);
        drop(history);
        let mut order = lock_or_err!(self.history_order);
        if let Some(pos) = order.iter().position(|id| id == task_id) {
            order.remove(pos);
        }
    }

    pub fn set_schedule_limits(&self, limits: Vec<ScheduleLimit>) {
        if let Ok(mut sched) = self.schedule_limits.lock() {
            *sched = limits;
        }
    }

    pub fn pause_all(&self) {
        self.global_paused.store(true, Ordering::Relaxed);
    }

    pub fn resume_all(&self) {
        self.global_paused.store(false, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.global_paused.load(Ordering::Relaxed)
    }

    /// Shared reference to the pause flag, used by transfer drive loops as a
    /// pause gate (no bytes move while it is set).
    pub fn paused_flag(&self) -> &AtomicBool {
        &self.global_paused
    }

    pub fn report_speed(&self, task_id: &str, bytes_per_sec: u64) {
        // lock_or_err! logs on poison instead of silently dropping the sample,
        // which would otherwise make every speed report read back as 0 after a
        // panic in a previous holder.
        let mut history = lock_or_err!(self.speed_history);
        {
            // O(1) eviction via VecDeque order — evict oldest entries when at capacity
            // instead of scanning all entries with retain().
            if history.len() >= MAX_SPEED_HISTORY_TASKS && !history.contains_key(task_id) {
                let mut order = lock_or_err!(self.history_order);
                while history.len() >= MAX_SPEED_HISTORY_TASKS {
                    if let Some(oldest) = order.pop_front() {
                        history.remove(&oldest);
                    } else {
                        break;
                    }
                }
            }
            let entry = history.entry(task_id.to_owned()).or_default();
            entry.push_back((Instant::now(), bytes_per_sec));
            if entry.len() > SPEED_WINDOW_SIZE {
                entry.pop_front();
            }
        }
        drop(history);
        // Track access order outside the history lock for O(1) eviction.
        let mut order = lock_or_err!(self.history_order);
        if let Some(pos) = order.iter().position(|id| id == task_id) {
            order.remove(pos);
        }
        order.push_back(task_id.to_owned());
    }

    pub fn average_speed(&self, task_id: &str) -> u64 {
        let history = lock_or_err!(self.speed_history);
        history
            .get(task_id)
            .map(|entries| {
                if entries.is_empty() {
                    return 0;
                }
                let sum = entries.iter().fold(0u128, |total, (_, speed)| {
                    total.saturating_add(u128::from(*speed))
                });
                (sum / entries.len() as u128).min(u128::from(u64::MAX)) as u64
            })
            .unwrap_or(0)
    }
}

impl Default for BandwidthManager {
    fn default() -> Self {
        Self::new(BandwidthConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mgr_with_global(kbps: u64) -> BandwidthManager {
        BandwidthManager::new(BandwidthConfig {
            global_limit_kbps: kbps,
            ..Default::default()
        })
    }

    #[test]
    fn default_has_zero_global_limit() {
        let m = BandwidthManager::default();
        assert_eq!(m.effective_global_limit(), 0);
    }

    #[test]
    fn set_global_limit_roundtrip() {
        let m = mgr_with_global(0);
        assert_eq!(m.effective_global_limit(), 0);
        m.set_global_limit(5000);
        assert_eq!(m.effective_global_limit(), 5000);
        m.set_global_limit(0);
        assert_eq!(m.effective_global_limit(), 0);
    }

    #[test]
    fn allowed_speed_no_limits_returns_zero() {
        let m = BandwidthManager::default();
        assert_eq!(m.allowed_speed_for_task("t1"), 0);
    }

    #[test]
    fn allowed_speed_global_limit_returns_global() {
        let m = mgr_with_global(1000);
        assert_eq!(m.allowed_speed_for_task("t1"), 1000);
    }

    #[test]
    fn allowed_speed_per_task_returns_min_of_per_task_and_global() {
        let m = mgr_with_global(1000);

        m.set_task_limit("t1".into(), 500);
        assert_eq!(m.allowed_speed_for_task("t1"), 500);

        m.set_task_limit("t1".into(), 2000);
        assert_eq!(m.allowed_speed_for_task("t1"), 1000);
    }

    #[test]
    fn allowed_speed_global_zero_uses_per_task_only() {
        let m = mgr_with_global(0);
        m.set_task_limit("t1".into(), 500);
        assert_eq!(m.allowed_speed_for_task("t1"), 500);
    }

    #[test]
    fn pause_all_makes_allowed_speed_zero() {
        let m = mgr_with_global(1000);
        m.set_task_limit("t1".into(), 500);

        m.pause_all();
        assert!(m.is_paused());
        assert_eq!(m.allowed_speed_for_task("t1"), 0);
    }

    #[test]
    fn rate_limit_paused_is_distinct_from_unlimited() {
        // Regression for H1: pause must NEVER be represented as "0 → no limit".
        let m = mgr_with_global(0);
        assert_eq!(m.rate_limit_for("t1"), RateLimit::Unlimited);

        m.pause_all();
        assert_eq!(m.rate_limit_for("t1"), RateLimit::Paused);
        // The legacy 0-overload must still return 0 for paused (kept for
        // callers that only need the numeric form), but the enum carries the
        // real semantics.
        assert_eq!(m.allowed_speed_for_task("t1"), 0);
    }

    #[test]
    fn rate_limit_global_and_per_task() {
        let m = mgr_with_global(1000);
        assert_eq!(m.rate_limit_for("t1"), RateLimit::Limit(1000));

        m.set_task_limit("t1".into(), 500);
        assert_eq!(m.rate_limit_for("t1"), RateLimit::Limit(500));

        let m2 = mgr_with_global(0);
        assert_eq!(m2.rate_limit_for("t1"), RateLimit::Unlimited);
    }

    #[test]
    fn resume_all_restores_allowed_speed() {
        let m = mgr_with_global(1000);
        m.set_task_limit("t1".into(), 500);

        m.pause_all();
        m.resume_all();
        assert!(!m.is_paused());
        assert_eq!(m.allowed_speed_for_task("t1"), 500);
    }

    #[test]
    fn report_and_average_speed_single_sample() {
        let m = mgr_with_global(1000);
        m.report_speed("t1", 1024);
        assert_eq!(m.average_speed("t1"), 1024);
    }

    #[test]
    fn report_and_average_speed_multiple_samples() {
        let m = mgr_with_global(1000);
        m.report_speed("t1", 1000);
        m.report_speed("t1", 2000);
        m.report_speed("t1", 3000);
        assert_eq!(m.average_speed("t1"), 2000);
    }

    #[test]
    fn average_speed_handles_extreme_samples_without_overflow() {
        let m = mgr_with_global(1000);
        for _ in 0..SPEED_WINDOW_SIZE {
            m.report_speed("t1", u64::MAX);
        }
        assert_eq!(m.average_speed("t1"), u64::MAX);
    }

    #[test]
    fn average_speed_unknown_task_returns_zero() {
        let m = mgr_with_global(1000);
        assert_eq!(m.average_speed("nonexistent"), 0);
    }

    #[test]
    fn remove_task_limit_restores_global_as_allowed() {
        let m = mgr_with_global(1000);
        m.set_task_limit("t1".into(), 500);
        assert_eq!(m.allowed_speed_for_task("t1"), 500);

        m.remove_task_limit("t1");
        assert_eq!(m.allowed_speed_for_task("t1"), 1000);
    }

    #[test]
    fn remove_task_limit_cleans_history_without_deadlock() {
        // M27 regression: remove_task_limit must not hold nested locks across
        // speed_history and history_order (or deadlock under concurrent
        // report_speed). Exercise it concurrently to shake out lock order
        // inversion.
        let m = std::sync::Arc::new(mgr_with_global(1000));
        let m2 = m.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..500u64 {
                m2.report_speed("t1", i);
            }
        });
        for _ in 0..50 {
            m.set_task_limit("t1".into(), 500);
            m.remove_task_limit("t1");
        }
        writer.join().unwrap();
        // Final cleanup after the writer is done; then the history must be
        // gone and the global limit applies.
        m.remove_task_limit("t1");
        assert_eq!(m.average_speed("t1"), 0);
        assert_eq!(m.allowed_speed_for_task("t1"), 1000);
    }

    #[test]
    fn speed_window_capped_at_30() {
        let m = mgr_with_global(1000);

        for i in 0..50u64 {
            m.report_speed("t1", i);
        }

        // Window holds the last 30 samples: values 20..=49
        // sum = (20 + 49) * 30 / 2 = 1035, avg = 1035 / 30 = 34
        assert_eq!(m.average_speed("t1"), 34);
    }

    #[test]
    fn schedule_limit_overrides_global_when_in_window() {
        let hour = chrono::Local::now().hour() as u8;
        let m = mgr_with_global(5000);
        m.set_schedule_limits(vec![ScheduleLimit {
            start_hour: hour,
            end_hour: hour + 1,
            limit_kbps: 500,
        }]);
        assert_eq!(m.effective_global_limit(), 500);
    }

    #[test]
    fn schedule_limit_wraparound_covers_current_hour() {
        let hour = chrono::Local::now().hour() as u8;
        let prev = if hour == 0 { 23 } else { hour - 1 };
        let m = mgr_with_global(5000);

        // start > end ⇒ wraps; covers [start,24) ∪ [0,end)
        // hour >= start (hour >= hour) ⇒ matches
        m.set_schedule_limits(vec![ScheduleLimit {
            start_hour: hour,
            end_hour: prev,
            limit_kbps: 200,
        }]);
        assert_eq!(m.effective_global_limit(), 200);
    }

    #[test]
    fn schedule_limit_not_in_window_returns_base() {
        let hour = chrono::Local::now().hour() as u8;
        let m = mgr_with_global(5000);
        m.set_schedule_limits(vec![ScheduleLimit {
            start_hour: (hour + 2) % 24,
            end_hour: (hour + 3) % 24,
            limit_kbps: 100,
        }]);
        assert_eq!(m.effective_global_limit(), 5000);
    }

    #[test]
    fn no_task_limit_task_gets_global_speed() {
        let m = mgr_with_global(3000);
        m.set_task_limit("known".into(), 500);
        assert_eq!(m.allowed_speed_for_task("known"), 500);
        assert_eq!(m.allowed_speed_for_task("unknown"), 3000);
    }

    #[test]
    fn average_speed_empty_history_returns_zero() {
        let m = mgr_with_global(1000);
        m.report_speed("t1", 100);
        m.remove_task_limit("t1");
        assert_eq!(m.average_speed("t1"), 0);
    }
}
