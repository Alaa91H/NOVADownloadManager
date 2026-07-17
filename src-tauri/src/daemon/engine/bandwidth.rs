use chrono::Timelike;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const SPEED_WINDOW_SIZE: usize = 30;

/// One `(sampled_at, bytes_per_sec)` measurement in a task's speed window.
type SpeedSample = (Instant, u64);
type SpeedHistory = HashMap<String, VecDeque<SpeedSample>>;

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
}

impl BandwidthManager {
    pub fn new(config: BandwidthConfig) -> Self {
        Self {
            global_limit: Arc::new(AtomicU64::new(config.global_limit_kbps)),
            task_limits: Arc::new(Mutex::new(config.per_task_limits)),
            schedule_limits: Arc::new(Mutex::new(config.schedule_limits)),
            speed_history: Arc::new(Mutex::new(HashMap::new())),
            global_paused: Arc::new(AtomicBool::new(false)),
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
                } else {
                    if now_hour >= sched.start_hour || now_hour < sched.end_hour {
                        return sched.limit_kbps;
                    }
                }
            }
        }
        base
    }

    pub fn allowed_speed_for_task(&self, task_id: &str) -> u64 {
        if self.global_paused.load(Ordering::Relaxed) {
            return 0;
        }
        let global = self.effective_global_limit();
        if global == 0 {
            if let Ok(limits) = self.task_limits.lock() {
                return limits.get(task_id).copied().unwrap_or(0);
            }
            return 0;
        }
        if let Ok(limits) = self.task_limits.lock() {
            if let Some(&per_task) = limits.get(task_id) {
                return per_task.min(global);
            }
        }
        global
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
        if let Ok(mut history) = self.speed_history.lock() {
            history.remove(task_id);
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

    pub fn report_speed(&self, task_id: &str, bytes_per_sec: u64) {
        if let Ok(mut history) = self.speed_history.lock() {
            let entry = history.entry(task_id.to_string()).or_default();
            entry.push_back((Instant::now(), bytes_per_sec));
            if entry.len() > SPEED_WINDOW_SIZE {
                entry.pop_front();
            }
        }
    }

    pub fn average_speed(&self, task_id: &str) -> u64 {
        self.speed_history
            .lock()
            .ok()
            .and_then(|history| {
                history.get(task_id).map(|entries| {
                    if entries.is_empty() {
                        return 0;
                    }
                    let sum: u64 = entries.iter().map(|(_, s)| s).sum();
                    sum / entries.len() as u64
                })
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
