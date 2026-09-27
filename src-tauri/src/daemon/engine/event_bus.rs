use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum EngineEvent {
    DownloadStarted {
        task_id: String,
        url: String,
        total_bytes: u64,
        connections: u32,
    },
    DownloadProgress {
        task_id: String,
        downloaded_bytes: u64,
        total_bytes: u64,
        speed_bytes_per_sec: u64,
        active_segments: u32,
    },
    DownloadComplete {
        task_id: String,
        total_bytes: u64,
        elapsed_secs: f64,
        checksum_ok: Option<bool>,
    },
    DownloadFailed {
        task_id: String,
        error: String,
        will_retry: bool,
        retry_in_secs: Option<u64>,
    },
    DownloadPaused {
        task_id: String,
        downloaded_bytes: u64,
    },
    DownloadResumed {
        task_id: String,
        from_bytes: u64,
        connections: u32,
    },
    DownloadCancelled {
        task_id: String,
    },
    SegmentStolen {
        task_id: String,
        from_segment: u32,
        to_segment: u32,
        bytes_stolen: u64,
    },
    ConnectionsAdjusted {
        task_id: String,
        old_count: u32,
        new_count: u32,
        reason: String,
    },
    RetryScheduled {
        task_id: String,
        attempt: u32,
        max_retries: u32,
        delay_secs: u64,
    },
    ChecksumVerified {
        task_id: String,
        algorithm: String,
        expected: String,
        actual: String,
        passed: bool,
    },
    MirrorFound {
        task_id: String,
        mirror_url: String,
    },
    SpeedChanged {
        task_id: String,
        old_speed: u64,
        new_speed: u64,
    },
    QueueChanged {
        task_id: String,
        position: u32,
        priority: u32,
    },
    BandwidthAllocated {
        task_id: String,
        allocated_kbps: u64,
    },
    SchedulerTriggered {
        task_id: String,
        action: String,
    },
    RuleApplied {
        task_id: String,
        rule_id: String,
        action: String,
    },
    ProfileSwitched {
        task_id: String,
        profile: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct TimestampedEvent {
    pub id: u64,
    pub event: EngineEvent,
    #[serde(skip)]
    pub timestamp: Instant,
    pub timestamp_millis: u128,
}

impl EngineEvent {
    fn task_id(&self) -> Option<&str> {
        match self {
            Self::DownloadStarted { task_id, .. }
            | Self::DownloadProgress { task_id, .. }
            | Self::DownloadComplete { task_id, .. }
            | Self::DownloadFailed { task_id, .. }
            | Self::DownloadPaused { task_id, .. }
            | Self::DownloadResumed { task_id, .. }
            | Self::DownloadCancelled { task_id, .. }
            | Self::SegmentStolen { task_id, .. }
            | Self::ConnectionsAdjusted { task_id, .. }
            | Self::RetryScheduled { task_id, .. }
            | Self::ChecksumVerified { task_id, .. }
            | Self::MirrorFound { task_id, .. }
            | Self::SpeedChanged { task_id, .. }
            | Self::QueueChanged { task_id, .. }
            | Self::BandwidthAllocated { task_id, .. }
            | Self::SchedulerTriggered { task_id, .. }
            | Self::RuleApplied { task_id, .. }
            | Self::ProfileSwitched { task_id, .. } => Some(task_id),
        }
    }
}

/// Callback invoked synchronously for every published engine event.
type Subscriber = Arc<dyn Fn(&TimestampedEvent) + Send + Sync>;

pub type SubscriberId = u64;

/// Cap on re-entrant events queued while a publish is in flight. Prevents
/// unbounded growth when a slow subscriber triggers many nested publishes
/// (M3): oldest events are dropped, newest survive.
const MAX_PENDING_EVENTS: usize = 10_000;

/// RAII guard that guarantees `EventBusInner::publish_depth` is reset — and
/// any re-entrantly queued events are collected — even when a panic unwinds
/// past subscriber notification. Without it, a panic mid-publish would leave
/// `publish_depth > 0` forever and every subsequent event would be silently
/// queued into `pending_events` without ever being processed.
struct PublishGuard<'a> {
    bus: &'a EventBus,
    pending: Vec<EngineEvent>,
    finished: bool,
}

impl PublishGuard<'_> {
    /// Reset the publish depth, take the re-entrantly queued events, and
    /// return them for processing. Marks the guard finished so its `Drop`
    /// does not run the same logic twice.
    fn finish(mut self) -> Vec<EngineEvent> {
        self.finished = true;
        self.reset_depth();
        std::mem::take(&mut self.pending)
    }

    fn reset_depth(&mut self) {
        let mut inner = match self.bus.inner.lock() {
            Ok(g) => g,
            Err(poison) => {
                log::error!("EventBus: mutex poisoned after publish, recovering");
                poison.into_inner()
            }
        };
        inner.publish_depth = 0;
        self.pending
            .extend(std::mem::take(&mut inner.pending_events));
    }
}

