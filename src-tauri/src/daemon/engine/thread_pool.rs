#![allow(dead_code)]
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use crate::daemon::engine::config::global_config;

pub struct ThreadPool {
    tx: Option<mpsc::Sender<Box<dyn FnOnce() + Send>>>,
    handles: Vec<thread::JoinHandle<()>>,
    active_count: Arc<AtomicU32>,
    max_size: u32,
}

impl ThreadPool {
    pub fn new() -> Self {
        let cfg = global_config();
        Self::with_size(cfg.worker_threads)
    }

    pub fn with_size(size: u32) -> Self {
        let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let rx = Arc::new(std::sync::Mutex::new(rx));
        let active_count = Arc::new(AtomicU32::new(0));
        let mut handles = Vec::with_capacity(size as usize);

        for i in 0..size {
            let rx = rx.clone();
            let ac = active_count.clone();
            let handle = thread::Builder::new()
                .name(format!("nova-worker-{i}"))
                .spawn(move || loop {
                    let task = {
                        let lock = match rx.lock() {
                            Ok(l) => l,
                            Err(_) => break,
                        };
                        lock.recv()
                    };
                    match task {
                        Ok(task_fn) => {
                            ac.fetch_add(1, Ordering::Relaxed);
                            task_fn();
                            ac.fetch_sub(1, Ordering::Relaxed);
                        }
                        Err(_) => break,
                    }
                })
                .expect("failed to spawn worker thread");
            handles.push(handle);
        }

        Self {
            tx: Some(tx),
            handles,
            active_count,
            max_size: size,
        }
    }

    pub fn spawn<F: FnOnce() + Send + 'static>(&self, task: F) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(Box::new(task));
        }
    }

    pub fn active_count(&self) -> u32 {
        self.active_count.load(Ordering::Relaxed)
    }

    pub fn max_size(&self) -> u32 {
        self.max_size
    }

    pub fn shutdown(mut self) {
        drop(self.tx.take());
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        if self.handles.iter().any(|h| !h.is_finished()) {
            drop(self.tx.take());
            for handle in self.handles.drain(..) {
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
        let pool = ThreadPool::with_size(2);
        assert_eq!(pool.max_size(), 2);
        assert_eq!(pool.active_count(), 0);
        pool.shutdown();
    }

    #[test]
    fn spawn_executes_task() {
        let pool = ThreadPool::with_size(2);
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
        let pool = ThreadPool::with_size(4);
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
        let pool = ThreadPool::with_size(4);
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
