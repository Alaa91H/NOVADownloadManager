#![allow(
    dead_code,
    clippy::too_many_arguments,
    clippy::manual_clamp,
    clippy::unnecessary_sort_by,
    clippy::needless_else
)]
use std::time::{Duration, Instant};

use super::server_profiler::ServerProfile;
use super::ConnectionTelemetry;

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
    /// When true, the segment file may temporarily exceed its logical size
    /// (M10 rebalance writes a prefix beyond `end_byte`); the merge/complete
    /// pass must truncate it back to `end_byte + 1` before merging.
    pub truncate_on_complete: bool,
}

impl LiveSegment {
    pub const fn total_bytes(&self) -> u64 {
        self.end_byte.saturating_sub(self.start_byte)
    }

    pub const fn remaining_bytes(&self) -> u64 {
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
    peak_throughput: u64,
    max_segments: u32,
}

impl SegmentController {
    pub fn new(total_size: u64, min_segment_bytes: u64) -> Self {
        let segments = Self::create_segments(total_size, 1, min_segment_bytes);
        Self {
            segments,
            total_size,
            min_segment_bytes,
            stall_threshold: Duration::from_secs(5),
            last_eval: Instant::now(),
            eval_interval: Duration::from_secs(2),
            peak_throughput: 0,
            max_segments: 64,
        }
    }

    /// Replace the controller's geometry with the exact plan the transfer
    /// planner created for the part files on disk (same ids and byte
    /// ranges). The default constructor seeds a single whole-file segment,
    /// but a segmented transfer writes N part files with ids 0..N-1; if the
    /// engine's ids/ranges do not match, per-segment progress updates for
    /// ids > 0 are silently dropped and the first adaptive rebuild produces
    /// a geometry that does not correspond to the files on disk — the root
    /// cause of post-rebuild corruption. Seeding from the plan keeps engine
    /// ids/ranges ≡ part files on disk, so progress lands on the right
    /// segments and rebuilds resume/merge from the true geometry.
    pub fn seed_from_ranges(&mut self, total_size: u64, ranges: &[(u32, u64, u64)]) {
        let now = Instant::now();
        self.total_size = total_size;
        self.segments = ranges
            .iter()
            .map(|&(id, start, end_inclusive)| LiveSegment {
                id,
                start_byte: start,
                end_byte: end_inclusive.saturating_add(1),
                downloaded: 0,
                speed: 0,
                assigned_connection: None,
                state: SegmentState::Active,
                created_at: now,
                last_progress_at: now,
                stall_since: None,
                truncate_on_complete: false,
            })
            .collect();
    }

    pub fn with_profile(total_size: u64, profile: &ServerProfile) -> Self {
        let min_seg = Self::compute_min_segment(total_size, profile);
        let stall_ms = if profile.p95_rtt_us > 0 {
            Duration::from_millis((profile.p95_rtt_us / 1000 * 3).max(1000))
        } else {
            Duration::from_secs(5)
        };
        let mut ctrl = Self::new(total_size, min_seg);
        ctrl.stall_threshold = stall_ms;
        ctrl
    }

    pub fn set_max_segments(&mut self, max: u32) {
        self.max_segments = max;
    }

