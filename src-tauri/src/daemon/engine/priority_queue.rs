use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering as AtomicOrder};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
pub enum DownloadPriority {
    Critical = 0,
    High = 1,
    Normal = 2,
    Low = 3,
    Background = 4,
}

impl DownloadPriority {
    pub fn bandwidth_share(&self) -> f64 {
        match self {
            DownloadPriority::Critical => 0.30,
            DownloadPriority::High => 0.25,
            DownloadPriority::Normal => 0.20,
            DownloadPriority::Low => 0.15,
            DownloadPriority::Background => 0.10,
        }
    }

    pub fn from_u32(v: u32) -> Self {
        match v {
            0 => DownloadPriority::Critical,
            1 => DownloadPriority::High,
            3 => DownloadPriority::Low,
            4 => DownloadPriority::Background,
            _ => DownloadPriority::Normal,
        }
    }
}

#[derive(Clone, Debug)]
pub struct QueueEntry {
    pub task_id: String,
    pub priority: DownloadPriority,
    pub added_at: Instant,
    pub size_bytes: u64,
    pub bandwidth_kbps: Arc<AtomicU64>,
}

impl PartialEq for QueueEntry {
    fn eq(&self, other: &Self) -> bool {
        self.task_id == other.task_id
    }
}

impl Eq for QueueEntry {}

impl Ord for QueueEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.priority
            .cmp(&other.priority)
            .then_with(|| other.added_at.cmp(&self.added_at))
    }
}

impl PartialOrd for QueueEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone)]
pub struct PriorityBandwidthQueue {
    entries: Arc<Mutex<Vec<QueueEntry>>>,
    total_bandwidth_kbps: Arc<AtomicU64>,
    active_downloads: Arc<AtomicU32>,
}

impl PriorityBandwidthQueue {
    pub fn new(total_bandwidth_kbps: u64) -> Self {
        Self {
            entries: Arc::new(Mutex::new(Vec::new())),
            total_bandwidth_kbps: Arc::new(AtomicU64::new(total_bandwidth_kbps)),
            active_downloads: Arc::new(AtomicU32::new(0)),
        }
    }

    pub fn enqueue(&self, entry: QueueEntry) {
        if let Ok(mut entries) = self.entries.lock() {
            if !entries.iter().any(|e| e.task_id == entry.task_id) {
                entries.push(entry);
                entries.sort();
            }
        }
    }

