use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::daemon::engine::config::global_config;

const CHANNEL_BOUND: usize = 64;

#[derive(Clone, Debug)]
pub struct DiskWriterStats {
    pub bytes_written: u64,
    pub flushes: u64,
    pub pending_bytes: u64,
}

impl Default for DiskWriterStats {
    fn default() -> Self {
        Self {
            bytes_written: 0,
            flushes: 0,
            pending_bytes: 0,
        }
    }
}

pub enum WriteCommand {
    Data {
        segment_id: u32,
        offset: u64,
        data: Vec<u8>,
    },
    Flush,
    Shutdown,
}

pub struct AsyncDiskWriter {
    tx: mpsc::SyncSender<WriteCommand>,
    bytes_written: Arc<AtomicU64>,
    flushes: Arc<AtomicU64>,
    pending_bytes: Arc<AtomicU64>,
    thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl AsyncDiskWriter {
    pub fn new(paths: BTreeMap<u32, String>) -> Self {
        let (tx, rx) = mpsc::sync_channel(CHANNEL_BOUND);
        let bytes_written = Arc::new(AtomicU64::new(0));
        let flushes = Arc::new(AtomicU64::new(0));
        let pending_bytes = Arc::new(AtomicU64::new(0));

        let bw = bytes_written.clone();
        let fl = flushes.clone();
        let pb = pending_bytes.clone();

        let handle = std::thread::Builder::new()
            .name("nova-disk-writer".into())
            .spawn(move || {
                Self::writer_loop(rx, paths, bw, fl, pb);
            })
            .expect("failed to spawn disk writer thread");

        Self {
            tx,
            bytes_written,
            flushes,
            pending_bytes,
            thread_handle: Some(handle),
        }
    }

    pub fn write(&self, segment_id: u32, offset: u64, data: Vec<u8>) {
        let len = data.len() as u64;
        self.pending_bytes.fetch_add(len, Ordering::Relaxed);
        let _ = self.tx.send(WriteCommand::Data {
            segment_id,
            offset,
            data,
        });
    }

    pub fn flush(&self) {
        let _ = self.tx.send(WriteCommand::Flush);
    }

    pub fn shutdown(mut self) {
        let _ = self.tx.send(WriteCommand::Shutdown);
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }

    pub fn stats(&self) -> DiskWriterStats {
        DiskWriterStats {
            bytes_written: self.bytes_written.load(Ordering::Relaxed),
            flushes: self.flushes.load(Ordering::Relaxed),
            pending_bytes: self.pending_bytes.load(Ordering::Relaxed),
        }
    }

    pub fn bytes_written(&self) -> u64 {
        self.bytes_written.load(Ordering::Relaxed)
    }

    fn writer_loop(
        rx: mpsc::Receiver<WriteCommand>,
        paths: BTreeMap<u32, String>,
        bytes_written: Arc<AtomicU64>,
        flushes: Arc<AtomicU64>,
        pending_bytes: Arc<AtomicU64>,
    ) {
        let mut files: BTreeMap<u32, File> = BTreeMap::new();
        let mut needs_flush: bool = false;

        for (id, path) in &paths {
            if let Ok(file) = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(path)
            {
                files.insert(*id, file);
            }
        }

        let cfg = global_config();
        let mut batch: Vec<WriteCommand> = Vec::new();
        let mut last_flush = std::time::Instant::now();
        let flush_interval =
            std::time::Duration::from_millis(cfg.flush_interval_ms);

        loop {
            match rx.recv_timeout(flush_interval) {
                Ok(cmd) => match cmd {
                    WriteCommand::Data {
                        segment_id,
                        offset,
                        data,
                    } => {
                        batch.push(WriteCommand::Data {
                            segment_id,
                            offset,
                            data,
                        });
                        if batch.len() >= 16 {
                            Self::drain_batch(
                                &mut batch,
                                &mut files,
                                &bytes_written,
                                &pending_bytes,
                            );
                            needs_flush = true;
                        }
                    }
                    WriteCommand::Flush => {
                        Self::drain_batch(
                            &mut batch,
                            &mut files,
                            &bytes_written,
                            &pending_bytes,
                        );
                        for file in files.values_mut() {
                            let _ = file.flush();
                        }
                        flushes.fetch_add(1, Ordering::Relaxed);
                        needs_flush = false;
                    }
                    WriteCommand::Shutdown => {
                        Self::drain_batch(
                            &mut batch,
                            &mut files,
                            &bytes_written,
                            &pending_bytes,
                        );
                        for file in files.values_mut() {
                            let _ = file.flush();
                            let _ = file.sync_all();
                        }
                        break;
                    }
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    Self::drain_batch(
                        &mut batch,
                        &mut files,
                        &bytes_written,
                        &pending_bytes,
                    );
                    if needs_flush {
                        for file in files.values_mut() {
                            let _ = file.flush();
                        }
                        flushes.fetch_add(1, Ordering::Relaxed);
                        needs_flush = false;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    Self::drain_batch(
                        &mut batch,
                        &mut files,
                        &bytes_written,
                        &pending_bytes,
                    );
                    for file in files.values_mut() {
                        let _ = file.flush();
                        let _ = file.sync_all();
                    }
                    break;
                }
            }
        }
    }

    fn drain_batch(
        batch: &mut Vec<WriteCommand>,
        files: &mut BTreeMap<u32, File>,
        bytes_written: &AtomicU64,
        pending_bytes: &AtomicU64,
    ) {
        for cmd in batch.drain(..) {
            if let WriteCommand::Data {
                segment_id,
                offset,
                data,
            } = cmd
            {
                let len = data.len() as u64;
                if let Some(file) = files.get_mut(&segment_id) {
                    if file.seek(SeekFrom::Start(offset)).is_ok() {
                        if file.write_all(&data).is_ok() {
                            bytes_written.fetch_add(len, Ordering::Relaxed);
                        }
                    }
                }
                pending_bytes.fetch_sub(len, Ordering::Relaxed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::AtomicU32;
    use std::time::Duration;

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_paths(count: u32) -> BTreeMap<u32, String> {
        let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("nova_disk_test_{}_{}", std::process::id(), id));
        let _ = fs::create_dir_all(&dir);
        let mut map = BTreeMap::new();
        for i in 0..count {
            map.insert(i, dir.join(format!("seg_{}.bin", i)).to_string_lossy().to_string());
        }
        map
    }

    fn cleanup(paths: &BTreeMap<u32, String>) {
        for path in paths.values() {
            let _ = fs::remove_file(path);
        }
        if let Some(p) = paths.values().next() {
            if let Some(parent) = std::path::Path::new(p).parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }

    #[test]
    fn new_creates_writer() {
        let paths = temp_paths(1);
        let writer = AsyncDiskWriter::new(paths.clone());
        assert_eq!(writer.bytes_written(), 0);
        writer.shutdown();
        cleanup(&paths);
    }

    #[test]
    fn write_single_segment() {
        let paths = temp_paths(1);
        let writer = AsyncDiskWriter::new(paths.clone());
        writer.write(0, 0, b"hello world".to_vec());
        writer.flush();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(writer.bytes_written(), 11);
        writer.shutdown();
        let data = fs::read(paths.get(&0).unwrap()).unwrap();
        assert_eq!(data, b"hello world");
        cleanup(&paths);
    }

    #[test]
    fn write_multiple_segments() {
        let paths = temp_paths(3);
        let writer = AsyncDiskWriter::new(paths.clone());
        writer.write(0, 0, b"seg0".to_vec());
        writer.write(1, 0, b"seg1".to_vec());
        writer.write(2, 0, b"seg2".to_vec());
        writer.flush();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(writer.bytes_written(), 12);
        writer.shutdown();
        assert_eq!(fs::read(paths.get(&0).unwrap()).unwrap(), b"seg0");
        assert_eq!(fs::read(paths.get(&1).unwrap()).unwrap(), b"seg1");
        assert_eq!(fs::read(paths.get(&2).unwrap()).unwrap(), b"seg2");
        cleanup(&paths);
    }

    #[test]
    fn write_at_offset() {
        let paths = temp_paths(1);
        let writer = AsyncDiskWriter::new(paths.clone());
        writer.write(0, 0, b"AAAA".to_vec());
        writer.write(0, 2, b"BB".to_vec());
        writer.flush();
        std::thread::sleep(Duration::from_millis(50));
        writer.shutdown();
        let data = fs::read(paths.get(&0).unwrap()).unwrap();
        assert_eq!(data, b"AABB");
        cleanup(&paths);
    }

    #[test]
    fn stats_track_correctly() {
        let paths = temp_paths(1);
        let writer = AsyncDiskWriter::new(paths.clone());
        writer.write(0, 0, b"test data".to_vec());
        writer.flush();
        std::thread::sleep(Duration::from_millis(50));
        let stats = writer.stats();
        assert_eq!(stats.bytes_written, 9);
        assert!(stats.flushes >= 1);
        writer.shutdown();
        cleanup(&paths);
    }

    #[test]
    fn shutdown_waits_for_all_writes() {
        let paths = temp_paths(1);
        let writer = AsyncDiskWriter::new(paths.clone());
        for i in 0..100 {
            writer.write(0, i * 5, vec![i as u8; 5]);
        }
        writer.shutdown();
        let data = fs::read(paths.get(&0).unwrap()).unwrap();
        assert_eq!(data.len(), 500);
        cleanup(&paths);
    }
}
