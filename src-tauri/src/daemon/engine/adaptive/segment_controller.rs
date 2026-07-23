use std::time::{Duration, Instant};

use super::ConnectionTelemetry;
use super::server_profiler::ServerProfile;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SegmentState {
    Active,
    Stalled,
    Completed,
    Failed,
}

#[derive(Clone, Debug)]
pub struct LiveSegment {
    pub id: u32,
    pub start_byte: u64,
    pub end_byte: u64,
    pub downloaded: u64,
    pub speed: u64,
    pub assigned_connection: Option<usize>,
    pub state: SegmentState,
    pub created_at: Instant,
    pub last_progress_at: Instant,
    pub stall_since: Option<Instant>,
}

impl LiveSegment {
    pub fn total_bytes(&self) -> u64 {
        self.end_byte.saturating_sub(self.start_byte)
    }

    pub fn remaining_bytes(&self) -> u64 {
        self.total_bytes().saturating_sub(self.downloaded)
    }

    pub fn progress(&self) -> f64 {
        let total = self.total_bytes();
        if total == 0 {
            return 1.0;
        }
        self.downloaded as f64 / total as f64
    }
}

#[derive(Clone, Debug)]
pub enum SegmentPlan {
    NoChange,
    Rebalance {
        from_seg: u32,
        to_seg: u32,
        bytes: u64,
    },
    SplitSegment {
        segment_id: u32,
    },
    MergeSegments {
        a: u32,
        b: u32,
    },
}

pub struct SegmentController {
    segments: Vec<LiveSegment>,
    total_size: u64,
    min_segment_bytes: u64,
    stall_threshold: Duration,
    last_eval: Instant,
    eval_interval: Duration,
}

impl SegmentController {
    pub fn new(total_size: u64, connections: u32, min_segment_bytes: u64) -> Self {
        let segments = Self::create_segments(total_size, connections, min_segment_bytes);
        Self {
            segments,
            total_size,
            min_segment_bytes,
            stall_threshold: Duration::from_secs(5),
            last_eval: Instant::now(),
            eval_interval: Duration::from_millis(2000),
        }
    }

    pub fn with_profile(total_size: u64, connections: u32, profile: &ServerProfile) -> Self {
        let min_seg = Self::compute_min_segment(total_size, profile);
        let stall_ms = if profile.p95_rtt_us > 0 {
            Duration::from_millis((profile.p95_rtt_us / 1000 * 3).max(1000))
        } else {
            Duration::from_secs(5)
        };
        let mut ctrl = Self::new(total_size, connections, min_seg);
        ctrl.stall_threshold = stall_ms;
        ctrl
    }

    pub fn evaluate(&mut self, _telemetry: &[ConnectionTelemetry]) -> Option<SegmentPlan> {
        let now = Instant::now();
        if now.duration_since(self.last_eval) < self.eval_interval {
            return None;
        }
        self.last_eval = now;

        let active: Vec<&LiveSegment> = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .collect();

        if active.len() < 2 {
            return None;
        }

        let mut speeds: Vec<u64> = active.iter().map(|s| s.speed).collect();
        speeds.sort_unstable();
        let median_speed = speeds[speeds.len() / 2];

        if median_speed == 0 {
            return None;
        }

        for seg in &self.segments {
            if seg.state == SegmentState::Active && seg.speed == 0 {
                if let Some(stall_start) = seg.stall_since {
                    if now.duration_since(stall_start) > self.stall_threshold {
                        if seg.remaining_bytes() > self.min_segment_bytes {
                            return Some(SegmentPlan::SplitSegment { segment_id: seg.id });
                        }
                    }
                }
            }
        }

        let mut slowest: Option<&LiveSegment> = None;
        let mut fastest: Option<&LiveSegment> = None;
        for seg in &active {
            if seg.speed < median_speed / 3 {
                if slowest.is_none() || seg.speed < slowest.unwrap().speed {
                    slowest = Some(seg);
                }
            }
            if seg.speed > median_speed * 2 {
                if fastest.is_none() || seg.speed > fastest.unwrap().speed {
                    fastest = Some(seg);
                }
            }
        }

        if let (Some(slow), Some(fast)) = (slowest, fastest) {
            if fast.speed > slow.speed * 3 && slow.remaining_bytes() > self.min_segment_bytes {
                let transferable = ((fast.speed - slow.speed) / 4).min(slow.remaining_bytes() / 4);
                if transferable >= self.min_segment_bytes {
                    return Some(SegmentPlan::Rebalance {
                        from_seg: slow.id,
                        to_seg: fast.id,
                        bytes: transferable,
                    });
                }
            }
        }

        if active.len() >= 2 {
            let mut consecutive_under = Vec::new();
            for seg in &active {
                if seg.speed < median_speed / 4 && seg.speed > 0 {
                    consecutive_under.push(seg);
                } else {
                    consecutive_under.clear();
                }
            }
            if consecutive_under.len() >= 2 {
                let a = consecutive_under[0];
                let b = consecutive_under[1];
                if a.id + 1 == b.id && a.remaining_bytes() + b.remaining_bytes() < self.min_segment_bytes * 2 {
                    return Some(SegmentPlan::MergeSegments { a: a.id, b: b.id });
                }
            }
        }

        None
    }