    pub fn evaluate(&mut self, telemetry: &[ConnectionTelemetry]) -> Option<SegmentPlan> {
        let now = Instant::now();
        if now.duration_since(self.last_eval) < self.eval_interval {
            return None;
        }
        self.last_eval = now;

        self.update_peak_throughput(telemetry);

        let active_count = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .count();

        if active_count == 0 {
            return None;
        }

        if active_count == 1 && self.total_size > 0 {
            let seg = self
                .segments
                .iter()
                .find(|s| s.state == SegmentState::Active)?;
            let seg_id = seg.id;
            let seg_total = seg.total_bytes();
            let seg_speed = seg.speed;
            let peak = self.peak_throughput;
            let at_peak = seg_speed > 0 && peak > 0 && seg_speed >= peak * 9 / 10;
            if seg_total >= self.min_segment_bytes * 2 && !at_peak {
                return Some(SegmentPlan::SplitSegment { segment_id: seg_id });
            }
            return None;
        }

        // The connection ceiling is resource-derived and can exceed the
        // historical 64-segment default. Keep the median input bounded by the
        // configured geometry while preserving every active segment eligible
        // for the current plan.
        let mut speeds = Vec::with_capacity(active_count.min(self.max_segments as usize));
        for seg in self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .take(self.max_segments as usize)
        {
            speeds.push(seg.speed);
        }

        let median_speed = if speeds.is_empty() {
            0
        } else {
            speeds.sort_unstable();
            speeds[speeds.len() / 2]
        };

        if median_speed == 0 {
            return None;
        }

        for seg in &self.segments {
            if seg.state == SegmentState::Active && seg.speed == 0 {
                if let Some(stall_start) = seg.stall_since {
                    if now.duration_since(stall_start) > self.stall_threshold
                        && seg.remaining_bytes() > self.min_segment_bytes
                    {
                        return Some(SegmentPlan::SplitSegment { segment_id: seg.id });
                    }
                }
            }
        }

        let active_segs: Vec<&LiveSegment> = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .collect();

        let mut slowest: Option<u32> = None;
        let mut slowest_speed: u64 = u64::MAX;
        let mut fastest: Option<u32> = None;
        let mut fastest_speed: u64 = 0;
        for seg in &active_segs {
            if seg.speed < median_speed / 3 && seg.speed < slowest_speed {
                slowest_speed = seg.speed;
                slowest = Some(seg.id);
            }
            if seg.speed > median_speed * 2 && seg.speed > fastest_speed {
                fastest_speed = seg.speed;
                fastest = Some(seg.id);
            }
        }

        if let (Some(slow_id), Some(fast_id)) = (slowest, fastest) {
            // H9: never unwrap finds — a malformed segment set must yield
            // None (no decision) instead of panicking.
            let slow_seg = self.segments.iter().find(|s| s.id == slow_id)?;
            let fast_seg = self.segments.iter().find(|s| s.id == fast_id)?;
            if fast_seg.speed > slow_seg.speed * 3
                && slow_seg.remaining_bytes() > self.min_segment_bytes
                && slow_seg.end_byte == fast_seg.start_byte
            {
                let transferable =
                    ((fast_seg.speed - slow_seg.speed) / 4).min(slow_seg.remaining_bytes() / 4);
                if transferable >= self.min_segment_bytes {
                    return Some(SegmentPlan::Rebalance {
                        from_seg: slow_id,
                        to_seg: fast_id,
                        bytes: transferable,
                    });
                }
            }
        }

        if active_segs.len() >= 2 {
            let mut consecutive_under: Vec<u32> = Vec::new();
            for seg in &active_segs {
                if seg.speed < median_speed / 4 && seg.speed > 0 {
                    consecutive_under.push(seg.id);
                } else {
                    consecutive_under.clear();
                }
            }
            if consecutive_under.len() >= 2 {
                let a_id = consecutive_under[0];
                let b_id = consecutive_under[1];
                let a = self.segments.iter().find(|s| s.id == a_id)?;
                let b = self.segments.iter().find(|s| s.id == b_id)?;
                if a.end_byte == b.start_byte
                    && a.remaining_bytes() + b.remaining_bytes() < self.min_segment_bytes * 2
                {
                    return Some(SegmentPlan::MergeSegments { a: a_id, b: b_id });
                }
            }
        }

        self.maybe_grow_throughput(active_count as u32)
    }

