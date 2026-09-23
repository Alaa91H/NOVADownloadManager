use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nova_core_model::{plan_byte_ranges, ByteRange};

use super::{probe_http_range, probe_http_resource, stream_http_full, stream_http_range_for_download};

pub const STATUS_QUEUED: u8 = 0;
pub const STATUS_DOWNLOADING: u8 = 1;
pub const STATUS_COMPLETED: u8 = 2;
pub const STATUS_FAILED: u8 = 3;

const MAX_SEGMENT_ATTEMPTS: usize = 4;
const RETRY_BASE_DELAY_MS: u64 = 250;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeTransferSnapshot {
    pub status: u8,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub active_segments: u32,
}

struct NativeTransferTask {
    status: AtomicU8,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
    active_segments: AtomicU32,
}

impl NativeTransferTask {
    fn new() -> Self {
        Self {
            status: AtomicU8::new(STATUS_QUEUED),
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            active_segments: AtomicU32::new(0),
        }
    }

    fn snapshot(&self) -> NativeTransferSnapshot {
        NativeTransferSnapshot {
            status: self.status.load(Ordering::Acquire),
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Relaxed),
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
            active_segments: self.active_segments.load(Ordering::Relaxed),
        }
    }
}

fn registry() -> &'static Mutex<HashMap<u64, Arc<NativeTransferTask>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Arc<NativeTransferTask>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn allocate_task_id(tasks: &HashMap<u64, Arc<NativeTransferTask>>) -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut candidate = (nanos & i64::MAX as u128) as u64;
    if candidate == 0 {
        candidate = 1;
    }
    while tasks.contains_key(&candidate) {
        candidate = candidate.saturating_add(1).max(1);
    }
    candidate
}

pub fn start_download(
    url: String,
    file: File,
    requested_connections: u32,
) -> Result<u64, String> {
    let task = Arc::new(NativeTransferTask::new());
    let task_id = {
        let mut tasks = registry()
            .lock()
            .map_err(|_| "NOVA native transfer registry is poisoned".to_owned())?;
        let id = allocate_task_id(&tasks);
        tasks.insert(id, Arc::clone(&task));
        id
    };

    let thread_task = Arc::clone(&task);
    let spawn_result = thread::Builder::new()
        .name(format!("nova-transfer-{task_id}"))
        .spawn(move || {
            thread_task.status.store(STATUS_DOWNLOADING, Ordering::Release);
            let result = perform_download(&url, file, requested_connections, &thread_task);
            thread_task.active_segments.store(0, Ordering::Release);
            thread_task.status.store(
                if result.is_ok() {
                    STATUS_COMPLETED
                } else {
                    STATUS_FAILED
                },
                Ordering::Release,
            );
        });

    if let Err(error) = spawn_result {
        if let Ok(mut tasks) = registry().lock() {
            tasks.remove(&task_id);
        }
        return Err(format!("could not spawn NOVA native transfer worker: {error}"));
    }

    Ok(task_id)
}

pub fn query_download(task_id: u64) -> Option<NativeTransferSnapshot> {
    registry()
        .lock()
        .ok()?
        .get(&task_id)
        .map(|task| task.snapshot())
}

fn perform_download(
    url: &str,
    mut file: File,
    requested_connections: u32,
    task: &Arc<NativeTransferTask>,
) -> Result<(), String> {
    let probe = probe_http_resource(url.to_owned()).map_err(|error| error.to_string())?;
    if !(200..400).contains(&probe.response_status) {
        return Err(format!(
            "NOVA native transfer source returned HTTP {}",
            probe.response_status
        ));
    }

    let total_bytes = probe.content_length.unwrap_or(0);
    task.total_bytes.store(total_bytes, Ordering::Relaxed);

    let supports_ranges = total_bytes > 0 && probe_http_range(url.to_owned(), 0, 0).is_ok();
    if !supports_ranges {
        task.active_segments.store(1, Ordering::Relaxed);
        file.set_len(0)
            .map_err(|error| format!("could not truncate native destination: {error}"))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| format!("could not seek native destination: {error}"))?;
        let mut writer = SequentialProgressWriter::new(file, Arc::clone(task));
        let received = stream_http_full(url, &mut writer).map_err(|error| error.to_string())?;
        if total_bytes > 0 && received != total_bytes {
            return Err(format!(
                "native full transfer length mismatch: expected {total_bytes}, got {received}"
            ));
        }
        writer
            .sync_all()
            .map_err(|error| format!("could not sync native destination: {error}"))?;
        return Ok(());
    }

    file.set_len(total_bytes)
        .map_err(|error| format!("could not size native destination: {error}"))?;
    let ranges = plan_byte_ranges(total_bytes, requested_connections.max(1));
    task.active_segments
        .store(ranges.len() as u32, Ordering::Relaxed);

    let mut workers = Vec::with_capacity(ranges.len());
    for range in ranges {
        let segment_file = file
            .try_clone()
            .map_err(|error| format!("could not clone native destination: {error}"))?;
        let segment_url = url.to_owned();
        let segment_task = Arc::clone(task);
        workers.push(
            thread::Builder::new()
                .name(format!("nova-segment-{}-{}", range.start, range.end))
                .spawn(move || {
                    let result = download_range_with_retries(
                        &segment_url,
                        range,
                        segment_file,
                        &segment_task,
                    );
                    segment_task.active_segments.fetch_sub(1, Ordering::AcqRel);
                    result
                })
                .map_err(|error| format!("could not spawn NOVA segment worker: {error}"))?,
        );
    }

    let mut first_error = None;
    for worker in workers {
        match worker.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
            Err(_) => {
                if first_error.is_none() {
                    first_error = Some("NOVA segment worker panicked".to_owned());
                }
            }
        }
    }
    if let Some(error) = first_error {
        return Err(error);
    }

    file.sync_all()
        .map_err(|error| format!("could not sync native destination: {error}"))?;
    Ok(())
}