    pub fn update_progress(&mut self, segment_id: u32, downloaded: u64, speed: u64) {
        if let Some(seg) = self.segments.iter_mut().find(|s| s.id == segment_id) {
            let prev_downloaded = seg.downloaded;
            seg.downloaded = downloaded;
            seg.speed = speed;
            seg.last_progress_at = Instant::now();

            if downloaded > prev_downloaded {
                seg.stall_since = None;
            } else if seg.stall_since.is_none() && speed == 0 {
                seg.stall_since = Some(Instant::now());
            }

            if seg.remaining_bytes() == 0 {
                seg.state = SegmentState::Completed;
            }
        }
    }

    pub fn mark_connection_failed(&mut self, conn_id: usize) -> Vec<SegmentPlan> {
        let plans = Vec::new();
        for seg in &mut self.segments {
            if seg.assigned_connection == Some(conn_id) && seg.state == SegmentState::Active {
                seg.state = SegmentState::Failed;
                seg.assigned_connection = None;
            }
        }
        plans
    }

    pub fn mark_connection_completed(&mut self, conn_id: usize) {
        for seg in &mut self.segments {
            if seg.assigned_connection == Some(conn_id) && seg.state == SegmentState::Active {
                seg.assigned_connection = None;
            }
        }
    }

    pub fn apply_plan(&mut self, plan: &SegmentPlan) {
        match plan {
            SegmentPlan::NoChange => {}
            SegmentPlan::Rebalance {
                from_seg,
                to_seg,
                bytes,
            } => {
                if let Some(slow) = self.segments.iter_mut().find(|s| s.id == *from_seg) {
                    slow.end_byte = slow.end_byte.saturating_sub(*bytes);
                }
                let new_start = self.segments.iter().find(|s| s.id == *from_seg).map(|s| s.end_byte);
                if let (Some(new_start), Some(fast)) = (new_start, self.segments.iter_mut().find(|s| s.id == *to_seg)) {
                    fast.start_byte = new_start;
                }
            }
            SegmentPlan::SplitSegment { segment_id } => {
                self.split_segment_at(*segment_id);
            }
            SegmentPlan::MergeSegments { a, b } => {
                self.merge_adjacent_segments(*a, *b);
            }
        }
    }

    fn split_segment_at(&mut self, seg_id: u32) {
        let idx = match self.segments.iter().position(|s| s.id == seg_id) {
            Some(i) => i,
            None => return,
        };
        let seg = &self.segments[idx];
        if seg.state != SegmentState::Active {
            return;
        }
        let remaining = seg.remaining_bytes();
        if remaining < self.min_segment_bytes * 2 {
            return;
        }
        let mid = seg.start_byte + seg.downloaded + remaining / 2;
        let old_end = seg.end_byte;
        let new_id = self.segments.iter().map(|s| s.id).max().unwrap_or(0) + 1;
        let now = Instant::now();

        self.segments[idx].end_byte = mid;
        let new_seg = LiveSegment {
            id: new_id,
            start_byte: mid,
            end_byte: old_end,
            downloaded: 0,
            speed: 0,
            assigned_connection: None,
            state: SegmentState::Active,
            created_at: now,
            last_progress_at: now,
            stall_since: None,
        };
        self.segments.push(new_seg);
    }

    fn merge_adjacent_segments(&mut self, a_id: u32, b_id: u32) {
        let a_idx = match self.segments.iter().position(|s| s.id == a_id) {
            Some(i) => i,
            None => return,
        };
        let b_idx = match self.segments.iter().position(|s| s.id == b_id) {
            Some(i) => i,
            None => return,
        };
        if a_idx >= b_idx {
            return;
        }
        let a_end = self.segments[a_idx].end_byte;
        let b = &self.segments[b_idx];
        if b.start_byte != a_end {
            return;
        }
        let b_end = b.end_byte;
        self.segments[a_idx].end_byte = b_end;
        self.segments[a_idx].state = SegmentState::Active;
        self.segments.remove(b_idx);
    }

    pub fn active_segment_count(&self) -> usize {
        self.segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .count()
    }