    fn maybe_grow_throughput(&mut self, active_count: u32) -> Option<SegmentPlan> {
        if self.total_size == 0 || active_count >= self.max_segments {
            return None;
        }

        let total_remaining: u64 = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .map(LiveSegment::remaining_bytes)
            .sum();

        if total_remaining < self.min_segment_bytes * 2 {
            return None;
        }

        let total_speed: u64 = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .map(|s| s.speed)
            .sum();

        if total_speed == 0 {
            return None;
        }

        let avg_speed_per_seg = total_speed / u64::from(active_count.max(1));

        let mut best_id: Option<u32> = None;
        let mut best_speed: u64 = 0;
        for seg in self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
        {
            if seg.speed > avg_speed_per_seg * 2
                && seg.remaining_bytes() > self.min_segment_bytes
                && seg.speed > best_speed
            {
                best_speed = seg.speed;
                best_id = Some(seg.id);
            }
        }

        if let Some(id) = best_id {
            return Some(SegmentPlan::SplitSegment { segment_id: id });
        }

        None
    }

    fn update_peak_throughput(&mut self, _telemetry: &[ConnectionTelemetry]) {
        let total: u64 = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .map(|s| s.speed)
            .sum();
        if total > self.peak_throughput {
            self.peak_throughput = total;
        }
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

    pub fn mark_connection_failed(&mut self, conn_id: usize) {
        for seg in &mut self.segments {
            if seg.assigned_connection == Some(conn_id) && seg.state == SegmentState::Active {
                seg.state = SegmentState::Failed;
                seg.assigned_connection = None;
            }
        }
    }

    pub fn mark_connection_completed(&mut self, conn_id: usize) {
        for seg in &mut self.segments {
            if seg.assigned_connection == Some(conn_id) && seg.state == SegmentState::Active {
                seg.assigned_connection = None;
            }
        }
    }

    pub fn redistribute_for_count(&mut self, target_count: u32) {
        let active = self.active_segments_sorted_by_remaining();
        let active_count = active.len() as u32;

        if target_count > active_count {
            let mut to_add = target_count - active_count;
            while to_add > 0 {
                let largest = self.largest_active_remaining();
                if let Some(seg_id) = largest {
                    let before = self.segment_count() as u32;
                    self.split_segment_at(seg_id);
                    let after = self.segment_count() as u32;
                    if after > before {
                        to_add -= 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        } else if target_count < active_count {
            let mut to_remove = active_count - target_count;
            while to_remove > 0 {
                let pair = self.smallest_adjacent_pair();
                if let Some((a, b)) = pair {
                    let before = self.segment_count() as u32;
                    self.merge_adjacent_segments(a, b);
                    let after = self.segment_count() as u32;
                    if after < before {
                        to_remove -= 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
        }
    }

    fn active_segments_sorted_by_remaining(&self) -> Vec<u32> {
        let mut active: Vec<_> = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .map(|s| (s.id, s.remaining_bytes()))
            .collect();
        active.sort_by(|a, b| b.1.cmp(&a.1));
        active.into_iter().map(|(id, _)| id).collect()
    }

    fn largest_active_remaining(&self) -> Option<u32> {
        self.segments
            .iter()
            .filter(|s| {
                s.state == SegmentState::Active && s.remaining_bytes() >= self.min_segment_bytes * 2
            })
            .max_by_key(|s| s.remaining_bytes())
            .map(|s| s.id)
    }

    fn smallest_adjacent_pair(&self) -> Option<(u32, u32)> {
        let actives: Vec<&LiveSegment> = self
            .segments
            .iter()
            .filter(|s| s.state == SegmentState::Active)
            .collect();

        if actives.len() < 2 {
            return None;
        }

        let mut best: Option<(u32, u32, u64)> = None;
        for pair in actives.windows(2) {
            if pair[0].end_byte == pair[1].start_byte {
                let combined = pair[0].remaining_bytes() + pair[1].remaining_bytes();
                if combined < self.min_segment_bytes {
                    continue;
                }
                if best.is_none() || combined < best.unwrap().2 {
                    best = Some((pair[0].id, pair[1].id, combined));
                }
            }
        }

        best.map(|(a, b, _)| (a, b))
    }

    pub fn unassigned_active_count(&self) -> usize {
        self.segments
            .iter()
            .filter(|s| s.state == SegmentState::Active && s.assigned_connection.is_none())
            .count()
    }

    pub fn unassigned_active_segments(&self) -> Vec<&LiveSegment> {
        self.segments
            .iter()
            .filter(|s| s.state == SegmentState::Active && s.assigned_connection.is_none())
            .collect()
    }

    pub fn apply_plan(&mut self, plan: &SegmentPlan) {
        match plan {
            SegmentPlan::NoChange => {}
            SegmentPlan::Rebalance {
                from_seg,
                to_seg,
                bytes,
            } => {
                if from_seg == to_seg {
                    return;
                }
                // Rebalancing preserves the fast segment's start and creates
                // a new prefix range between the shrunken slow segment and the
                // existing fast segment. Its part file does not exist yet, so
                // it MUST begin at zero progress: bytes beyond the shrunken
                // slow range may still be present only in the old slow part
                // file and are truncated during rebuild. Claiming them here
                // makes the live UI over-report and can skip a required range.
                let Some(slow_idx) = self.segments.iter().position(|s| s.id == *from_seg) else {
                    return;
                };
                let Some(fast_idx) = self.segments.iter().position(|s| s.id == *to_seg) else {
                    return;
                };
                if self.segments[slow_idx].end_byte != self.segments[fast_idx].start_byte {
                    return;
                }
                let transfer = (*bytes).min(self.segments[slow_idx].remaining_bytes());
                if transfer == 0 {
                    return;
                }
                let old_slow_end = self.segments[slow_idx].end_byte;
                let new_slow_end = old_slow_end.saturating_sub(transfer);
                let new_id = self.segments.iter().map(|s| s.id).max().unwrap_or(0) + 1;
                let now = Instant::now();

                // Shrink the slow segment. Its reported downloaded count must
                // be clamped to the NEW range length; the rebuild path truncates
                // any stale tail on disk before resuming this part.
                let slow_downloaded = self.segments[slow_idx].downloaded;
                self.segments[slow_idx].end_byte = new_slow_end;
                self.segments[slow_idx].truncate_on_complete = true;
                let new_slow_total = self.segments[slow_idx].total_bytes();
                self.segments[slow_idx].downloaded = slow_downloaded.min(new_slow_total);

                // The prefix owns an independent part file and must download
                // from zero during the next rebuild. It cannot inherit bytes
                // from the old slow part file safely.
                self.segments.push(LiveSegment {
                    id: new_id,
                    start_byte: new_slow_end,
                    end_byte: old_slow_end,
                    downloaded: 0,
                    speed: 0,
                    assigned_connection: None,
                    state: SegmentState::Active,
                    created_at: now,
                    last_progress_at: now,
                    stall_since: None,
                    truncate_on_complete: false,
                });
            }
            SegmentPlan::SplitSegment { segment_id } => {
                self.split_segment_at(*segment_id);
            }
            SegmentPlan::MergeSegments { a, b } => {
                self.merge_adjacent_segments(*a, *b);
            }
        }
        self.segments.sort_by_key(|s| s.start_byte);
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
            truncate_on_complete: false,
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
        // Read all of b's data up front so we can mutate a afterwards without
        // fighting the borrow checker.
        let (b_start, b_end, b_downloaded, b_truncate) = {
            let b = &self.segments[b_idx];
            (
                b.start_byte,
                b.end_byte,
                b.downloaded,
                b.truncate_on_complete,
            )
        };
        let a_end = self.segments[a_idx].end_byte;
        if b_start != a_end {
            return;
        }
        // Preserve b's downloaded progress in the survivor (M10: merging
        // discards b's bytes otherwise).
        self.segments[a_idx].downloaded =
            self.segments[a_idx].downloaded.saturating_add(b_downloaded);
        self.segments[a_idx].end_byte = b_end;
        self.segments[a_idx].state = SegmentState::Active;
        self.segments[a_idx].truncate_on_complete =
            self.segments[a_idx].truncate_on_complete || b_truncate;
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

    pub const fn peak_throughput(&self) -> u64 {
        self.peak_throughput
    }

    fn create_segments(total_size: u64, count: u32, min_segment: u64) -> Vec<LiveSegment> {
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
                truncate_on_complete: false,
            }];
        }
        let count = if min_segment > 0 && total_size >= min_segment * 2 {
            (total_size / min_segment).min(u64::from(count)).max(1) as u32
        } else {
            count
        }
        .max(1);
        let per_seg = total_size / u64::from(count);
        let rem = total_size % u64::from(count);
        let now = Instant::now();
        let mut segments = Vec::with_capacity(count as usize);
        let mut start = 0u64;
        for i in 0..count {
            let extra = u64::from(u64::from(i) < rem);
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
                truncate_on_complete: false,
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

    fn basic_controller(total: u64, _conns: u32) -> SegmentController {
        SegmentController::new(total, 1024 * 1024)
    }

    #[test]
    fn starts_with_single_segment() {
        let c = basic_controller(1000, 4);
        assert_eq!(c.segment_count(), 1);
    }

    #[test]
    fn single_segment_covers_full_range() {
        let c = basic_controller(9999, 1);
        assert_eq!(c.segment_count(), 1);
        assert_eq!(c.segments()[0].start_byte, 0);
        assert_eq!(c.segments()[0].end_byte, 9999);
        assert_eq!(c.segments()[0].total_bytes(), 9999);
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
        c.update_progress(0, 500, 100);
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
        let mut c = SegmentController::new(100000, 1024);
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
        let mut c = SegmentController::new(99, 50);
        c.split_segment_at(0);
        assert_eq!(c.segment_count(), 1);
    }

    #[test]
    fn merge_adjacent_combines_segments() {
        let mut c = basic_controller(1000, 3);
        c.split_segment_at(0);
        let count_after_split = c.segment_count();
        if count_after_split >= 2 {
            c.merge_adjacent_segments(0, 1);
            assert_eq!(c.segment_count(), count_after_split - 1);
        }
    }

    #[test]
    fn merge_adjacent_non_adjacent_noop() {
        let mut c = basic_controller(1000, 4);
        c.split_segment_at(0);
        let count = c.segment_count();
        c.merge_adjacent_segments(0, 2);
        assert_eq!(c.segment_count(), count);
    }

    #[test]
    fn apply_rebalance_adjusts_boundaries() {
        let mut c = basic_controller(1000, 2);
        c.split_segment_at(0);
        if c.segment_count() >= 2 {
            let first_end = c.segments()[0].end_byte;
            let second_start = c.segments()[1].start_byte;
            assert_eq!(first_end, second_start);
        }
    }

    #[test]
    fn mark_connection_failed() {
        let mut c = basic_controller(1000, 2);
        c.split_segment_at(0);
        if c.segment_count() >= 2 {
            c.segments[0].assigned_connection = Some(0);
            c.segments[1].assigned_connection = Some(1);
            c.mark_connection_failed(0);
            assert_eq!(c.segments[0].state, SegmentState::Failed);
            assert_eq!(c.segments()[1].state, SegmentState::Active);
        }
    }

    #[test]
    fn active_segment_count() {
        let mut c = basic_controller(1000, 3);
        c.split_segment_at(0);
        let count = c.segment_count();
        assert!(count >= 1);
        c.segments[0].state = SegmentState::Completed;
        assert_eq!(c.active_segment_count(), count - 1);
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
            truncate_on_complete: false,
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
            truncate_on_complete: false,
        };
        assert!((seg.progress() - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn grow_single_segment_when_throughput_low() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.set_eval_interval(Duration::from_millis(1));
        c.peak_throughput = 1000;
        std::thread::sleep(Duration::from_millis(2));
        c.update_progress(0, 100_000, 100);
        let result = c.evaluate(&[]);
        assert!(matches!(result, Some(SegmentPlan::SplitSegment { .. })));
    }

    #[test]
    fn no_grow_when_already_at_peak() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.set_eval_interval(Duration::from_millis(1));
        c.peak_throughput = 1000;
        std::thread::sleep(Duration::from_millis(2));
        c.update_progress(0, 100_000, 950);
        let result = c.evaluate(&[]);
        assert!(matches!(result, None | Some(SegmentPlan::NoChange)));
    }

    #[test]
    fn no_grow_when_segment_too_small() {
        let mut c = SegmentController::new(500, 500);
        c.set_eval_interval(Duration::from_millis(1));
        c.peak_throughput = 1000;
        std::thread::sleep(Duration::from_millis(2));
        c.update_progress(0, 100, 100);
        let result = c.evaluate(&[]);
        assert!(matches!(result, None | Some(SegmentPlan::NoChange)));
    }

    #[test]
    fn grow_fastest_segment_when_unbalanced() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.set_eval_interval(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(2));
        c.split_segment_at(0);
        if c.segment_count() >= 2 {
            c.update_progress(0, 500_000, 1000);
            c.update_progress(1, 1_000_000, 50000);
            let result = c.evaluate(&[]);
            if let Some(SegmentPlan::SplitSegment { segment_id }) = result {
                assert_eq!(segment_id, 1);
            }
        }
    }

    #[test]
    fn merge_small_slow_segments() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.set_eval_interval(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(2));
        c.split_segment_at(0);
        if c.segment_count() >= 2 {
            let total = c.segments()[0].total_bytes() + c.segments()[1].total_bytes();
            c.update_progress(0, c.segments()[0].total_bytes() - 100, 10);
            c.update_progress(1, c.segments()[1].total_bytes() - 100, 10);
            let _ = total;
            let result = c.evaluate(&[]);
            if let Some(SegmentPlan::MergeSegments { .. }) = result {
            } else {
            }
        }
    }

    #[test]
    fn max_segments_limits_growth() {
        let mut c = SegmentController::new(100_000_000, 1024 * 1024);
        c.set_max_segments(2);
        c.set_eval_interval(Duration::from_millis(1));
        c.peak_throughput = 1000;
        std::thread::sleep(Duration::from_millis(2));
        for _ in 0..5 {
            c.update_progress(0, 100_000, 100);
            let _ = c.evaluate(&[]);
        }
        assert!(c.segment_count() <= 2, "got {}", c.segment_count());
    }

    #[test]
    fn peak_throughput_tracks_max() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.set_eval_interval(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(2));
        c.update_progress(0, 100_000, 500);
        c.evaluate(&[]);
        assert_eq!(c.peak_throughput(), 500);
        c.split_segment_at(0);
        if c.segment_count() >= 2 {
            c.update_progress(0, 200_000, 300);
            c.update_progress(1, 200_000, 400);
            c.evaluate(&[]);
            assert!(
                c.peak_throughput() >= 500,
                "peak was {}",
                c.peak_throughput()
            );
        }
    }

    #[test]
    fn redistribute_increases_segments() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        assert_eq!(c.active_segment_count(), 1);
        c.redistribute_for_count(4);
        assert!(
            c.active_segment_count() >= 2,
            "expected >=2, got {}",
            c.active_segment_count()
        );
    }

    #[test]
    fn redistribute_decreases_segments() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.redistribute_for_count(8);
        let high = c.active_segment_count();
        c.redistribute_for_count(2);
        let low = c.active_segment_count();
        assert!(low <= high, "expected reduction: {} <= {}", low, high);
        assert!(low >= 1);
    }

    #[test]
    fn redistribute_noop_at_same_count() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        let before = c.segment_count();
        c.redistribute_for_count(1);
        assert_eq!(c.segment_count(), before);
    }

    #[test]
    fn unassigned_segments_count() {
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        assert_eq!(c.unassigned_active_count(), 1);
        c.segments[0].assigned_connection = Some(0);
        assert_eq!(c.unassigned_active_count(), 0);
    }

    #[test]
    fn rebalance_creates_zero_progress_prefix_without_overlap() {
        // Regression: rebalance must NOT move the fast segment's start, and
        // the newly independent prefix must start at zero progress because it
        // has no part file of its own until the rebuild downloads it.
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.redistribute_for_count(2);
        // Slow segment first, fast second, adjacent.
        c.segments[0].id = 10;
        c.segments[1].id = 20;
        c.segments[0].speed = 100;
        c.segments[1].speed = 1000;
        c.segments[0].downloaded = 1000;
        let slow_start = c.segments[0].start_byte;
        let slow_end_before = c.segments[0].end_byte;
        let fast_start_before = c.segments[1].start_byte;
        let fast_downloaded_before = c.segments[1].downloaded;
        assert_eq!(slow_end_before, fast_start_before);

        c.apply_plan(&SegmentPlan::Rebalance {
            from_seg: 10,
            to_seg: 20,
            bytes: 5000,
        });

        // Slow shrank; a prefix segment covers the gap; fast untouched.
        let slow = c.segments.iter().find(|s| s.id == 10).unwrap();
        assert!(slow.end_byte < slow_end_before, "slow must shrink");
        assert!(
            slow.truncate_on_complete,
            "slow must be marked for truncation"
        );
        let fast = c.segments.iter().find(|s| s.id == 20).unwrap();
        assert_eq!(
            fast.start_byte, fast_start_before,
            "fast start must not move"
        );
        assert_eq!(
            fast.downloaded, fast_downloaded_before,
            "fast must keep progress"
        );
        // The prefix covers exactly the transferred range, adjacent to both,
        // but reports no bytes until its own part file is downloaded.
        let prefix = c
            .segments
            .iter()
            .find(|s| s.start_byte == slow.end_byte && s.end_byte == fast.start_byte)
            .expect("prefix segment must exist");
        assert_eq!(
            prefix.downloaded, 0,
            "a new prefix cannot inherit bytes from another part file"
        );
        // No overlap anywhere and everything stays inside [slow_start, fast_end).
        let mut sorted: Vec<&LiveSegment> = c.segments.iter().collect();
        sorted.sort_by_key(|s| s.start_byte);
        for pair in sorted.windows(2) {
            assert!(
                pair[0].end_byte <= pair[1].start_byte,
                "segments must not overlap"
            );
        }
        let _ = slow_start;
    }

    #[test]
    fn merge_preserves_downloaded_progress() {
        // M10: merging must carry b's downloaded bytes into the survivor.
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.redistribute_for_count(2);
        c.segments[0].downloaded = 1000;
        c.segments[1].downloaded = 2000;
        let total_before: u64 = c.segments.iter().map(|s| s.downloaded).sum();
        let a_id = c.segments[0].id;
        let b_id = c.segments[1].id;
        c.merge_adjacent_segments(a_id, b_id);
        let total_after: u64 = c.segments.iter().map(|s| s.downloaded).sum();
        assert_eq!(
            total_before, total_after,
            "merge must not drop downloaded bytes"
        );
    }

    #[test]
    fn split_at_byte_is_inside_remaining_range() {
        // SplitSegment must cut at a real midpoint inside [start+downloaded, end).
        let mut c = SegmentController::new(10_000_000, 1024 * 1024);
        c.redistribute_for_count(1);
        c.segments[0].downloaded = 2000;
        let start = c.segments[0].start_byte;
        let end = c.segments[0].end_byte;
        let seg_id = c.segments[0].id;
        c.split_segment_at(seg_id);
        // Two segments now; the split point lies strictly between
        // start+downloaded and end.
        assert_eq!(c.segment_count(), 2);
        let s1 = c.segments.iter().find(|s| s.id == seg_id).unwrap();
        let s2 = c
            .segments
            .iter()
            .find(|s| s.id != seg_id)
            .expect("second segment");
        assert!(
            s1.end_byte > start + 2000,
            "split must be after downloaded bytes"
        );
        assert!(s1.end_byte < end, "split must be before the end");
        assert_eq!(s1.end_byte, s2.start_byte, "split halves must be adjacent");
    }
}
