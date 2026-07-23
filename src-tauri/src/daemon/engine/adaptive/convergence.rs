use std::collections::VecDeque;
use std::time::{Duration, Instant};

use super::AdaptiveThresholds;

#[derive(Clone, Debug)]
struct SpeedSample {
    timestamp: Instant,
    aggregate_speed: u64,
    connection_count: u32,
}

pub struct ConvergenceDetector {
    history: VecDeque<SpeedSample>,
    last_adjustment: Instant,
    adjustments_in_window: u32,
    window_start: Instant,
    consecutive_no_improvement: u32,
    cooldown_until: Option<Instant>,
}

impl ConvergenceDetector {
    pub fn new() -> Self {
        Self {
            history: VecDeque::with_capacity(60),
            last_adjustment: Instant::now() - Duration::from_secs(60),
            adjustments_in_window: 0,
            window_start: Instant::now(),
            consecutive_no_improvement: 0,
            cooldown_until: None,
        }
    }

    pub fn should_adjust(&self, thresholds: &AdaptiveThresholds) -> bool {
        if let Some(cooldown) = self.cooldown_until {
            if Instant::now() < cooldown {
                return false;
            }
        }
        if self.last_adjustment.elapsed()
            < Duration::from_millis(thresholds.eval_interval_ms)
        {
            return false;
        }
        if self.adjustments_in_window >= thresholds.max_adjustments_per_minute {
            return false;
        }
        true
    }

    pub fn record_speed(&mut self, speed: u64, connections: u32) {
        self.history.push_back(SpeedSample {
            timestamp: Instant::now(),
            aggregate_speed: speed,
            connection_count: connections,
        });
        if self.history.len() > 60 {
            self.history.pop_front();
        }
    }

    pub fn record_adjustment(&mut self, speed_after: u64) {
        self.last_adjustment = Instant::now();
        self.adjustments_in_window += 1;

        if self.window_start.elapsed() > Duration::from_secs(60) {
            self.adjustments_in_window = 1;
            self.window_start = Instant::now();
        }

        let ratio = self.improvement_ratio(8);
        if ratio < 1.05 {
            self.consecutive_no_improvement += 1;
        } else {
            self.consecutive_no_improvement = 0;
        }

        if self.consecutive_no_improvement >= 3 {
            self.cooldown_until = Some(Instant::now() + Duration::from_secs(30));
            self.consecutive_no_improvement = 0;
        } else if self.consecutive_no_improvement >= 2 && self.last_adjustment.elapsed() < Duration::from_secs(5) {
            let double_interval = Duration::from_secs(10);
            self.cooldown_until = Some(Instant::now() + double_interval);
        }

        self.history.push_back(SpeedSample {
            timestamp: Instant::now(),
            aggregate_speed: speed_after,
            connection_count: 0,
        });
    }

    pub fn improvement_ratio(&self, window: usize) -> f32 {
        if self.history.len() < 2 {
            return 1.0;
        }
        let len = self.history.len();
        let before_start = len.saturating_sub(window * 2);
        let before_end = len.saturating_sub(window);
        let after_start = len.saturating_sub(window);

        let before: Vec<u64> = self.history
            .range(before_start..before_end)
            .map(|s| s.aggregate_speed)
            .collect();
        let after: Vec<u64> = self.history
            .range(after_start..)
            .map(|s| s.aggregate_speed)
            .collect();

        if before.is_empty() || after.is_empty() {
            return 1.0;
        }

        let avg_before: f64 = before.iter().sum::<u64>() as f64 / before.len() as f64;
        let avg_after: f64 = after.iter().sum::<u64>() as f64 / after.len() as f64;

        if avg_before == 0.0 {
            return if avg_after > 0.0 { 2.0 } else { 1.0 };
        }

        (avg_after / avg_before) as f32
    }

    pub fn diminishing_returns(&self) -> bool {
        if self.history.len() < 6 {
            return false;
        }
        let ratio = self.improvement_ratio(3);
        ratio < 1.05 && self.consecutive_no_improvement >= 1
    }

    pub fn current_speed(&self) -> u64 {
        self.history.back().map(|s| s.aggregate_speed).unwrap_or(0)
    }