    pub fn total_progress(&self) -> f64 {
        if self.total_size == 0 {
            return 1.0;
        }
        let downloaded: u64 = self.segments.iter().map(|s| s.downloaded).sum();
        downloaded as f64 / self.total_size as f64
    }

    pub fn segment_count(&self) -> usize {
        self.segments.len()
    }

    pub fn segments(&self) -> &[LiveSegment] {
        &self.segments
    }

    fn create_segments(total_size: u64, connections: u32, min_segment: u64) -> Vec<LiveSegment> {
        if total_size == 0 {
            return vec![LiveSegment {
                id: 0,
                start_byte: 0,
                end_byte: 0,
                downloaded: 0,
                speed: 0,
                assigned_connection: None,
                state: SegmentState::Completed,
                created_at: Instant::now(),
                last_progress_at: Instant::now(),
                stall_since: None,
            }];
        }
        let count = if min_segment > 0 && total_size >= min_segment * 2 {
            (total_size / min_segment).min(connections as u64).max(1) as u32
        } else {
            connections
        }
        .max(1);
        let per_seg = total_size / count as u64;
        let rem = total_size % count as u64;
        let now = Instant::now();
        let mut segments = Vec::with_capacity(count as usize);
        let mut start = 0u64;
        for i in 0..count {
            let extra = if (i as u64) < rem { 1 } else { 0 };
            let len = per_seg + extra;
            let end = start + len;
            segments.push(LiveSegment {
                id: i,
                start_byte: start,
                end_byte: end,
                downloaded: 0,
                speed: 0,
                assigned_connection: None,
                state: SegmentState::Active,
                created_at: now,
                last_progress_at: now,
                stall_since: None,
            });
            start = end;
        }
        segments
    }

    fn compute_min_segment(total_size: u64, profile: &ServerProfile) -> u64 {
        let base = if profile.per_connection_ceiling > 0 {
            (profile.per_connection_ceiling / 4).max(256 * 1024)
        } else {
            1024 * 1024
        };
        let scaled = (total_size / 32).max(base);
        scaled.clamp(256 * 1024, 10 * 1024 * 1024)
    }

    pub fn set_stall_threshold(&mut self, threshold: Duration) {
        self.stall_threshold = threshold;
    }

