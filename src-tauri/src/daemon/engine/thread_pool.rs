use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;

use crate::daemon::engine::config::global_config;

pub struct ThreadPool {
    tx: Option<mpsc::Sender<Box<dyn FnOnce() + Send>>>,
    worker_handles: Vec<thread::JoinHandle<()>>,
    dispatcher_handle: Option<thread::JoinHandle<()>>,
    active_count: Arc<AtomicU32>,
    max_size: u32,
}

impl ThreadPool {
    pub fn new() -> Self {
        let cfg = global_config();
        Self::with_size(cfg.worker_threads).unwrap_or_else(|e| {
            log::error!("thread_pool: {e}; falling back to 1 worker");
            Self::with_size(1).expect("1-worker pool must succeed")
        })
    }

    /// Create a pool with `size` workers. Rejects 0 — a zero-worker pool
    /// would deadlock the dispatcher on `% 0` (M2).
    pub fn with_size(size: u32) -> Result<Self, String> {
        if size == 0 {
            return Err("ThreadPool::with_size(0) rejected: would divide by zero".into());
        }
        let active_count = Arc::new(AtomicU32::new(0));
        let mut worker_handles = Vec::with_capacity(size as usize);

        // Create per-worker channels so workers never contend on a single
        // Mutex-protected Receiver (C-04 fix).
        let mut worker_txs = Vec::with_capacity(size as usize);
        for i in 0..size {
            let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
            worker_txs.push(tx);
            let ac = active_count.clone();
            match thread::Builder::new()
                .name(format!("nova-worker-{i}"))
                .spawn(move || {
                    while let Ok(task_fn) = rx.recv() {
                        ac.fetch_add(1, Ordering::Relaxed);
                        let result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(task_fn));
                        ac.fetch_sub(1, Ordering::Relaxed);
                        if let Err(panic) = result {
                            let msg = if let Some(s) = panic.downcast_ref::<&str>() {
                                (*s).to_owned()
                            } else if let Some(s) = panic.downcast_ref::<String>() {
                                s.clone()
                            } else {
                                "unknown".to_owned()
                            };
                            log::error!("Worker thread task panicked: {msg}");
                        }
                    }
                }) {
                Ok(handle) => worker_handles.push(handle),
                Err(e) => {
                    log::error!("Failed to spawn nova worker thread {i}: {e}");
                    break;
                }
            }
        }

        // Dispatcher thread: receives tasks from the public channel and
        // distributes them round-robin across per-worker channels.
        let (public_tx, public_rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let dispatcher_handle = thread::Builder::new()
            .name("nova-dispatcher".to_owned())
            .spawn(move || {
                let mut idx = 0usize;
                let count = worker_txs.len();
                loop {
                    let task = match public_rx.recv() {
                        Ok(t) => t,
                        Err(_) => break,
                    };
                    let start = idx;
                    let result = worker_txs[idx].send(task);
                    match result {
                        Ok(()) => {
                            idx = (idx + 1) % count;
                        }
                        Err(send_err) => {
                            let mut returned_task = send_err.0;
                            loop {
                                idx = (idx + 1) % count;
                                if idx == start {
                                    log::error!("All worker channels closed, dropping task");
                                    break;
                                }
                                match worker_txs[idx].send(returned_task) {
                                    Ok(()) => {
                                        idx = (idx + 1) % count;
                                        break;
                                    }
                                    Err(e) => returned_task = e.0,
                                }
                            }
                        }
                    }
                }
            })
            .unwrap();

        Ok(Self {
            tx: Some(public_tx),
            worker_handles,
            dispatcher_handle: Some(dispatcher_handle),
            active_count,
            max_size: size,
        })
    }

    #[allow(dead_code)]
    pub fn spawn<F: FnOnce() + Send + 'static>(&self, task: F) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Box::new(task));
        }
    }

    pub fn active_count(&self) -> u32 {
        self.active_count.load(Ordering::Relaxed)
    }

    pub const fn max_size(&self) -> u32 {
        self.max_size
    }

    #[cfg(test)]
    pub fn shutdown(mut self) {
        drop(self.tx.take());
        if let Some(h) = self.dispatcher_handle.take() {
            let _ = h.join();
        }
        for handle in self.worker_handles.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        // Fast path: if no worker is alive there is nothing to signal or join.
        // This check races with a worker finishing between `is_finished()` and
        // `join()`, but that is harmless — joining an already-finished thread
        // returns immediately, so the cleanup below is always safe.
        if self.worker_handles.iter().any(|h| !h.is_finished()) {
            drop(self.tx.take());
            if let Some(h) = self.dispatcher_handle.take() {
                let _ = h.join();
            }
            for handle in self.worker_handles.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn new_creates_pool() {
        let pool = ThreadPool::with_size(2).unwrap();
        assert_eq!(pool.max_size(), 2);
        assert_eq!(pool.active_count(), 0);
        pool.shutdown();
    }

    #[test]
    fn zero_size_pool_is_rejected() {
        // M2 regression: with_size(0) must return Err (the dispatcher would
        // divide by zero), not panic or deadlock.
        assert!(ThreadPool::with_size(0).is_err());
    }

    #[test]
    fn spawn_executes_task() {
        let pool = ThreadPool::with_size(2).unwrap();
        let counter = Arc::new(AtomicUsize::new(0));
        let c = counter.clone();
        pool.spawn(move || {
            c.fetch_add(1, Ordering::Relaxed);
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(counter.load(Ordering::Relaxed) >= 1);
        pool.shutdown();
    }

    #[test]
    fn multiple_tasks_execute() {
        let pool = ThreadPool::with_size(4).unwrap();
        let counter = Arc::new(AtomicUsize::new(0));
        for _ in 0..100 {
            let c = counter.clone();
            pool.spawn(move || {
                c.fetch_add(1, Ordering::Relaxed);
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(counter.load(Ordering::Relaxed), 100);
        pool.shutdown();
    }

    #[test]
    fn active_count_tracks_workers() {
        let pool = ThreadPool::with_size(4).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(4));
        for _ in 0..4 {
            let b = barrier.clone();
            pool.spawn(move || {
                b.wait();
                std::thread::sleep(std::time::Duration::from_millis(50));
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        let active = pool.active_count();
        assert!(active >= 1, "active count should be >= 1, got {}", active);
        pool.shutdown();
    }

    #[test]
    fn global_config_creates_valid_pool() {
        let pool = ThreadPool::new();
        assert!(pool.max_size() >= 1);
        pool.shutdown();
    }
}