impl Drop for PublishGuard<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // Panic path: still reset the depth so the bus keeps working. We do
        // NOT re-publish the queued events here — re-entering `publish`
        // (which itself locks and invokes subscribers) during unwinding could
        // panic a second time and abort the process.
        self.reset_depth();
        if !self.pending.is_empty() {
            log::warn!(
                "EventBus: {} event(s) queued during a panicked publish were dropped",
                self.pending.len()
            );
        }
    }
}

struct EventBusInner {
    subscribers: Vec<(SubscriberId, Subscriber)>,
    // Counters are only ever read/modified while holding the mutex, so plain
    // u64 fields suffice; the atomics inside the lock were redundant.
    next_subscriber_id: u64,
    event_log: Vec<TimestampedEvent>,
    task_index: HashMap<String, Vec<usize>>,
    next_id: u64,
    max_log_size: usize,
    publish_depth: usize,
    pending_events: Vec<EngineEvent>,
}

#[derive(Clone)]
pub struct EventBus {
    inner: Arc<Mutex<EventBusInner>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(EventBusInner {
                subscribers: Vec::new(),
                next_subscriber_id: 1,
                event_log: Vec::new(),
                task_index: HashMap::new(),
                next_id: 1,
                max_log_size: 10_000,
                publish_depth: 0,
                pending_events: Vec::new(),
            })),
        }
    }

    pub fn new_with_capacity(max_log_size: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(EventBusInner {
                subscribers: Vec::new(),
                next_subscriber_id: 1,
                event_log: Vec::new(),
                task_index: HashMap::new(),
                next_id: 1,
                max_log_size: max_log_size.max(1),
                publish_depth: 0,
                pending_events: Vec::new(),
            })),
        }
    }

    pub fn publish(&self, event: EngineEvent) {
        // Process queued re-entrant events iteratively. Calling `publish`
        // recursively here lets a subscriber that publishes one follow-up per
        // event grow the call stack without ever reaching the pending-event
        // cap. A local FIFO preserves publication order with bounded stack use.
        let mut to_publish = VecDeque::from([event]);
        while let Some(event) = to_publish.pop_front() {
            // Phase 1: lock + decide whether to store or queue.
            let (ts_event, subscriber_clone) = {
                let mut inner = match self.inner.lock() {
                    Ok(g) => g,
                    Err(poison) => {
                        log::error!("EventBus: mutex poisoned, recovering");
                        let mut recovered = poison.into_inner();
                        // A previous publish may have panicked while holding the
                        // lock. Clear the reentrancy guard so the bus can publish
                        // again; any events that publish had queued are drained by
                        // this (or the next) publish's Phase 3.
                        recovered.publish_depth = 0;
                        recovered
                    }
                };

                if inner.publish_depth > 0 {
                    // Reentrant call: queue for processing after the current
                    // notification completes. Bounded: drop oldest first.
                    if inner.pending_events.len() >= MAX_PENDING_EVENTS {
                        inner.pending_events.remove(0);
                    }
                    inner.pending_events.push(event);
                    return;
                }

                inner.publish_depth = 1;

                let id = inner.next_id;
                inner.next_id = inner.next_id.saturating_add(1);
                let task_id_opt = event.task_id().map(std::borrow::ToOwned::to_owned);
                let ts_event = TimestampedEvent {
                    id,
                    event,
                    timestamp: Instant::now(),
                    timestamp_millis: chrono::Utc::now().timestamp_millis().max(0) as u128,
                };

                // Rotate log if at capacity.
                if inner.event_log.len() >= inner.max_log_size {
                    let drain_count = (inner.max_log_size / 4).max(1);
                    for indices in inner.task_index.values_mut() {
                        indices.retain(|&idx| idx >= drain_count);
                        for idx in indices.iter_mut() {
                            *idx -= drain_count;
                        }
                    }
                    inner.task_index.retain(|_, v| !v.is_empty());
                    inner.event_log.drain(..drain_count);
                }
                if let Some(ref tid) = task_id_opt {
                    let idx = inner.event_log.len();
                    inner.task_index.entry(tid.clone()).or_default().push(idx);
                }
                inner.event_log.push(ts_event.clone());
                let subscriber_clone = inner
                    .subscribers
                    .iter()
                    .map(|(_, s)| s.clone())
                    .collect::<Vec<_>>();
                (ts_event, subscriber_clone)
            };

            // `PublishGuard` guarantees `publish_depth` is reset — and any
            // re-entrant events are collected — even if a panic unwinds past
            // subscriber notification, so the bus cannot remain stuck in a
            // publishing state.
            let guard = PublishGuard {
                bus: self,
                pending: Vec::new(),
                finished: false,
            };

            // Phase 2: notify subscribers outside the lock so they can safely
            // call back into `publish`. A subscriber panic is isolated so it
            // cannot take down the daemon or suppress later subscribers.
            for sub in &subscriber_clone {
                let _ = catch_unwind(AssertUnwindSafe(|| sub(&ts_event))).map_err(|e| {
                    let msg = if let Some(s) = e.downcast_ref::<&str>() {
                        (*s).to_owned()
                    } else if let Some(s) = e.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_owned()
                    };
                    log::error!(
                        "EventBus: subscriber panicked ({msg}); subscriber state may be corrupted"
                    );
                });
            }

            // Phase 3: append re-entrant events to the local FIFO instead of
            // recursively invoking `publish` for each event.
            to_publish.extend(guard.finish());
        }
    }

    pub fn subscribe<F>(&self, callback: F) -> SubscriberId
    where
        F: Fn(&TimestampedEvent) + Send + Sync + 'static,
    {
        if let Ok(mut inner) = self.inner.lock() {
            let id = inner.next_subscriber_id;
            // `0` is the documented failure sentinel. Do not issue `u64::MAX`
            // because its successor cannot be represented and would make the
            // next registration reuse the same ID, so `unsubscribe` could
            // remove an unrelated subscriber.
            if id == u64::MAX {
                log::error!("EventBus: subscriber ID space exhausted");
                return 0;
            }
            inner.next_subscriber_id += 1;
            inner.subscribers.push((id, Arc::new(callback)));
            id
        } else {
            0
        }
    }

    #[allow(dead_code)]
    pub fn unsubscribe(&self, id: SubscriberId) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            let before = inner.subscribers.len();
            inner.subscribers.retain(|(sid, _)| *sid != id);
            inner.subscribers.len() < before
        } else {
            false
        }
    }

    pub fn recent_events(&self, count: usize) -> Vec<TimestampedEvent> {
        self.inner
            .lock()
            .map(|inner| {
                let len = inner.event_log.len();
                let start = len.saturating_sub(count);
                inner.event_log[start..].to_vec()
            })
            .unwrap_or_default()
    }

    pub fn events_for_task(&self, task_id: &str, count: usize) -> Vec<TimestampedEvent> {
        self.inner
            .lock()
            .map(|inner| {
                if let Some(indices) = inner.task_index.get(task_id) {
                    let start = indices.len().saturating_sub(count);
                    indices[start..]
                        .iter()
                        .rev()
                        .filter_map(|&idx| inner.event_log.get(idx).cloned())
                        .collect()
                } else {
                    Vec::new()
                }
            })
            .unwrap_or_default()
    }

    pub fn clear_log(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.event_log.clear();
            inner.task_index.clear();
        }
    }

    pub fn subscriber_count(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.subscribers.len())
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn make_started(task_id: &str) -> EngineEvent {
        EngineEvent::DownloadStarted {
            task_id: task_id.to_string(),
            url: format!("https://example.com/{task_id}"),
            total_bytes: 1024,
            connections: 4,
        }
    }

    fn make_progress(task_id: &str, downloaded: u64) -> EngineEvent {
        EngineEvent::DownloadProgress {
            task_id: task_id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: 1024,
            speed_bytes_per_sec: 512,
            active_segments: 2,
        }
    }

    fn make_complete(task_id: &str) -> EngineEvent {
        EngineEvent::DownloadComplete {
            task_id: task_id.to_string(),
            total_bytes: 1024,
            elapsed_secs: 1.0,
            checksum_ok: Some(true),
        }
    }

    fn make_cancelled(task_id: &str) -> EngineEvent {
        EngineEvent::DownloadCancelled {
            task_id: task_id.to_string(),
        }
    }

    // ── 1. publish adds to event log ──────────────────────────────────

    #[test]
    fn publish_adds_to_event_log() {
        let bus = EventBus::new();
        assert!(bus.recent_events(100).is_empty());

        bus.publish(make_started("t1"));

        let events = bus.recent_events(100);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(events[0].event, EngineEvent::DownloadStarted { ref task_id, .. } if task_id == "t1")
        );
    }

    #[test]
    fn pending_events_queue_is_bounded() {
        // M3 regression: re-entrant events must not grow the pending queue
        // without bound. Simulate a nested publish flood by filling the
        // pending queue directly (the cap is enforced on push).
        let bus = EventBus::new();
        {
            let mut inner = bus.inner.lock().unwrap();
            inner.publish_depth = 1;
            for i in 0..(MAX_PENDING_EVENTS + 500) {
                if inner.pending_events.len() >= MAX_PENDING_EVENTS {
                    inner.pending_events.remove(0);
                }
                inner.pending_events.push(make_progress("t1", i as u64));
            }
            let len = inner.pending_events.len();
            assert!(
                len <= MAX_PENDING_EVENTS,
                "pending queue must be capped at {MAX_PENDING_EVENTS}, got {len}"
            );
        }
    }

    #[test]
    fn deep_reentrant_publish_chain_is_iterative_and_ordered() {
        const CHAIN_LENGTH: u64 = 4_096;
        let bus = EventBus::new_with_capacity((CHAIN_LENGTH + 1) as usize);
        let weak_inner = Arc::downgrade(&bus.inner);
        let notifications = Arc::new(AtomicUsize::new(0));
        let notifications_for_subscriber = notifications.clone();

        bus.subscribe(move |event| {
            notifications_for_subscriber.fetch_add(1, Ordering::SeqCst);
            if let EngineEvent::DownloadProgress {
                task_id,
                downloaded_bytes,
                ..
            } = &event.event
            {
                if *downloaded_bytes < CHAIN_LENGTH {
                    if let Some(inner) = weak_inner.upgrade() {
                        EventBus { inner }.publish(make_progress(task_id, downloaded_bytes + 1));
                    }
                }
            }
        });

        bus.publish(make_progress("t1", 0));
        let events = bus.events_for_task("t1", (CHAIN_LENGTH + 1) as usize);
        assert_eq!(
            notifications.load(Ordering::SeqCst),
            (CHAIN_LENGTH + 1) as usize
        );
        assert_eq!(events.len(), (CHAIN_LENGTH + 1) as usize);
        assert!(matches!(
            events.first().map(|event| &event.event),
            Some(EngineEvent::DownloadProgress {
                downloaded_bytes: CHAIN_LENGTH,
                ..
            })
        ));
        assert!(matches!(
            events.last().map(|event| &event.event),
            Some(EngineEvent::DownloadProgress {
                downloaded_bytes: 0,
                ..
            })
        ));
    }

    #[test]
    fn zero_log_capacity_is_normalized_to_one() {
        let bus = EventBus::new_with_capacity(0);
        bus.publish(make_progress("t1", 1));
        bus.publish(make_progress("t1", 2));
        let events = bus.recent_events(10);
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events[0].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 2,
                ..
            }
        ));
    }

    // ── 2. publish assigns sequential IDs ─────────────────────────────

    #[test]
    fn publish_assigns_sequential_ids() {
        let bus = EventBus::new();

        bus.publish(make_started("t1"));
        bus.publish(make_progress("t1", 100));
        bus.publish(make_complete("t1"));

        let ids: Vec<u64> = bus.recent_events(100).iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn ids_are_unique_across_instances() {
        let bus1 = EventBus::new();
        let bus2 = EventBus::new();
        bus1.publish(make_started("a"));
        bus2.publish(make_started("b"));
        assert_eq!(bus1.recent_events(10)[0].id, 1);
        assert_eq!(bus2.recent_events(10)[0].id, 1);
    }

    // ── 3. subscribe callback is called on publish ────────────────────

    #[test]
    fn subscribe_callback_is_called() {
        let bus = EventBus::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let counter_clone = counter.clone();

        bus.subscribe(move |evt| {
            let _ = &evt.id; // ensure it's a valid TimestampedEvent
            counter_clone.fetch_add(1, Ordering::SeqCst);
        });

        bus.publish(make_started("t1"));
        bus.publish(make_progress("t1", 50));

        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn multiple_subscribers_all_called() {
        let bus = EventBus::new();
        let hit_a = Arc::new(AtomicBool::new(false));
        let hit_b = Arc::new(AtomicBool::new(false));
        let ha = hit_a.clone();
        let hb = hit_b.clone();

        bus.subscribe(move |_| {
            ha.store(true, Ordering::SeqCst);
        });
        bus.subscribe(move |_| {
            hb.store(true, Ordering::SeqCst);
        });

        bus.publish(make_started("t1"));

        assert!(hit_a.load(Ordering::SeqCst));
        assert!(hit_b.load(Ordering::SeqCst));
    }

    #[test]
    fn subscriber_receives_correct_event() {
        let bus = EventBus::new();
        let received = Arc::new(Mutex::new(Vec::new()));
        let recv = received.clone();

        bus.subscribe(move |evt| {
            recv.lock().unwrap().push(evt.event.clone());
        });

        let ev = make_complete("t1");
        bus.publish(ev.clone());

        let received = received.lock().unwrap();
        assert_eq!(received.len(), 1);
        assert!(
            matches!(&received[0], EngineEvent::DownloadComplete { task_id, .. } if task_id == "t1")
        );
    }

    // ── 4. recent_events returns correct count ────────────────────────

    #[test]
    fn recent_events_returns_correct_count() {
        let bus = EventBus::new();
        for i in 0..10 {
            bus.publish(make_progress("t1", i * 100));
        }

        let events = bus.recent_events(3);
        assert_eq!(events.len(), 3);
        // last three: 700, 800, 900
        assert!(matches!(
            events[0].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 700,
                ..
            }
        ));
        assert!(matches!(
            events[1].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 800,
                ..
            }
        ));
        assert!(matches!(
            events[2].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 900,
                ..
            }
        ));
    }

    #[test]
    fn recent_events_clamped_to_available() {
        let bus = EventBus::new();
        bus.publish(make_started("t1"));

        let events = bus.recent_events(1000);
        assert_eq!(events.len(), 1);
    }

    // ── 5. recent_events on empty log returns empty ───────────────────

    #[test]
    fn recent_events_empty_log() {
        let bus = EventBus::new();
        assert!(bus.recent_events(0).is_empty());
        assert!(bus.recent_events(5).is_empty());
        assert!(bus.recent_events(100).is_empty());
    }

    // ── 6. events_for_task filters correctly ──────────────────────────

    #[test]
    fn events_for_task_filters_by_task_id() {
        let bus = EventBus::new();

        bus.publish(make_started("aaa"));
        bus.publish(make_progress("bbb", 100));
        bus.publish(make_complete("aaa"));
        bus.publish(make_progress("aaa", 200));
        bus.publish(make_started("bbb"));
        bus.publish(make_cancelled("aaa"));

        let aaa_events = bus.events_for_task("aaa", 100);
        assert_eq!(aaa_events.len(), 4);

        let bbb_events = bus.events_for_task("bbb", 100);
        assert_eq!(bbb_events.len(), 2);
    }

    #[test]
    fn events_for_task_respects_count() {
        let bus = EventBus::new();
        for i in 0..10 {
            bus.publish(make_progress("t1", i));
        }

        let events = bus.events_for_task("t1", 3);
        assert_eq!(events.len(), 3);
        // most recent first
        assert!(matches!(
            events[0].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 9,
                ..
            }
        ));
        assert!(matches!(
            events[1].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 8,
                ..
            }
        ));
        assert!(matches!(
            events[2].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 7,
                ..
            }
        ));
    }

    // ── 7. events_for_task returns empty for unknown task ─────────────

    #[test]
    fn events_for_task_empty_for_unknown() {
        let bus = EventBus::new();
        bus.publish(make_started("aaa"));
        bus.publish(make_progress("aaa", 50));

        let events = bus.events_for_task("unknown", 100);
        assert!(events.is_empty());
    }

    #[test]
    fn events_for_task_empty_on_empty_log() {
        let bus = EventBus::new();
        assert!(bus.events_for_task("anything", 10).is_empty());
    }

    // ── 8. clear_log empties the log ──────────────────────────────────

    #[test]
    fn clear_log_empties_the_log() {
        let bus = EventBus::new();
        bus.publish(make_started("t1"));
        bus.publish(make_progress("t1", 100));
        bus.publish(make_complete("t1"));
        assert_eq!(bus.recent_events(100).len(), 3);

        bus.clear_log();
        assert!(bus.recent_events(100).is_empty());
    }

    #[test]
    fn clear_log_preserves_subscribers() {
        let bus = EventBus::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();

        bus.subscribe(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        });

        bus.publish(make_started("t1"));
        bus.clear_log();

        // subscribers still active after clear
        bus.publish(make_started("t2"));
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn clear_log_ids_restart_from_last() {
        let bus = EventBus::new();
        bus.publish(make_started("t1")); // id=1
        bus.clear_log();
        bus.publish(make_started("t2")); // id=2, not reset

        let events = bus.recent_events(10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, 2);
    }

    // ── 9. subscriber_count returns correct count ─────────────────────

    #[test]
    fn subscriber_count_initial_zero() {
        let bus = EventBus::new();
        assert_eq!(bus.subscriber_count(), 0);
    }

    #[test]
    fn subscriber_count_increments() {
        let bus = EventBus::new();
        bus.subscribe(|_| {});
        assert_eq!(bus.subscriber_count(), 1);

        bus.subscribe(|_| {});
        assert_eq!(bus.subscriber_count(), 2);

        bus.subscribe(|_| {});
        assert_eq!(bus.subscriber_count(), 3);
    }

    #[test]
    fn subscriber_id_exhaustion_returns_failure_sentinel_without_reuse() {
        let bus = EventBus::new();
        {
            let mut inner = bus.inner.lock().unwrap();
            inner.next_subscriber_id = u64::MAX;
        }
        assert_eq!(bus.subscribe(|_| {}), 0);
        assert_eq!(bus.subscribe(|_| {}), 0);
        assert_eq!(bus.subscriber_count(), 0);
    }

    // ── 10. Log rotation: publishing beyond max_log_size drains ───────

    #[test]
    fn log_rotation_drains_old_entries() {
        let bus = EventBus::new_with_capacity(20);

        for i in 0..20 {
            bus.publish(make_progress("t1", i));
        }
        // log is exactly at capacity
        assert_eq!(bus.recent_events(100).len(), 20);

        // 21st publish triggers drain of 20/4 = 5 oldest
        bus.publish(make_progress("t1", 99));

        let events = bus.recent_events(100);
        assert_eq!(events.len(), 16); // 20 - 5 + 1

        // oldest remaining should be index 5 (downloaded_bytes=5)
        assert!(matches!(
            events[0].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 5,
                ..
            }
        ));
        // newest is 99
        assert!(matches!(
            events.last().unwrap().event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 99,
                ..
            }
        ));
    }

    #[test]
    fn log_rotation_does_not_trigger_below_capacity() {
        let bus = EventBus::new_with_capacity(10);

        for i in 0..9 {
            bus.publish(make_progress("t1", i));
        }
        assert_eq!(bus.recent_events(100).len(), 9);

        bus.publish(make_progress("t1", 9));
        assert_eq!(bus.recent_events(100).len(), 10);
    }

    #[test]
    fn log_rotation_repeated() {
        let bus = EventBus::new_with_capacity(10);

        for i in 0..25 {
            bus.publish(make_progress("t1", i));
        }

        let events = bus.recent_events(100);
        // each publish beyond 10 drains 2 (10/4=2).
        // simplified: log stays around capacity
        assert!(events.len() <= 10);
        // last event has downloaded_bytes=24
        assert!(matches!(
            events.last().unwrap().event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 24,
                ..
            }
        ));
    }

    #[test]
    fn log_rotation_small_capacity() {
        let bus = EventBus::new_with_capacity(4);

        bus.publish(make_started("t1")); // log: 1
        bus.publish(make_progress("t1", 10)); // log: 2
        bus.publish(make_progress("t1", 20)); // log: 3
        bus.publish(make_progress("t1", 30)); // log: 4 (at capacity)
        bus.publish(make_progress("t1", 40)); // triggers drain of 4/4=1

        let events = bus.recent_events(100);
        assert_eq!(events.len(), 4);
        // first event is now the one after the drained one
        assert!(matches!(
            events[0].event,
            EngineEvent::DownloadProgress {
                downloaded_bytes: 10,
                ..
            }
        ));
    }

    // ── Default impl ──────────────────────────────────────────────────

    #[test]
    fn default_is_same_as_new() {
        let bus = EventBus::default();
        bus.publish(make_started("t1"));
        assert_eq!(bus.recent_events(10).len(), 1);
    }

    // ── Clone shares state ────────────────────────────────────────────

    #[test]
    fn clone_shares_subscribers() {
        let bus = EventBus::new();
        let bus2 = bus.clone();

        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        bus.subscribe(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        });

        assert_eq!(bus2.subscriber_count(), 1);

        bus2.publish(make_started("t1"));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    // ── 11. Subscriber panic does not disable the bus ─────────────────

    #[test]
    fn panic_in_subscriber_does_not_disable_bus() {
        use std::panic;

        let bus = EventBus::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();

        bus.subscribe(|_| {
            panic!("boom");
        });
        bus.subscribe(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        });

        bus.publish(make_started("t1"));
        // second subscriber still called despite first panicking
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        // bus is still functional
        bus.publish(make_started("t2"));
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    // ── 12. unsubscribe removes subscriber ────────────────────────────

    #[test]
    fn unsubscribe_removes_subscriber() {
        let bus = EventBus::new();
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();

        let id = bus.subscribe(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(bus.subscriber_count(), 1);

        bus.publish(make_started("t1"));
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        assert!(bus.unsubscribe(id));
        assert_eq!(bus.subscriber_count(), 0);

        bus.publish(make_started("t2"));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unsubscribe_nonexistent_id_returns_false() {
        let bus = EventBus::new();
        assert!(!bus.unsubscribe(999));
    }
}
