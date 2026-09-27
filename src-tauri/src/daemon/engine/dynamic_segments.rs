use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct SegmentState {
    pub id: u32,
    pub start_byte: u64,
    pub end_byte: u64,
    pub downloaded: Arc<AtomicU64>,
    pub active: Arc<std::sync::atomic::AtomicBool>,
    pub speed: Arc<AtomicU64>,
}

impl SegmentState {
    pub fn new(id: u32, start_byte: u64, end_byte: u64) -> Self {
        Self {
            id,
            start_byte,
            end_byte,
            downloaded: Arc::new(AtomicU64::new(0)),
            active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            speed: Arc::new(AtomicU64::new(0)),
        }
    }

    pub const fn total_bytes(&self) -> u64 {
        self.end_byte.saturating_sub(self.start_byte)
    }

    pub fn progress(&self) -> f64 {
        let total = self.total_bytes();
        if total == 0 {
            return 1.0;
        }
        let downloaded = self.downloaded.load(Ordering::Relaxed).min(total);
        downloaded as f64 / total as f64
    }

    fn clamp_downloaded(&self, downloaded: u64) -> u64 {
        downloaded.min(self.total_bytes())
    }
}

#[derive(Clone)]
pub struct DynamicSegmentScheduler {
    segments: Arc<Mutex<Vec<SegmentState>>>,
    total_size: Arc<AtomicU64>,
}

impl DynamicSegmentScheduler {
    /// Create a scheduler that divides `total_size` into `initial_connections`
    /// segments.  `max_segments` is reserved for future dynamic rebalancing
    /// and is currently unused.
    pub fn new(total_size: u64, initial_connections: u32, _max_segments: u32) -> Self {
        let segments = Self::create_segments(total_size, initial_connections);
        Self {
            segments: Arc::new(Mutex::new(segments)),
            total_size: Arc::new(AtomicU64::new(total_size)),
        }
    }

    fn create_segments(total_size: u64, connections: u32) -> Vec<SegmentState> {
        if total_size == 0 {
            return vec![SegmentState::new(0, 0, 0)];
        }
        // There cannot be more non-empty byte ranges than bytes. Capping the
        // connection count prevents zero-length active segments for tiny files.
        let conns = connections
            .max(1)
            .min(total_size.min(u64::from(u32::MAX)) as u32);
        let per_seg = total_size / u64::from(conns);
        let mut segs = Vec::with_capacity(conns as usize);
        for i in 0..conns {
            let start = u64::from(i) * per_seg;
            let end = if i == conns - 1 {
                total_size
            } else {
                start + per_seg
            };
            segs.push(SegmentState::new(i, start, end));
        }
        segs
    }

    pub fn update_segment(&self, id: u32, downloaded: u64, speed: u64, active: bool) {
        if let Ok(segments) = self.segments.lock() {
            if let Some(seg) = segments.iter().find(|s| s.id == id) {
                seg.downloaded
                    .store(seg.clamp_downloaded(downloaded), Ordering::Relaxed);
                seg.speed.store(speed, Ordering::Relaxed);
                seg.active.store(active, Ordering::Relaxed);
            }
        }
    }

    /// Replace the entire segment geometry with the adaptive engine's current
    /// view (phase 5). Keeps per-segment downloaded/speed when an id matches.
    pub fn replace_segments(&self, segments: &[(u32, u64, u64, u64, u64, bool)]) {
        if let Ok(mut current) = self.segments.lock() {
            let mut next: Vec<SegmentState> = segments
                .iter()
                .map(|(id, start, end, downloaded, speed, active)| {
                    let state = SegmentState::new(*id, *start, *end);
                    state
                        .downloaded
                        .store(state.clamp_downloaded(*downloaded), Ordering::Relaxed);
                    state.speed.store(*speed, Ordering::Relaxed);
                    state.active.store(*active, Ordering::Relaxed);
                    state
                })
                .collect();
            // Preserve a concurrent live update only when the segment's
            // geometry is unchanged. Reusing a byte count after a split or
            // rebalance can report bytes that do not exist in the new range.
            for state in next.iter_mut() {
                if let Some(old) = current.iter().find(|s| {
                    s.id == state.id
                        && s.start_byte == state.start_byte
                        && s.end_byte == state.end_byte
                }) {
                    state.downloaded.store(
                        state.clamp_downloaded(old.downloaded.load(Ordering::Relaxed)),
                        Ordering::Relaxed,
                    );
                    state
                        .speed
                        .store(old.speed.load(Ordering::Relaxed), Ordering::Relaxed);
                    state
                        .active
                        .store(old.active.load(Ordering::Relaxed), Ordering::Relaxed);
                }
            }
            *current = next;
        }
    }

