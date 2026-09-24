use chrono::{DateTime, Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SchedulerRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: SchedulerTrigger,
    pub action: SchedulerAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SchedulerTrigger {
    TimeWindow {
        start_hour: u8,
        start_minute: u8,
        end_hour: u8,
        end_minute: u8,
    },
    BandwidthBelow {
        threshold_kbps: u64,
    },
    QueueEmpty,
    AllComplete,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SchedulerAction {
    StartDownload {
        task_ids: Vec<String>,
    },
    PauseDownload {
        task_ids: Vec<String>,
    },
    SetBandwidthLimit {
        kbps: u64,
    },
    SetPriority {
        task_ids: Vec<String>,
        priority: String,
    },
    Notify {
        message: String,
    },
    /// Shut down the computer after all downloads complete.
    Shutdown,
    /// Put the computer to sleep after all downloads complete.
    Sleep,
}

#[derive(Clone, Debug)]
struct QueueRetryRuntime {
    attempts: u32,
    next_allowed: Instant,
}

#[derive(Default)]
struct QueueSchedulerRuntime {
    window_active: HashMap<String, bool>,
    completion_state: HashMap<String, bool>,
    retries: HashMap<(String, String), QueueRetryRuntime>,
    exit_requested: bool,
}

fn parse_hhmm(value: Option<&str>, fallback_hour: u32, fallback_minute: u32) -> (u32, u32) {
    let Some(raw) = value else {
        return (fallback_hour, fallback_minute);
    };
    let mut parts = raw.trim().split(':');
    let hour = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .filter(|hour| *hour < 24)
        .unwrap_or(fallback_hour);
    let minute = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .filter(|minute| *minute < 60)
        .unwrap_or(fallback_minute);
    (hour, minute)
}

/// Returns whether a daemon-owned queue schedule is active for the supplied time.
///
/// For windows that cross midnight, the early-morning portion belongs to the
/// weekday on which the window started. This keeps custom-day schedules
/// intuitive and matches desktop queue semantics.
pub fn queue_schedule_window_active(
    queue: &serde_json::Value,
    now: &DateTime<Local>,
) -> bool {
    if !queue
        .get("scheduled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }

    let schedule_type = queue
        .get("scheduleType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("daily");
    if schedule_type == "once"
        && queue
            .get("scheduleCompleted")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    {
        return false;
    }

    let (start_hour, start_minute) = parse_hhmm(
        queue.get("startTime").and_then(serde_json::Value::as_str),
        0,
        0,
    );
    let (end_hour, end_minute) = parse_hhmm(
        queue.get("endTime").and_then(serde_json::Value::as_str),
        23,
        59,
    );
    let start = start_hour * 60 + start_minute;
    let end = end_hour * 60 + end_minute;
    let current = now.hour() * 60 + now.minute();
    let overnight = start > end;
    let in_window = if start <= end {
        current >= start && current < end
    } else {
        current >= start || current < end
    };
    if !in_window {
        return false;
    }

    if schedule_type == "daily" {
        return true;
    }

    let schedule_day = if overnight && current < end {
        (now.clone() - chrono::Duration::days(1))
            .weekday()
            .num_days_from_sunday() as u64
    } else {
        now.weekday().num_days_from_sunday() as u64
    };
    let days = queue
        .get("days")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_u64)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![0, 1, 2, 3, 4, 5, 6]);

    days.contains(&schedule_day)
}

#[derive(Clone)]
pub struct SmartScheduler {
    rules: Arc<Mutex<Vec<SchedulerRule>>>,
    active_rules: Arc<Mutex<Vec<String>>>,
    power_commands_enabled: Arc<std::sync::atomic::AtomicBool>,
    /// Rules that have already fired while their trigger stays satisfied.
    /// Used to make evaluation edge-triggered: a rule fires once when its
    /// condition becomes true, then stays silent until it goes false and
    /// true again. Prevents Shutdown/Sleep/Notify spam every 60s tick.
    fired_rules: Arc<Mutex<std::collections::HashSet<String>>>,
    queue_runtime: Arc<Mutex<QueueSchedulerRuntime>>,
}

impl SmartScheduler {
    pub fn new() -> Self {
        Self {
            rules: Arc::new(Mutex::new(Vec::new())),
            active_rules: Arc::new(Mutex::new(Vec::new())),
            power_commands_enabled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            fired_rules: Arc::new(Mutex::new(std::collections::HashSet::new())),
            queue_runtime: Arc::new(Mutex::new(QueueSchedulerRuntime::default())),
        }
    }

    pub fn queue_window_transition(&self, queue_id: &str, active: bool) -> (bool, bool) {
        let Ok(mut runtime) = self.queue_runtime.lock() else {
            return (false, false);
        };
        let previous = runtime
            .window_active
            .insert(queue_id.to_owned(), active)
            .unwrap_or(false);
        (!previous && active, previous && !active)
    }

    pub fn queue_completion_edge(&self, queue_id: &str, completed: bool) -> bool {
        let Ok(mut runtime) = self.queue_runtime.lock() else {
            return false;
        };
        match runtime.completion_state.insert(queue_id.to_owned(), completed) {
            Some(previous) => !previous && completed,
            None => false,
        }
    }

    pub fn queue_retry_due(
        &self,
        queue_id: &str,
        task_id: &str,
        failed: bool,
        max_retries: u32,
        retry_delay_secs: u64,
    ) -> bool {
        let Ok(mut runtime) = self.queue_runtime.lock() else {
            return false;
        };
        let key = (queue_id.to_owned(), task_id.to_owned());
        if !failed || max_retries == 0 {
            runtime.retries.remove(&key);
            return false;
        }

        let now = Instant::now();
        let delay = Duration::from_secs(retry_delay_secs.max(1));
        let entry = runtime.retries.entry(key).or_insert_with(|| QueueRetryRuntime {
            attempts: 0,
            next_allowed: now + delay,
        });

        if entry.attempts >= max_retries || now < entry.next_allowed {
            return false;
        }

        entry.attempts = entry.attempts.saturating_add(1);
        entry.next_allowed = now + delay;
        true
    }

    pub fn reset_queue_runtime(&self, queue_id: &str) {
        if let Ok(mut runtime) = self.queue_runtime.lock() {
            runtime.window_active.remove(queue_id);
            runtime.completion_state.remove(queue_id);
            runtime.retries.retain(|(id, _), _| id != queue_id);
        }
    }

    pub fn request_exit(&self) {
        if let Ok(mut runtime) = self.queue_runtime.lock() {
            runtime.exit_requested = true;
        }
    }

    pub fn exit_requested(&self) -> bool {
        self.queue_runtime
            .lock()
            .map(|runtime| runtime.exit_requested)
            .unwrap_or(false)
    }

    pub fn set_power_commands_enabled(&self, enabled: bool) {
        self.power_commands_enabled
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn power_commands_enabled(&self) -> bool {
        self.power_commands_enabled
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn add_rule(&self, rule: SchedulerRule) {
        if let Ok(mut rules) = self.rules.lock() {
            rules.push(rule);
        }
    }

    pub fn remove_rule(&self, rule_id: &str) {
        if let Ok(mut rules) = self.rules.lock() {
            rules.retain(|r| r.id != rule_id);
        }
    }

    pub fn update_rule(&self, rule: SchedulerRule) {
        if let Ok(mut rules) = self.rules.lock() {
            if let Some(existing) = rules.iter_mut().find(|r| r.id == rule.id) {
                *existing = rule;
            }
        }
    }

    /// Evaluate all enabled rules against the current download state.
    ///
    /// `active_count` is the number of downloads currently in flight,
    /// `queued_count` the number waiting to start, and `total_count` the total
    /// number of known tasks. These are used to give the `QueueEmpty` and
    /// `AllComplete` triggers distinct semantics:
    ///   - `QueueEmpty` fires when nothing is running and nothing is queued.
    ///   - `AllComplete` fires only when *something existed to complete*
    ///     (`total_count > 0`) and every task has reached a terminal state.
    pub fn evaluate(
        &self,
        current_bandwidth_kbps: u64,
        active_count: u32,
        queued_count: u32,
        total_count: u32,
    ) -> Vec<SchedulerAction> {
        let rules = match self.rules.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        let now = Local::now();
        let current_hour = now.hour() as u8;
        let current_minute = now.minute() as u8;
        let mut actions = Vec::new();
        let mut triggered_ids = Vec::new();
        let mut newly_fired = std::collections::HashSet::new();
        {
            // Snapshot the fired set once; drop the lock before running user
            // actions so a long rule handler cannot deadlock with add_rule.
            let fired = match self.fired_rules.lock() {
                Ok(g) => g.clone(),
                Err(_) => std::collections::HashSet::new(),
            };
            for rule in rules.iter() {
                if !rule.enabled {
                    continue;
                }
                let triggered = match &rule.trigger {
                    SchedulerTrigger::TimeWindow {
                        start_hour,
                        start_minute,
                        end_hour,
                        end_minute,
                    } => {
                        let start = u32::from(*start_hour) * 60 + u32::from(*start_minute);
                        let end = u32::from(*end_hour) * 60 + u32::from(*end_minute);
                        let current = u32::from(current_hour) * 60 + u32::from(current_minute);
                        if start <= end {
                            current >= start && current < end
                        } else {
                            current >= start || current < end
                        }
                    }
                    SchedulerTrigger::BandwidthBelow { threshold_kbps } => {
                        current_bandwidth_kbps < *threshold_kbps && current_bandwidth_kbps > 0
                    }
                    SchedulerTrigger::QueueEmpty => active_count == 0 && queued_count == 0,
                    SchedulerTrigger::AllComplete => {
                        active_count == 0 && queued_count == 0 && total_count > 0
                    }
                };

                if triggered {
                    triggered_ids.push(rule.id.clone());
                    // Edge-trigger: emit the action only the first time the
                    // rule's condition holds (H2). Once fired, stay silent
                    // until the condition clears and re-triggers.
                    if !fired.contains(&rule.id) {
                        newly_fired.insert(rule.id.clone());
                        actions.push(rule.action.clone());
                    }
                }
            }
            if let Ok(mut fired) = self.fired_rules.lock() {
                // Rules that are no longer triggered are reset so they can
                // fire again when the condition returns.
                fired.retain(|id| triggered_ids.iter().any(|t| t == id));
                fired.extend(newly_fired);
            }
        }
        drop(rules);
        if let Ok(mut active) = self.active_rules.lock() {
            *active = triggered_ids;
        }
        log::trace!(
            "scheduler evaluate: active={active_count} queued={queued_count} total={total_count} bandwidth={current_bandwidth_kbps}kBps actions={}",
            actions.len()
        );
        actions
    }

    /// Ids of the rules whose triggers matched during the most recent evaluation.
    pub fn active_rule_ids(&self) -> Vec<String> {
        self.active_rules
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn rules(&self) -> Vec<SchedulerRule> {
        self.rules.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Default for SmartScheduler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rule(id: &str, trigger: SchedulerTrigger, action: SchedulerAction) -> SchedulerRule {
        SchedulerRule {
            id: id.to_string(),
            name: format!("rule {}", id),
            enabled: true,
            trigger,
            action,
        }
    }

    #[test]
    fn empty_rules_returns_no_actions() {
        let sched = SmartScheduler::new();
        let actions = sched.evaluate(1000, 5, 3, 4);
        assert!(actions.is_empty());
    }

    #[test]
    fn disabled_rule_not_triggered() {
        let sched = SmartScheduler::new();
        let mut rule = make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "test".into(),
            },
        );
        rule.enabled = false;
        sched.add_rule(rule);
        let actions = sched.evaluate(1000, 0, 0, 0);
        assert!(actions.is_empty());
    }

    #[test]
    fn queue_empty_triggers_when_no_active() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "queue empty".into(),
            },
        ));
        let actions = sched.evaluate(1000, 0, 0, 0);
        assert_eq!(actions.len(), 1);
    }

    #[test]
    fn queue_empty_does_not_trigger_when_active() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "queue empty".into(),
            },
        ));
        let actions = sched.evaluate(1000, 3, 0, 3);
        assert!(actions.is_empty());
    }

    #[test]
    fn bandwidth_below_triggers_when_under_threshold() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::BandwidthBelow {
                threshold_kbps: 5000,
            },
            SchedulerAction::Notify {
                message: "low bw".into(),
            },
        ));
        let actions = sched.evaluate(3000, 1, 0, 1);
        assert_eq!(actions.len(), 1);
    }

    #[test]
    fn bandwidth_below_does_not_trigger_above_threshold() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::BandwidthBelow {
                threshold_kbps: 5000,
            },
            SchedulerAction::Notify {
                message: "low bw".into(),
            },
        ));
        let actions = sched.evaluate(6000, 1, 0, 1);
        assert!(actions.is_empty());
    }

    #[test]
    fn bandwidth_below_does_not_trigger_at_zero() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::BandwidthBelow {
                threshold_kbps: 5000,
            },
            SchedulerAction::Notify {
                message: "low bw".into(),
            },
        ));
        let actions = sched.evaluate(0, 1, 0, 1);
        assert!(actions.is_empty());
    }

    #[test]
    fn time_window_triggers_inside_window() {
        let sched = SmartScheduler::new();
        let now = Local::now();
        let current_minute = now.hour() as u16 * 60 + now.minute() as u16;
        let start = current_minute;
        let end = current_minute + 5;
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::TimeWindow {
                start_hour: ((start / 60) % 24) as u8,
                start_minute: (start % 60) as u8,
                end_hour: ((end / 60) % 24) as u8,
                end_minute: (end % 60) as u8,
            },
            SchedulerAction::Notify {
                message: "in window".into(),
            },
        ));
        let actions = sched.evaluate(1000, 1, 0, 0);
        assert_eq!(actions.len(), 1);
    }

    #[test]
    fn time_window_does_not_trigger_outside_window() {
        let sched = SmartScheduler::new();
        let now = Local::now();
        let current_minute = now.hour() as u16 * 60 + now.minute() as u16;
        let start = (current_minute + 10) % 1440;
        let end = (current_minute + 15) % 1440;
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::TimeWindow {
                start_hour: ((start / 60) % 24) as u8,
                start_minute: (start % 60) as u8,
                end_hour: ((end / 60) % 24) as u8,
                end_minute: (end % 60) as u8,
            },
            SchedulerAction::Notify {
                message: "in window".into(),
            },
        ));
        let actions = sched.evaluate(1000, 1, 0, 0);
        assert!(actions.is_empty());
    }

    #[test]
    fn remove_rule_stops_triggering() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "test".into(),
            },
        ));
        assert_eq!(sched.evaluate(1000, 0, 0, 0).len(), 1);
        sched.remove_rule("r1");
        assert!(sched.evaluate(1000, 0, 0, 0).is_empty());
    }

    #[test]
    fn update_rule_changes_trigger() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "old".into(),
            },
        ));
        sched.update_rule(make_rule(
            "r1",
            SchedulerTrigger::BandwidthBelow {
                threshold_kbps: 100,
            },
            SchedulerAction::Notify {
                message: "new".into(),
            },
        ));
        assert!(sched.evaluate(1000, 0, 0, 0).is_empty());
        assert_eq!(sched.evaluate(50, 1, 0, 1).len(), 1);
    }

    #[test]
    fn active_rule_ids_tracked() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "test".into(),
            },
        ));
        sched.add_rule(make_rule(
            "r2",
            SchedulerTrigger::BandwidthBelow {
                threshold_kbps: 5000,
            },
            SchedulerAction::Notify {
                message: "test2".into(),
            },
        ));
        sched.evaluate(3000, 0, 0, 0);
        let ids = sched.active_rule_ids();
        assert!(ids.contains(&"r1".to_string()));
        assert!(ids.contains(&"r2".to_string()));
    }

    #[test]
    fn rules_method_returns_all() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "test".into(),
            },
        ));
        sched.add_rule(make_rule(
            "r2",
            SchedulerTrigger::AllComplete,
            SchedulerAction::Notify {
                message: "test2".into(),
            },
        ));
        assert_eq!(sched.rules().len(), 2);
    }

    #[test]
    fn multiple_rules_all_triggered() {
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "r1",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "empty".into(),
            },
        ));
        sched.add_rule(make_rule(
            "r2",
            SchedulerTrigger::BandwidthBelow {
                threshold_kbps: 5000,
            },
            SchedulerAction::SetBandwidthLimit { kbps: 1000 },
        ));
        let actions = sched.evaluate(3000, 0, 0, 0);
        assert_eq!(actions.len(), 2);
    }

    #[test]
    fn queue_schedule_supports_custom_days_and_overnight_windows() {
        let queue = serde_json::json!({
            "scheduled": true,
            "scheduleType": "custom",
            "startTime": "22:00",
            "endTime": "06:00",
            "days": [3],
            "scheduleCompleted": false
        });

        let wednesday_late = chrono::NaiveDate::from_ymd_opt(2026, 9, 23)
            .unwrap()
            .and_hms_opt(23, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .single()
            .unwrap();
        assert!(queue_schedule_window_active(&queue, &wednesday_late));

        let thursday_early = chrono::NaiveDate::from_ymd_opt(2026, 9, 24)
            .unwrap()
            .and_hms_opt(2, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .single()
            .unwrap();
        assert!(queue_schedule_window_active(&queue, &thursday_early));

        let thursday_late = chrono::NaiveDate::from_ymd_opt(2026, 9, 24)
            .unwrap()
            .and_hms_opt(23, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .single()
            .unwrap();
        assert!(!queue_schedule_window_active(&queue, &thursday_late));
    }

    #[test]
    fn once_queue_stays_disabled_after_completion() {
        let queue = serde_json::json!({
            "scheduled": true,
            "scheduleType": "once",
            "startTime": "00:00",
            "endTime": "23:59",
            "days": [4],
            "scheduleCompleted": true
        });
        let now = chrono::NaiveDate::from_ymd_opt(2026, 9, 24)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_local_timezone(Local)
            .single()
            .unwrap();
        assert!(!queue_schedule_window_active(&queue, &now));
    }

    #[test]
    fn queue_runtime_edges_and_retry_delay_are_stateful() {
        let sched = SmartScheduler::new();
        assert_eq!(sched.queue_window_transition("night", false), (false, false));
        assert_eq!(sched.queue_window_transition("night", true), (true, false));
        assert_eq!(sched.queue_window_transition("night", true), (false, false));
        assert_eq!(sched.queue_window_transition("night", false), (false, true));

        assert!(!sched.queue_completion_edge("night", true));
        assert!(!sched.queue_completion_edge("night", true));
        assert!(!sched.queue_completion_edge("night", false));
        assert!(sched.queue_completion_edge("night", true));

        assert!(!sched.queue_retry_due("night", "task-1", true, 3, 60));
        assert!(!sched.queue_retry_due("night", "task-1", false, 3, 60));
    }

    #[test]
    fn rules_are_edge_triggered_not_level_triggered() {
        // H2 regression: Shutdown/Sleep/Notify must fire ONCE while the
        // condition holds, not on every 60s tick.
        let sched = SmartScheduler::new();
        sched.add_rule(make_rule(
            "shutdown-on-idle",
            SchedulerTrigger::AllComplete,
            SchedulerAction::Shutdown,
        ));
        sched.add_rule(make_rule(
            "notify-on-idle",
            SchedulerTrigger::QueueEmpty,
            SchedulerAction::Notify {
                message: "idle".into(),
            },
        ));

        // First evaluation: both fire.
        let first = sched.evaluate(1000, 0, 0, 3);
        assert_eq!(first.len(), 2, "first evaluation must fire both rules");

        // Condition still holds: nothing may fire again.
        let second = sched.evaluate(1000, 0, 0, 3);
        assert!(
            second.is_empty(),
            "edge-triggered rules must not re-fire while condition holds"
        );
        let third = sched.evaluate(1000, 0, 0, 3);
        assert!(third.is_empty(), "still silent on third evaluation");

        // Condition clears (a download starts)…
        let cleared = sched.evaluate(1000, 1, 0, 3);
        assert!(cleared.is_empty(), "condition false → no actions");

        // …and returns: rules fire exactly once more.
        let refired = sched.evaluate(1000, 0, 0, 3);
        assert_eq!(
            refired.len(),
            2,
            "rules must fire again after the condition clears"
        );
    }
}