    pub fn set_eval_interval(&mut self, interval: Duration) {
        self.eval_interval = interval;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic_controller(total: u64, conns: u32) -> SegmentController {
        SegmentController::new(total, conns, 1024 * 1024)
    }

    #[test]
    fn creates_correct_number_of_segments() {
        let c = basic_controller(1000, 4);
        assert_eq!(c.segment_count(), 4);
    }

    #[test]
    fn segments_cover_full_range() {
        let c = basic_controller(1000, 4);
        let segs = c.segments();
        assert_eq!(segs[0].start_byte, 0);
        assert_eq!(segs.last().unwrap().end_byte, 1000);
    }

    #[test]
    fn segments_are_contiguous() {
        let c = basic_controller(1000, 4);
        let segs = c.segments();
        for pair in segs.windows(2) {
            assert_eq!(pair[0].end_byte, pair[1].start_byte);
        }
    }

    #[test]
    fn total_progress_zero_size() {
        let c = basic_controller(0, 1);
        assert_eq!(c.total_progress(), 1.0);
    }

    #[test]
    fn total_progress_aggregates() {
        let mut c = basic_controller(1000, 2);
        c.update_progress(0, 300, 100);
        c.update_progress(1, 200, 100);
        assert!((c.total_progress() - 0.5).abs() < 1e-10);
    }

    #[test]
    fn update_progress_marks_completed() {
        let mut c = basic_controller(100, 1);
        c.update_progress(0, 100, 500);
        assert_eq!(c.segments()[0].state, SegmentState::Completed);
    }

    #[test]
    fn update_progress_tracks_stall() {
        let mut c = basic_controller(1000, 2);
        c.set_stall_threshold(Duration::from_millis(1));
        c.update_progress(0, 100, 100);
        std::thread::sleep(Duration::from_millis(5));
        c.update_progress(0, 100, 0);
        assert!(c.segments()[0].stall_since.is_some());
    }

    #[test]
    fn update_progress_clears_stall_on_progress() {
        let mut c = basic_controller(1000, 2);
        c.set_stall_threshold(Duration::from_millis(1));
        c.update_progress(0, 100, 100);
        std::thread::sleep(Duration::from_millis(5));
        c.update_progress(0, 100, 0);
        assert!(c.segments()[0].stall_since.is_some());
        c.update_progress(0, 200, 100);
        assert!(c.segments()[0].stall_since.is_none());
    }

    #[test]
    fn evaluate_returns_none_with_few_segments() {
        let mut c = basic_controller(1000, 1);
        c.set_eval_interval(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(2));
        let result = c.evaluate(&[]);
        assert!(matches!(result, None | Some(SegmentPlan::NoChange)));
    }

    #[test]
    fn evaluate_no_change_when_balanced() {
        let mut c = basic_controller(10000, 4);
        c.set_eval_interval(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(2));
        for seg in c.segments.iter_mut() {
            seg.speed = 1000;
            seg.downloaded = 500;
        }
        let result = c.evaluate(&[]);
        assert!(matches!(result, None | Some(SegmentPlan::NoChange)));
    }

    #[test]
    fn split_segment_creates_new_segment() {
        let mut c = SegmentController::new(100000, 1, 1024);
        c.set_stall_threshold(Duration::from_millis(1));
        c.update_progress(0, 100, 0);
        std::thread::sleep(Duration::from_millis(5));
        c.split_segment_at(0);
        assert_eq!(c.segment_count(), 2);
        assert_eq!(c.segments()[0].id, 0);
        assert_eq!(c.segments()[1].id, 1);
    }

    #[test]
    fn split_segment_no_change_when_too_small() {
        let mut c = SegmentController::new(99, 1, 50);
        c.split_segment_at(0);
        assert_eq!(c.segment_count(), 1);
    }

    #[test]
    fn merge_adjacent_combines_segments() {
        let mut c = basic_controller(1000, 3);
        let original_count = c.segment_count();
        c.merge_adjacent_segments(0, 1);
        assert_eq!(c.segment_count(), original_count - 1);
        let merged = &c.segments()[0];
        assert_eq!(merged.start_byte, 0);
        assert_eq!(merged.end_byte, 667);
        assert_eq!(merged.total_bytes(), 667);
    }

    #[test]
    fn merge_adjacent_non_adjacent_noop() {
        let mut c = basic_controller(1000, 4);
        let count = c.segment_count();
        c.merge_adjacent_segments(0, 2);
        assert_eq!(c.segment_count(), count);
    }

    #[test]
    fn apply_rebalance_adjusts_boundaries() {
        let mut c = basic_controller(1000, 2);
        c.apply_plan(&SegmentPlan::Rebalance {
            from_seg: 0,
            to_seg: 1,
            bytes: 100,
        });
        assert_eq!(c.segments()[0].start_byte, 0);
        assert_eq!(c.segments()[0].end_byte, 400);
        assert_eq!(c.segments()[1].start_byte, 400);
        assert_eq!(c.segments()[1].end_byte, 1000);
    }

    #[test]
    fn mark_connection_failed() {
        let mut c = basic_controller(1000, 2);
        c.segments[0].assigned_connection = Some(0);
        c.segments[1].assigned_connection = Some(1);
        c.mark_connection_failed(0);
        assert_eq!(c.segments[0].state, SegmentState::Failed);
        assert_eq!(c.segments()[1].state, SegmentState::Active);
    }

    #[test]
    fn active_segment_count() {
        let mut c = basic_controller(1000, 3);
        assert_eq!(c.active_segment_count(), 3);
        c.segments[0].state = SegmentState::Completed;
        assert_eq!(c.active_segment_count(), 2);
    }

    #[test]
    fn single_connection_covers_full_range() {
        let c = basic_controller(9999, 1);
        assert_eq!(c.segment_count(), 1);
        assert_eq!(c.segments()[0].start_byte, 0);
        assert_eq!(c.segments()[0].end_byte, 9999);
        assert_eq!(c.segments()[0].total_bytes(), 9999);
    }

    #[test]
    fn large_file_gets_many_segments() {
        let c = basic_controller(100 * 1024 * 1024, 8);
        assert_eq!(c.segment_count(), 8);
    }

    #[test]
    fn live_segment_total_and_remaining() {
        let seg = LiveSegment {
            id: 0,
            start_byte: 100,
            end_byte: 500,
            downloaded: 100,
            speed: 0,
            assigned_connection: None,
            state: SegmentState::Active,
            created_at: Instant::now(),
            last_progress_at: Instant::now(),
            stall_since: None,
        };
        assert_eq!(seg.total_bytes(), 400);
        assert_eq!(seg.remaining_bytes(), 300);
    }

    #[test]
    fn progress_ratio() {
        let seg = LiveSegment {
            id: 0,
            start_byte: 0,
            end_byte: 100,
            downloaded: 50,
            speed: 0,
            assigned_connection: None,
            state: SegmentState::Active,
            created_at: Instant::now(),
            last_progress_at: Instant::now(),
            stall_since: None,
        };
        assert!((seg.progress() - 0.5).abs() < f64::EPSILON);
    }
}