fn download_range_with_retries(
    url: &str,
    range: ByteRange,
    file: File,
    task: &Arc<NativeTransferTask>,
) -> Result<(), String> {
    let total = range.len();
    let mut completed = 0_u64;

    for attempt in 0..MAX_SEGMENT_ATTEMPTS {
        if completed >= total {
            return Ok(());
        }

        let start = range.start + completed;
        let mut writer = OffsetProgressWriter::new(
            file.try_clone()
                .map_err(|error| format!("could not clone segment destination: {error}"))?,
            start,
            Arc::clone(task),
        );

        match stream_http_range_for_download(url, start, range.end, &mut writer) {
            Ok(_) => {
                completed = completed.saturating_add(writer.written());
                if completed == total {
                    return Ok(());
                }
            }
            Err(error) => {
                completed = completed.saturating_add(writer.written());
                if completed >= total {
                    return Ok(());
                }
                if attempt + 1 == MAX_SEGMENT_ATTEMPTS {
                    return Err(format!(
                        "segment {}-{} failed after {} attempts: {error}",
                        range.start,
                        range.end,
                        MAX_SEGMENT_ATTEMPTS
                    ));
                }
                let backoff = RETRY_BASE_DELAY_MS.saturating_mul(1_u64 << attempt.min(4));
                thread::sleep(Duration::from_millis(backoff));
            }
        }
    }

    Err(format!(
        "segment {}-{} ended before all bytes were persisted",
        range.start, range.end
    ))
}

struct SequentialProgressWriter {
    file: File,
    task: Arc<NativeTransferTask>,
}

impl SequentialProgressWriter {
    fn new(file: File, task: Arc<NativeTransferTask>) -> Self {
        Self { file, task }
    }

    fn sync_all(&self) -> io::Result<()> {
        self.file.sync_all()
    }
}

impl Write for SequentialProgressWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        self.task
            .downloaded_bytes
            .fetch_add(written as u64, Ordering::Relaxed);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

struct OffsetProgressWriter {
    file: File,
    offset: u64,
    written: u64,
    task: Arc<NativeTransferTask>,
}

impl OffsetProgressWriter {
    fn new(file: File, offset: u64, task: Arc<NativeTransferTask>) -> Self {
        Self {
            file,
            offset,
            written: 0,
            task,
        }
    }

    const fn written(&self) -> u64 {
        self.written
    }
}

impl Write for OffsetProgressWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = write_at(&self.file, buf, self.offset)?;
        self.offset = self.offset.saturating_add(written as u64);
        self.written = self.written.saturating_add(written as u64);
        self.task
            .downloaded_bytes
            .fetch_add(written as u64, Ordering::Relaxed);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(unix)]
fn write_at(file: &File, buf: &[u8], offset: u64) -> io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.write_at(buf, offset)
}

#[cfg(windows)]
fn write_at(file: &File, buf: &[u8], offset: u64) -> io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_write(buf, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;

    fn test_file(name: &str) -> (PathBuf, File) {
        let path = std::env::temp_dir().join(format!(
            "nova-mobile-{name}-{}-{}.bin",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let file = File::create(&path).expect("create temp output");
        (path, file)
    }

    #[test]
    fn native_task_downloads_segmented_resource() {
        let payload = b"abcdefgh";
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind server");
        let address = listener.local_addr().expect("server address");
        let server = thread::spawn(move || {
            let mut handlers = Vec::new();
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("accept request");
                handlers.push(thread::spawn(move || {
                    let mut request = [0_u8; 4096];
                    let read = stream.read(&mut request).expect("read request");
                    let request = String::from_utf8_lossy(&request[..read]);

                    if request.starts_with("HEAD ") {
                        stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            )
                            .expect("write HEAD response");
                        return;
                    }

                    let range = request
                        .lines()
                        .find_map(|line| line.strip_prefix("Range: bytes="))
                        .expect("range header");
                    let (start, end) = range.split_once('-').expect("range bounds");
                    let start: usize = start.parse().expect("range start");
                    let end: usize = end.parse().expect("range end");
                    let body = &payload[start..=end];
                    let response = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).expect("write headers");
                    stream.write_all(body).expect("write body");
                }));
            }
            for handler in handlers {
                handler.join().expect("request handler");
            }
        });

        let (path, file) = test_file("segmented");
        let id = start_download(format!("http://{address}/payload.bin"), file, 2)
            .expect("start native transfer");

        let snapshot = loop {
            let snapshot = query_download(id).expect("registered native task");
            if snapshot.status == STATUS_COMPLETED || snapshot.status == STATUS_FAILED {
                break snapshot;
            }
            thread::sleep(Duration::from_millis(20));
        };
        server.join().expect("server thread");

        assert_eq!(snapshot.status, STATUS_COMPLETED);
        assert_eq!(snapshot.downloaded_bytes, 8);
        assert_eq!(snapshot.total_bytes, 8);
        assert_eq!(std::fs::read(&path).expect("read output"), payload);
        let _ = std::fs::remove_file(path);
    }
}