    pub fn segments(&self) -> Vec<SegmentSnapshot> {
        self.segments
            .lock()
            .map(|segs| {
                segs.iter()
                    .map(|s| SegmentSnapshot {
                        id: s.id,
                        start_byte: s.start_byte,
                        end_byte: s.end_byte,
                        downloaded: s.downloaded.load(Ordering::Relaxed),
                        total_bytes: s.total_bytes(),
                        active: s.active.load(Ordering::Relaxed),
                        speed: s.speed.load(Ordering::Relaxed),
                        progress: s.progress(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn total_progress(&self) -> f64 {
        let total = self.total_size.load(Ordering::Relaxed);
        if total == 0 {
            return 1.0;
        }
        let downloaded = self.segments.lock().map_or(0, |segs| {
            segs.iter().fold(0u64, |sum, segment| {
                sum.saturating_add(
                    segment
                        .downloaded
                        .load(Ordering::Relaxed)
                        .min(segment.total_bytes()),
                )
            })
        });
        downloaded.min(total) as f64 / total as f64
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SegmentSnapshot {
    pub id: u32,
    pub start_byte: u64,
    pub end_byte: u64,
    pub downloaded: u64,
    pub total_bytes: u64,
    pub active: bool,
    pub speed: u64,
    pub progress: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_correct_number_of_segments() {
        let sched = DynamicSegmentScheduler::new(1000, 4, 8);
        let segs = sched.segments();
        assert_eq!(segs.len(), 4);
    }

    #[test]
    fn new_segments_cover_full_range() {
        let sched = DynamicSegmentScheduler::new(1000, 4, 8);
        let segs = sched.segments();
        assert_eq!(segs[0].start_byte, 0);
        assert_eq!(segs.last().unwrap().end_byte, 1000);
    }

    #[test]
    fn segments_are_contiguous() {
        let sched = DynamicSegmentScheduler::new(1000, 4, 8);
        let segs = sched.segments();
        for window in segs.windows(2) {
            assert_eq!(window[0].end_byte, window[1].start_byte);
        }
    }

    #[test]
    fn new_zero_size_with_one_connection() {
        let sched = DynamicSegmentScheduler::new(0, 1, 1);
        let segs = sched.segments();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start_byte, 0);
        assert_eq!(segs[0].end_byte, 0);
        assert_eq!(segs[0].progress, 1.0);
    }

    #[test]
    fn segment_state_total_bytes() {
        let seg = SegmentState::new(0, 100, 350);
        assert_eq!(seg.total_bytes(), 250);
    }

    #[test]
    fn segment_state_zero_size_progress_is_one() {
        let seg = SegmentState::new(0, 0, 0);
        assert_eq!(seg.progress(), 1.0);
    }

    #[test]
    fn segment_state_progress_ratio() {
        let seg = SegmentState::new(0, 0, 100);
        seg.downloaded.store(50, Ordering::Relaxed);
        assert!((seg.progress() - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn update_segment_modifies_state() {
        let sched = DynamicSegmentScheduler::new(1000, 2, 4);
        sched.update_segment(0, 300, 1024, false);
        let segs = sched.segments();
        let s0 = &segs[0];
        assert_eq!(s0.downloaded, 300);
        assert_eq!(s0.speed, 1024);
        assert!(!s0.active);
    }

    #[test]
    fn progress_is_clamped_to_segment_and_file_bounds() {
        let sched = DynamicSegmentScheduler::new(1000, 2, 4);
        sched.update_segment(0, 9_999, 0, true);
        sched.update_segment(1, 9_999, 0, true);

        let segments = sched.segments();
        assert_eq!(segments[0].downloaded, 500);
        assert_eq!(segments[1].downloaded, 500);
        assert_eq!(segments[0].progress, 1.0);
        assert_eq!(sched.total_progress(), 1.0);
    }

    #[test]
    fn tiny_files_do_not_create_empty_active_segments() {
        let sched = DynamicSegmentScheduler::new(2, 8, 8);
        let segments = sched.segments();
        assert_eq!(segments.len(), 2);
        assert!(segments.iter().all(|segment| segment.total_bytes > 0));
    }

    #[test]
    fn reshaping_a_segment_does_not_reuse_stale_downloaded_bytes() {
        let sched = DynamicSegmentScheduler::new(1000, 2, 4);
        sched.update_segment(0, 500, 123, true);

        // Segment zero is replaced with a different 250-byte range. Its
        // supplied persisted count must win; the old 500-byte count belongs
        // to the previous geometry and must not inflate progress.
        sched.replace_segments(&[(0, 0, 250, 0, 0, true), (1, 250, 1000, 0, 0, true)]);
        let segments = sched.segments();
        assert_eq!(segments[0].downloaded, 0);
        assert_eq!(segments[0].speed, 0);
        assert_eq!(sched.total_progress(), 0.0);
    }

    #[test]
    fn total_progress_aggregates() {
        let sched = DynamicSegmentScheduler::new(1000, 2, 4);
        sched.update_segment(0, 300, 0, true);
        sched.update_segment(1, 200, 0, true);
        let p = sched.total_progress();
        assert!((p - 0.5).abs() < 1e-10);
    }

    #[test]
    fn total_progress_zero_size_is_one() {
        let sched = DynamicSegmentScheduler::new(0, 1, 1);
        assert_eq!(sched.total_progress(), 1.0);
    }

    #[test]
    fn segments_snapshots_match_state() {
        let sched = DynamicSegmentScheduler::new(500, 1, 2);
        sched.update_segment(0, 123, 55, true);
        let segs = sched.segments();
        let s = &segs[0];
        assert_eq!(s.id, 0);
        assert_eq!(s.start_byte, 0);
        assert_eq!(s.end_byte, 500);
        assert_eq!(s.downloaded, 123);
        assert_eq!(s.total_bytes, 500);
        assert_eq!(s.speed, 55);
        assert!(s.active);
        assert!((s.progress - 123.0 / 500.0).abs() < 1e-10);
    }

    #[test]
    fn single_connection_covers_entire_range() {
        let sched = DynamicSegmentScheduler::new(9999, 1, 10);
        let segs = sched.segments();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start_byte, 0);
        assert_eq!(segs[0].end_byte, 9999);
    }
}