    pub fn speed_trend(&self, window: usize) -> f32 {
        if self.history.len() < 2 {
            return 0.0;
        }
        let len = self.history.len();
        let start = len.saturating_sub(window);
        let samples: Vec<&SpeedSample> = self.history.range(start..).collect();
        if samples.len() < 2 {
            return 0.0;
        }
        let first = samples.first().unwrap().aggregate_speed as f64;
        let last = samples.last().unwrap().aggregate_speed as f64;
        if first == 0.0 {
            return if last > 0.0 { 1.0 } else { 0.0 };
        }
        ((last - first) / first) as f32
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.last_adjustment = Instant::now();
        self.adjustments_in_window = 0;
        self.window_start = Instant::now();
        self.consecutive_no_improvement = 0;
        self.cooldown_until = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_thresholds() -> AdaptiveThresholds {
        AdaptiveThresholds {
            eval_interval_ms: 1,
            max_adjustments_per_minute: 100,
            ..Default::default()
        }
    }

    #[test]
    fn should_adjust_initially_true() {
        let c = ConvergenceDetector::new();
        assert!(c.should_adjust(&fast_thresholds()));
    }

    #[test]
    fn should_adjust_respects_eval_interval() {
        let mut c = ConvergenceDetector::new();
        c.record_adjustment(1000);
        assert!(!c.should_adjust(&fast_thresholds()));
    }

    #[test]
    fn should_adjust_respects_max_per_minute() {
        let mut c = ConvergenceDetector::new();
        let t = AdaptiveThresholds {
            eval_interval_ms: 1,
            max_adjustments_per_minute: 2,
            ..Default::default()
        };
        c.record_adjustment(1000);
        std::thread::sleep(Duration::from_millis(2));
        c.record_adjustment(1000);
        std::thread::sleep(Duration::from_millis(2));
        assert!(!c.should_adjust(&t));
    }

    #[test]
    fn record_speed_stores_samples() {
        let mut c = ConvergenceDetector::new();
        c.record_speed(1000, 4);
        c.record_speed(2000, 4);
        assert_eq!(c.history.len(), 2);
        assert_eq!(c.current_speed(), 2000);
    }

    #[test]
    fn history_capped_at_60() {
        let mut c = ConvergenceDetector::new();
        for i in 0..80 {
            c.record_speed(i, 1);
        }
        assert_eq!(c.history.len(), 60);
    }

    #[test]
    fn improvement_ratio_empty_history() {
        let c = ConvergenceDetector::new();
        assert!((c.improvement_ratio(8) - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn improvement_ratio_with_data() {
        let mut c = ConvergenceDetector::new();
        for _ in 0..5 {
            c.record_speed(100, 1);
        }
        for _ in 0..5 {
            c.record_speed(200, 1);
        }
        let ratio = c.improvement_ratio(5);
        assert!(ratio > 1.5);
    }

    #[test]
    fn speed_trend_empty() {
        let c = ConvergenceDetector::new();
        assert!((c.speed_trend(10)).abs() < f32::EPSILON);
    }

    #[test]
    fn speed_trend_positive() {
        let mut c = ConvergenceDetector::new();
        c.record_speed(100, 1);
        c.record_speed(200, 1);
        c.record_speed(300, 1);
        let trend = c.speed_trend(3);
        assert!(trend > 1.0);
    }

    #[test]
    fn diminishing_returns_false_initially() {
        let c = ConvergenceDetector::new();
        assert!(!c.diminishing_returns());
    }

    #[test]
    fn reset_clears_state() {
        let mut c = ConvergenceDetector::new();
        c.record_speed(100, 1);
        c.record_adjustment(100);
        c.reset();
        assert!(c.history.is_empty());
        assert_eq!(c.adjustments_in_window, 0);
        assert!(c.cooldown_until.is_none());
    }

    #[test]
    fn cooldown_after_consecutive_failures() {
        let mut c = ConvergenceDetector::new();
        for _ in 0..3 {
            c.consecutive_no_improvement += 1;
            c.record_adjustment(100);
        }
        assert!(c.cooldown_until.is_some());
    }
}
