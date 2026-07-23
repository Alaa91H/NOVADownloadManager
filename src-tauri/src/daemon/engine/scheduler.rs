use chrono::{Local, Timelike};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

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

#[derive(Clone)]
pub struct SmartScheduler {
    rules: Arc<Mutex<Vec<SchedulerRule>>>,
    active_rules: Arc<Mutex<Vec<String>>>,
}

impl SmartScheduler {
    pub fn new() -> Self {
        Self {
            rules: Arc::new(Mutex::new(Vec::new())),
            active_rules: Arc::new(Mutex::new(Vec::new())),
        }
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

    pub fn evaluate(&self, current_bandwidth_kbps: u64, active_count: u32) -> Vec<SchedulerAction> {
        let rules = match self.rules.lock() {
            Ok(g) => g,
            Err(_) => return Vec::new(),
        };
        let now = Local::now();
        let current_hour = now.hour() as u8;
        let current_minute = now.minute() as u8;
        let mut actions = Vec::new();
        let mut triggered_ids = Vec::new();

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
                    let start = *start_hour as u32 * 60 + *start_minute as u32;
                    let end = *end_hour as u32 * 60 + *end_minute as u32;
                    let current = current_hour as u32 * 60 + current_minute as u32;
                    if start <= end {
                        current >= start && current < end
                    } else {
                        current >= start || current < end
                    }
                }
                SchedulerTrigger::BandwidthBelow { threshold_kbps } => {
                    current_bandwidth_kbps < *threshold_kbps && current_bandwidth_kbps > 0
                }
                SchedulerTrigger::QueueEmpty => active_count == 0,
                SchedulerTrigger::AllComplete => active_count == 0,
            };

            if triggered {
                triggered_ids.push(rule.id.clone());
                actions.push(rule.action.clone());
            }
        }
        drop(rules);
        if let Ok(mut active) = self.active_rules.lock() {
            *active = triggered_ids;
        }
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
        let actions = sched.evaluate(1000, 5);
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
        let actions = sched.evaluate(1000, 0);
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
        let actions = sched.evaluate(1000, 0);
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
        let actions = sched.evaluate(1000, 3);
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
        let actions = sched.evaluate(3000, 1);
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
        let actions = sched.evaluate(6000, 1);
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
        let actions = sched.evaluate(0, 1);
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
        let actions = sched.evaluate(1000, 1);
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
        let actions = sched.evaluate(1000, 1);
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
        assert_eq!(sched.evaluate(1000, 0).len(), 1);
        sched.remove_rule("r1");
        assert!(sched.evaluate(1000, 0).is_empty());
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
        assert!(sched.evaluate(1000, 0).is_empty());
        assert_eq!(sched.evaluate(50, 1).len(), 1);
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
        sched.evaluate(3000, 0);
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
        let actions = sched.evaluate(3000, 0);
        assert_eq!(actions.len(), 2);
    }
}