    pub fn remove(&self, task_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|e| e.task_id != task_id);
        }
    }

    pub fn set_priority(&self, task_id: &str, priority: DownloadPriority) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.iter_mut().find(|e| e.task_id == task_id) {
                entry.priority = priority;
                entries.sort();
            }
        }
    }

    pub fn next_to_start(&self) -> Option<String> {
        let entries = self.entries.lock().ok()?;
        let active = self.active_downloads.load(AtomicOrder::Relaxed);
        let total_bw = self.total_bandwidth_kbps.load(AtomicOrder::Relaxed);
        let allocatable = Self::allocatable_bandwidth(total_bw, active);

        for entry in entries.iter() {
            let min_bw = Self::min_bandwidth_for_priority(&entry.priority, total_bw);
            if allocatable >= min_bw || active == 0 {
                return Some(entry.task_id.clone());
            }
        }
        None
    }

    pub fn start_download(&self, _task_id: &str) {
        self.active_downloads.fetch_add(1, AtomicOrder::Relaxed);
        self.reallocate();
    }

    pub fn stop_download(&self, task_id: &str) {
        let prev = self.active_downloads.load(AtomicOrder::Relaxed);
        if prev > 0 {
            self.active_downloads.fetch_sub(1, AtomicOrder::Relaxed);
        }
        self.remove(task_id);
        self.reallocate();
    }

    /// Update the known size of a queued or active download. Used when the
    /// fast path starts a download with size 0 and a background probe later
    /// discovers the real Content-Length.
    pub fn update_size(&self, task_id: &str, size_bytes: u64) {
        let mut entries = match self.entries.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        for entry in entries.iter_mut() {
            if entry.task_id == task_id {
                entry.size_bytes = size_bytes;
                break;
            }
        }
    }

    pub fn reallocate(&self) {
        let entries = match self.entries.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let total_bw = self.total_bandwidth_kbps.load(AtomicOrder::Relaxed);
        let active = self.active_downloads.load(AtomicOrder::Relaxed) as f64;
        if active == 0.0 {
            return;
        }

        let mut priority_counts: std::collections::HashMap<DownloadPriority, u32> =
            std::collections::HashMap::new();
        for entry in entries.iter() {
            *priority_counts.entry(entry.priority).or_insert(0) += 1;
        }

        for entry in entries.iter() {
            let share = entry.priority.bandwidth_share();
            let count = priority_counts.get(&entry.priority).copied().unwrap_or(1) as f64;
            let per_task = (total_bw as f64 * share / count) as u64;
            entry.bandwidth_kbps.store(per_task, AtomicOrder::Relaxed);
        }
    }

    fn allocatable_bandwidth(total_bw: u64, active: u32) -> u64 {
        if active == 0 {
            return total_bw;
        }
        total_bw / active.max(1) as u64
    }

    fn min_bandwidth_for_priority(priority: &DownloadPriority, total: u64) -> u64 {
        let min_share = match priority {
            DownloadPriority::Critical => 0.05,
            DownloadPriority::High => 0.05,
            DownloadPriority::Normal => 0.02,
            DownloadPriority::Low => 0.01,
            DownloadPriority::Background => 0.005,
        };
        (total as f64 * min_share) as u64
    }

    pub fn set_total_bandwidth(&self, kbps: u64) {
        self.total_bandwidth_kbps.store(kbps, AtomicOrder::Relaxed);
        self.reallocate();
    }

    pub fn total_bandwidth(&self) -> u64 {
        self.total_bandwidth_kbps.load(AtomicOrder::Relaxed)
    }

    pub fn entries(&self) -> Vec<QueueEntrySnapshot> {
        self.entries
            .lock()
            .map(|entries| {
                entries
                    .iter()
                    .enumerate()
                    .map(|(i, e)| QueueEntrySnapshot {
                        task_id: e.task_id.clone(),
                        priority: format!("{:?}", e.priority),
                        position: i as u32,
                        allocated_kbps: e.bandwidth_kbps.load(AtomicOrder::Relaxed),
                        size_bytes: e.size_bytes,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn active_count(&self) -> u32 {
        self.active_downloads.load(AtomicOrder::Relaxed)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct QueueEntrySnapshot {
    pub task_id: String,
    pub priority: String,
    pub position: u32,
    pub allocated_kbps: u64,
    pub size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn make_entry(task_id: &str, priority: DownloadPriority) -> QueueEntry {
        QueueEntry {
            task_id: task_id.to_string(),
            priority,
            added_at: Instant::now(),
            size_bytes: 1024 * 1024,
            bandwidth_kbps: Arc::new(AtomicU64::new(0)),
        }
    }

    #[test]
    fn priority_ordering() {
        assert!(DownloadPriority::Critical < DownloadPriority::High);
        assert!(DownloadPriority::High < DownloadPriority::Normal);
        assert!(DownloadPriority::Normal < DownloadPriority::Low);
        assert!(DownloadPriority::Low < DownloadPriority::Background);
    }

    #[test]
    fn priority_ordering_full_chain() {
        let all = [
            DownloadPriority::Critical,
            DownloadPriority::High,
            DownloadPriority::Normal,
            DownloadPriority::Low,
            DownloadPriority::Background,
        ];
        for pair in all.windows(2) {
            assert!(pair[0] < pair[1], "{:?} should be < {:?}", pair[0], pair[1]);
            assert!(pair[0] != pair[1]);
            assert!(pair[1] > pair[0]);
        }
    }

    #[test]
    fn from_u32_mapping() {
        assert_eq!(DownloadPriority::from_u32(0), DownloadPriority::Critical);
        assert_eq!(DownloadPriority::from_u32(1), DownloadPriority::High);
        assert_eq!(DownloadPriority::from_u32(2), DownloadPriority::Normal);
        assert_eq!(DownloadPriority::from_u32(3), DownloadPriority::Low);
        assert_eq!(DownloadPriority::from_u32(4), DownloadPriority::Background);
    }

    #[test]
    fn from_u32_out_of_range_defaults_to_normal() {
        for v in [5, 10, 100, u32::MAX] {
            assert_eq!(DownloadPriority::from_u32(v), DownloadPriority::Normal);
        }
    }

    #[test]
    fn bandwidth_share_sum() {
        let sum: f64 = [
            DownloadPriority::Critical,
            DownloadPriority::High,
            DownloadPriority::Normal,
            DownloadPriority::Low,
            DownloadPriority::Background,
        ]
        .iter()
        .map(|p| p.bandwidth_share())
        .sum();
        assert!((sum - 1.0).abs() < f64::EPSILON, "sum was {sum}");
    }

    #[test]
    fn bandwidth_share_values() {
        assert_eq!(DownloadPriority::Critical.bandwidth_share(), 0.30);
        assert_eq!(DownloadPriority::High.bandwidth_share(), 0.25);
        assert_eq!(DownloadPriority::Normal.bandwidth_share(), 0.20);
        assert_eq!(DownloadPriority::Low.bandwidth_share(), 0.15);
        assert_eq!(DownloadPriority::Background.bandwidth_share(), 0.10);
    }

    #[test]
    fn enqueue_adds_entry() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        assert_eq!(q.entries().len(), 1);
        assert_eq!(q.entries()[0].task_id, "a");
    }

    #[test]
    fn enqueue_ignores_duplicate() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.enqueue(make_entry("a", DownloadPriority::High));
        assert_eq!(q.entries().len(), 1);
        assert_eq!(q.entries()[0].priority, "Normal");
    }

    #[test]
    fn enqueue_sorts_by_priority() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("low", DownloadPriority::Low));
        q.enqueue(make_entry("crit", DownloadPriority::Critical));
        q.enqueue(make_entry("high", DownloadPriority::High));

        let entries = q.entries();
        assert_eq!(entries[0].task_id, "crit");
        assert_eq!(entries[1].task_id, "high");
        assert_eq!(entries[2].task_id, "low");
    }

    #[test]
    fn remove_entry() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.enqueue(make_entry("b", DownloadPriority::High));
        q.remove("a");
        let entries = q.entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].task_id, "b");
    }

    #[test]
    fn remove_nonexistent_is_noop() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.remove("nope");
        assert_eq!(q.entries().len(), 1);
    }

    #[test]
    fn set_priority_changes_and_resorts() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Low));
        q.enqueue(make_entry("b", DownloadPriority::Critical));
        q.set_priority("a", DownloadPriority::High);

        let entries = q.entries();
        assert_eq!(entries[0].task_id, "b");
        assert_eq!(entries[1].task_id, "a");
    }

    #[test]
    fn set_priority_demotes() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Critical));
        q.set_priority("a", DownloadPriority::Background);

        let entries = q.entries();
        assert_eq!(entries[0].priority, "Background");
    }

    #[test]
    fn set_priority_nonexistent_is_noop() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.set_priority("zzz", DownloadPriority::Low);
        assert_eq!(q.entries()[0].priority, "Normal");
    }

    #[test]
    fn next_to_start_empty_queue() {
        let q = PriorityBandwidthQueue::new(1000);
        assert!(q.next_to_start().is_none());
    }

    #[test]
    fn next_to_start_active_zero_returns_first() {
        let q = PriorityBandwidthQueue::new(0);
        q.enqueue(make_entry("bg", DownloadPriority::Background));
        q.enqueue(make_entry("crit", DownloadPriority::Critical));
        q.start_download("crit");

        assert_eq!(q.active_count(), 1);

        q.enqueue(make_entry("x", DownloadPriority::Low));
        q.enqueue(make_entry("y", DownloadPriority::Background));

        let next = q.next_to_start();
        assert!(next.is_some());
    }

    #[test]
    fn next_to_start_respects_bandwidth_limit() {
        let q = PriorityBandwidthQueue::new(1000);
        // Critical min_share = 0.05, so min_bw = 50 kbps
        // With 21 active Critical downloads: allocatable = 1000/21 = 47 < 50 => None
        for i in 0..21 {
            q.enqueue(make_entry(
                &format!("active_{}", i),
                DownloadPriority::Critical,
            ));
        }
        for i in 0..21 {
            q.start_download(&format!("active_{}", i));
        }
        q.enqueue(make_entry("queued", DownloadPriority::Critical));

        let next = q.next_to_start();
        assert!(
            next.is_none(),
            "should reject when allocatable < min bandwidth"
        );
    }

    #[test]
    fn next_to_start_with_bandwidth_fits_high_priority() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.start_download("a");

        q.enqueue(make_entry("b", DownloadPriority::Critical));
        let next = q.next_to_start();
        assert_eq!(next.as_deref(), Some("b"));
    }

    #[test]
    fn start_download_increments_count() {
        let q = PriorityBandwidthQueue::new(1000);
        q.start_download("x");
        assert_eq!(q.active_count(), 1);
        q.start_download("y");
        assert_eq!(q.active_count(), 2);
    }

    #[test]
    fn stop_download_decrements_and_removes() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.start_download("a");
        assert_eq!(q.active_count(), 1);

        q.stop_download("a");
        assert_eq!(q.active_count(), 0);
        assert!(q.entries().is_empty());
    }

    #[test]
    fn stop_download_only_removes_stopped_task() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::High));
        q.enqueue(make_entry("b", DownloadPriority::Low));
        q.start_download("a");
        q.start_download("b");

        q.stop_download("a");
        assert_eq!(q.active_count(), 1);
        assert_eq!(q.entries().len(), 1);
        assert_eq!(q.entries()[0].task_id, "b");
    }

    #[test]
    fn entries_returns_snapshots() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("task1", DownloadPriority::High));
        let snapshots = q.entries();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].task_id, "task1");
        assert_eq!(snapshots[0].priority, "High");
        assert_eq!(snapshots[0].position, 0);
        assert_eq!(snapshots[0].size_bytes, 1024 * 1024);
    }

    #[test]
    fn active_count_starts_zero() {
        let q = PriorityBandwidthQueue::new(1000);
        assert_eq!(q.active_count(), 0);
    }

    #[test]
    fn reallocate_distributes_bandwidth_by_share() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("crit", DownloadPriority::Critical));
        q.enqueue(make_entry("high", DownloadPriority::High));
        q.start_download("crit");
        q.start_download("high");
        q.reallocate();

        let entries = q.entries();
        let crit_bw = entries
            .iter()
            .find(|e| e.task_id == "crit")
            .unwrap()
            .allocated_kbps;
        let high_bw = entries
            .iter()
            .find(|e| e.task_id == "high")
            .unwrap()
            .allocated_kbps;

        assert_eq!(crit_bw, 300);
        assert_eq!(high_bw, 250);
    }

    #[test]
    fn reallocate_splits_share_among_same_priority() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.enqueue(make_entry("b", DownloadPriority::Normal));
        q.start_download("a");
        q.start_download("b");
        q.reallocate();

        let entries = q.entries();
        for entry in &entries {
            assert_eq!(entry.allocated_kbps, 100);
        }
    }

    #[test]
    fn reallocate_no_active_downloads_does_nothing() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Normal));
        q.reallocate();
        assert_eq!(q.entries()[0].allocated_kbps, 0);
    }

    #[test]
    fn set_total_bandwidth_triggers_reallocate() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("a", DownloadPriority::Critical));
        q.start_download("a");
        q.set_total_bandwidth(2000);

        assert_eq!(q.total_bandwidth(), 2000);
        // Critical share is 0.30, so allocated = 2000 * 0.30 = 600
        assert_eq!(q.entries()[0].allocated_kbps, 600);
    }

    #[test]
    fn total_bandwidth_persists() {
        let q = PriorityBandwidthQueue::new(5000);
        assert_eq!(q.total_bandwidth(), 5000);
        q.set_total_bandwidth(999);
        assert_eq!(q.total_bandwidth(), 999);
    }

    #[test]
    fn mixed_priority_bandwidth_distribution() {
        let q = PriorityBandwidthQueue::new(1000);
        q.enqueue(make_entry("c", DownloadPriority::Critical));
        q.enqueue(make_entry("h", DownloadPriority::High));
        q.enqueue(make_entry("n", DownloadPriority::Normal));
        q.enqueue(make_entry("l", DownloadPriority::Low));
        q.enqueue(make_entry("b", DownloadPriority::Background));

        for t in ["c", "h", "n", "l", "b"] {
            q.start_download(t);
        }
        q.reallocate();

        let entries = q.entries();
        let find = |id: &str| -> u64 {
            entries
                .iter()
                .find(|e| e.task_id == id)
                .unwrap()
                .allocated_kbps
        };

        assert_eq!(find("c"), 300);
        assert_eq!(find("h"), 250);
        assert_eq!(find("n"), 200);
        assert_eq!(find("l"), 150);
        assert_eq!(find("b"), 100);
    }

    #[test]
    fn entries_preserves_fifo_within_same_priority() {
        let q = PriorityBandwidthQueue::new(1000);
        let e1 = make_entry("first", DownloadPriority::Normal);
        std::thread::sleep(std::time::Duration::from_millis(2));
        let e2 = make_entry("second", DownloadPriority::Normal);

        q.enqueue(e1);
        q.enqueue(e2);

        let entries = q.entries();
        assert_eq!(entries[0].task_id, "second");
        assert_eq!(entries[1].task_id, "first");
    }
}
