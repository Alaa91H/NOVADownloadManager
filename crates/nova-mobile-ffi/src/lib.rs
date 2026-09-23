//! Typed FFI boundary for NOVA mobile clients.
//!
//! The bridge deliberately starts with a versioned compatibility handshake.
//! It must not expose the desktop daemon, Axum routes, Tauri commands, or
//! arbitrary filesystem paths. Task operations are added only after the shared
//! core owns their durable semantics.

use curl::easy::Easy;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

uniffi::setup_scaffolding!();

/// Increment when a bridge change is not backward compatible.
pub const BRIDGE_API_VERSION: u32 = 3;

/// Typed capability and compatibility information returned before a mobile
/// client creates a core session.
#[derive(uniffi::Record)]
pub struct BridgeInfo {
    pub bridge_api_version: u32,
    pub core_version: String,
    pub task_schema: String,
    pub recovery_schema_version: u32,
}

/// Stable mobile projection of one inclusive shared-core byte range.
#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Record)]
pub struct TransferRange {
    pub start: u64,
    pub end: u64,
}

/// Stable mobile projection of the shared core's resume decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum ResumeAction {
    Append,
    Restart,
}


/// Process-local lifecycle state for a native Android transfer.
///
/// Durable restart metadata remains owned by the shared recovery contract; this
/// enum describes only the currently running native task instance.
#[derive(Clone, Copy, Debug, Eq, PartialEq, uniffi::Enum)]
pub enum NativeTransferStatus {
    Queued,
    Downloading,
    Completed,
    Failed,
    Cancelled,
}

impl NativeTransferStatus {
    fn code(self) -> u8 {
        match self {
            Self::Queued => 0,
            Self::Downloading => 1,
            Self::Completed => 2,
            Self::Failed => 3,
            Self::Cancelled => 4,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            0 => Self::Queued,
            1 => Self::Downloading,
            2 => Self::Completed,
            4 => Self::Cancelled,
            _ => Self::Failed,
        }
    }
}

/// Stable snapshot of one process-local native transfer.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct NativeTransferSnapshot {
    pub id: u64,
    pub status: NativeTransferStatus,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error_message: Option<String>,
}

struct NativeTransferTask {
    id: u64,
    status: AtomicU8,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
    cancel: AtomicBool,
    error_message: Mutex<Option<String>>,
}

impl NativeTransferTask {
    fn new(id: u64) -> Self {
        Self {
            id,
            status: AtomicU8::new(NativeTransferStatus::Queued.code()),
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            cancel: AtomicBool::new(false),
            error_message: Mutex::new(None),
        }
    }

    fn set_status(&self, status: NativeTransferStatus) {
        self.status.store(status.code(), Ordering::Release);
    }

    fn snapshot(&self) -> NativeTransferSnapshot {
        NativeTransferSnapshot {
            id: self.id,
            status: NativeTransferStatus::from_code(self.status.load(Ordering::Acquire)),
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Acquire),
            total_bytes: self.total_bytes.load(Ordering::Acquire),
            error_message: self.error_message.lock().ok().and_then(|value| value.clone()),
        }
    }
}

fn native_transfer_registry() -> &'static Mutex<HashMap<u64, Arc<NativeTransferTask>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Arc<NativeTransferTask>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_native_transfer_id() -> u64 {
    static NEXT_ID: OnceLock<AtomicU64> = OnceLock::new();
    let counter = NEXT_ID.get_or_init(|| {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        // Keep the sign bit clear so the identifier always fits Kotlin Long.
        let seed = (millis & ((1_u64 << 47) - 1)) << 16;
        AtomicU64::new(seed.max(1))
    });
    counter.fetch_add(1, Ordering::Relaxed)
}

/// HTTP metadata collected by NOVA's native libcurl transport.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct HttpResourceProbe {
    pub response_status: u16,
    pub content_length: Option<u64>,
    pub effective_url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// Stable FFI projection of the shared representation identity.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct RecoveryIdentity {
    pub effective_url: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_length: Option<u64>,
}

impl From<RecoveryIdentity> for nova_core_model::ResourceIdentity {
    fn from(value: RecoveryIdentity) -> Self {
        Self {
            effective_url: value.effective_url,
            etag: value.etag,
            last_modified: value.last_modified,
            content_length: value.content_length,
        }
    }
}

/// Result of a validated bounded ranged GET performed entirely by libcurl.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct HttpRangeProbe {
    pub response_status: u16,
    pub range_start: u64,
    pub range_end: u64,
    pub bytes_received: u64,
    pub effective_url: String,
}

/// A stable error for a client that was compiled against an incompatible bridge.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BridgeError {
    #[error("Android client bridge version {client_version} is incompatible with core version {core_version}")]
    IncompatibleVersion {
        client_version: u32,
        core_version: u32,
    },
}

/// Stable transport error projected across the mobile FFI boundary.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum TransportError {
    #[error("native HTTP transport failed: {message}")]
    RequestFailed { message: String },
    #[error("native HTTP transport returned an unsupported status value: {status}")]
    InvalidStatus { status: u32 },
    #[error("invalid inclusive byte range {start}-{end}")]
    InvalidRange { start: u64, end: u64 },
    #[error("native HTTP range response rejected: {message}")]
    RangeResponseRejected { message: String },
    #[error("native HTTP transfer was cancelled")]
    Cancelled,
}

fn transport_error(error: curl::Error) -> TransportError {
    TransportError::RequestFailed {
        message: error.to_string(),
    }
}

fn parse_http_status(header: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(header).ok()?.trim();
    if !line.starts_with("HTTP/") {
        return None;
    }
    line.split_whitespace().nth(1)?.parse().ok()
}

fn parse_content_length(header: &[u8]) -> Option<u64> {
    let line = std::str::from_utf8(header).ok()?.trim();
    let (name, value) = line.split_once(':')?;
    if !name.eq_ignore_ascii_case("content-length") {
        return None;
    }
    value.trim().parse().ok()
}

fn parse_content_range(header: &[u8]) -> Option<(u64, u64)> {
    let line = std::str::from_utf8(header).ok()?.trim();
    let (name, value) = line.split_once(':')?;
    if !name.eq_ignore_ascii_case("content-range") {
        return None;
    }

    let (unit, value) = value.trim().split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (bounds, _) = value.split_once('/')?;
    let (start, end) = bounds.split_once('-')?;
    Some((start.parse().ok()?, end.parse().ok()?))
}

fn stream_http_range<W: Write>(
    url: &str,
    start: u64,
    end: u64,
    sink: &mut W,
) -> Result<HttpRangeProbe, TransportError> {
    if end < start {
        return Err(TransportError::InvalidRange { start, end });
    }
    let expected_bytes = end
        .checked_sub(start)
        .and_then(|length| length.checked_add(1))
        .ok_or(TransportError::InvalidRange { start, end })?;

    let mut easy = Easy::new();
    easy.url(url).map_err(transport_error)?;
    easy.follow_location(true).map_err(transport_error)?;
    easy.max_redirections(10).map_err(transport_error)?;
    easy.connect_timeout(Duration::from_secs(15))
        .map_err(transport_error)?;
    easy.timeout(Duration::from_secs(30)).map_err(transport_error)?;
    easy.accept_encoding("identity").map_err(transport_error)?;
    easy.useragent(concat!("NOVA/", env!("CARGO_PKG_VERSION")))
        .map_err(transport_error)?;
    easy.range(&format!("{start}-{end}"))
        .map_err(transport_error)?;

    // libcurl reports every response header block, including redirects and
    // authentication negotiation. The body sink must remain closed until the
    // final response block proves both HTTP 206 and the exact requested range.
    let header_status = Cell::new(None::<u16>);
    let content_range = Cell::new(None::<(u64, u64)>);
    let headers_validated = Cell::new(false);
    let bytes_received = Cell::new(0_u64);
    let sink_error = RefCell::new(None::<String>);

    let perform_result = {
        let mut transfer = easy.transfer();
        transfer
            .header_function(|header| {
                if let Some(status) = parse_http_status(header) {
                    header_status.set(Some(status));
                    content_range.set(None);
                    headers_validated.set(false);
                } else if header == b"\r\n" || header == b"\n" {
                    headers_validated.set(
                        header_status.get() == Some(206)
                            && content_range.get() == Some((start, end)),
                    );
                } else if let Some(range) = parse_content_range(header) {
                    content_range.set(Some(range));
                }
                true
            })
            .map_err(transport_error)?;
        transfer
            .write_function(|data| {
                if !headers_validated.get() {
                    // Returning zero aborts the transfer before untrusted body
                    // bytes can reach a durable segment sink.
                    return Ok(0);
                }

                let Some(next_total) = bytes_received.get().checked_add(data.len() as u64) else {
                    sink_error.replace(Some("native range byte counter overflow".to_owned()));
                    return Ok(0);
                };
                if next_total > expected_bytes {
                    sink_error.replace(Some(format!(
                        "native range payload exceeded expected length {expected_bytes}"
                    )));
                    return Ok(0);
                }
                if let Err(error) = sink.write_all(data) {
                    sink_error.replace(Some(format!(
                        "failed to persist native range payload: {error}"
                    )));
                    return Ok(0);
                }

                bytes_received.set(next_total);
                Ok(data.len())
            })
            .map_err(transport_error)?;
        transfer.perform()
    };

    if !headers_validated.get() {
        return Err(TransportError::RangeResponseRejected {
            message: format!(
                "expected HTTP 206 with Content-Range bytes {start}-{end}, got status {:?} and range {:?}",
                header_status.get(),
                content_range.get()
            ),
        });
    }
    if let Some(message) = sink_error.into_inner() {
        return Err(TransportError::RequestFailed { message });
    }
    perform_result.map_err(transport_error)?;

    let status = easy.response_code().map_err(transport_error)?;
    let response_status =
        u16::try_from(status).map_err(|_| TransportError::InvalidStatus { status })?;
    if response_status != 206 {
        return Err(TransportError::RangeResponseRejected {
            message: format!("expected HTTP 206 for bytes {start}-{end}, got {response_status}"),
        });
    }
    if content_range.get() != Some((start, end)) {
        return Err(TransportError::RangeResponseRejected {
            message: format!(
                "expected Content-Range bytes {start}-{end}, got {:?}",
                content_range.get()
            ),
        });
    }
    if bytes_received.get() != expected_bytes {
        return Err(TransportError::RangeResponseRejected {
            message: format!(
                "expected {expected_bytes} payload bytes for {start}-{end}, got {}",
                bytes_received.get()
            ),
        });
    }

    let effective_url = easy
        .effective_url()
        .map_err(transport_error)?
        .unwrap_or(url)
        .to_owned();

    Ok(HttpRangeProbe {
        response_status,
        range_start: start,
        range_end: end,
        bytes_received: bytes_received.get(),
        effective_url,
    })
}

/// Streams one complete HTTP representation through native libcurl.
///
/// Intermediate redirect/auth bodies are discarded. Bytes are allowed into the
/// destination only after the final header block proves a normal 200 response,
/// preventing HTML error bodies or redirect pages from becoming downloads.
fn stream_http_download<W: Write>(
    url: &str,
    sink: &mut W,
    task: &NativeTransferTask,
) -> Result<HttpResourceProbe, TransportError> {
    let mut easy = Easy::new();
    easy.url(url).map_err(transport_error)?;
    easy.follow_location(true).map_err(transport_error)?;
    easy.max_redirections(10).map_err(transport_error)?;
    easy.connect_timeout(Duration::from_secs(15))
        .map_err(transport_error)?;
    easy.accept_encoding("identity").map_err(transport_error)?;
    easy.useragent(concat!("NOVA/", env!("CARGO_PKG_VERSION")))
        .map_err(transport_error)?;
    easy.progress(true).map_err(transport_error)?;

    let header_status = Cell::new(None::<u16>);
    let content_length = Cell::new(None::<u64>);
    let headers_validated = Cell::new(false);
    let validators = RefCell::new((None::<String>, None::<String>));
    let sink_error = RefCell::new(None::<String>);

    let perform_result = {
        let mut transfer = easy.transfer();
        transfer
            .header_function(|header| {
                if let Some(status) = parse_http_status(header) {
                    header_status.set(Some(status));
                    content_length.set(None);
                    headers_validated.set(false);
                    validators.replace((None, None));
                    return true;
                }

                if header == b"\r\n" || header == b"\n" {
                    let valid = header_status.get() == Some(200);
                    headers_validated.set(valid);
                    if valid {
                        if let Some(length) = content_length.get() {
                            task.total_bytes.store(length, Ordering::Release);
                        }
                    }
                    return true;
                }

                if let Some(length) = parse_content_length(header) {
                    content_length.set(Some(length));
                    return true;
                }

                if let Ok(line) = std::str::from_utf8(header) {
                    if let Some((name, value)) = line.trim().split_once(':') {
                        let mut identity = validators.borrow_mut();
                        if name.eq_ignore_ascii_case("etag") {
                            identity.0 = Some(value.trim().to_owned());
                        } else if name.eq_ignore_ascii_case("last-modified") {
                            identity.1 = Some(value.trim().to_owned());
                        }
                    }
                }
                true
            })
            .map_err(transport_error)?;

        transfer
            .write_function(|data| {
                if task.cancel.load(Ordering::Acquire) {
                    return Ok(0);
                }
                if !headers_validated.get() {
                    // libcurl may expose redirect/error response bodies before
                    // the final response is known. Consume and discard them.
                    return Ok(data.len());
                }

                if let Err(error) = sink.write_all(data) {
                    sink_error.replace(Some(format!(
                        "failed to persist native download payload: {error}"
                    )));
                    return Ok(0);
                }
                task.downloaded_bytes
                    .fetch_add(data.len() as u64, Ordering::Release);
                Ok(data.len())
            })
            .map_err(transport_error)?;

        transfer
            .progress_function(|download_total, _, _, _| {
                if headers_validated.get()
                    && download_total.is_finite()
                    && download_total > 0.0
                    && download_total <= u64::MAX as f64
                {
                    task.total_bytes
                        .store(download_total as u64, Ordering::Release);
                }
                task.cancel.load(Ordering::Acquire)
            })
            .map_err(transport_error)?;

        transfer.perform()
    };

    if task.cancel.load(Ordering::Acquire) {
        return Err(TransportError::Cancelled);
    }
    if let Some(message) = sink_error.into_inner() {
        return Err(TransportError::RequestFailed { message });
    }
    perform_result.map_err(transport_error)?;

    let status = easy.response_code().map_err(transport_error)?;
    let response_status =
        u16::try_from(status).map_err(|_| TransportError::InvalidStatus { status })?;
    if response_status != 200 || !headers_validated.get() {
        return Err(TransportError::RequestFailed {
            message: format!("expected final HTTP 200 response, got {response_status}"),
        });
    }

    let downloaded = task.downloaded_bytes.load(Ordering::Acquire);
    if let Some(expected) = content_length.get() {
        if downloaded != expected {
            return Err(TransportError::RequestFailed {
                message: format!(
                    "native download length mismatch: expected {expected} bytes, got {downloaded}"
                ),
            });
        }
    } else {
        task.total_bytes.store(downloaded, Ordering::Release);
    }

    let effective_url = easy
        .effective_url()
        .map_err(transport_error)?
        .unwrap_or(url)
        .to_owned();
    let (etag, last_modified) = validators.into_inner();

    Ok(HttpResourceProbe {
        response_status,
        content_length: content_length.get().or(Some(downloaded)),
        effective_url,
        etag,
        last_modified,
    })
}

fn run_native_http_transfer(
    url: String,
    mut destination: File,
    task: Arc<NativeTransferTask>,
) {
    task.set_status(NativeTransferStatus::Downloading);
    task.downloaded_bytes.store(0, Ordering::Release);
    task.total_bytes.store(0, Ordering::Release);

    let result = (|| -> Result<(), TransportError> {
        destination
            .set_len(0)
            .map_err(|error| TransportError::RequestFailed {
                message: format!("could not truncate native destination: {error}"),
            })?;
        destination
            .seek(SeekFrom::Start(0))
            .map_err(|error| TransportError::RequestFailed {
                message: format!("could not seek native destination: {error}"),
            })?;

        stream_http_download(&url, &mut destination, &task)?;
        destination
            .flush()
            .map_err(|error| TransportError::RequestFailed {
                message: format!("could not flush native destination: {error}"),
            })?;
        destination
            .sync_all()
            .map_err(|error| TransportError::RequestFailed {
                message: format!("could not sync native destination: {error}"),
            })?;
        Ok(())
    })();

    match result {
        Ok(()) => task.set_status(NativeTransferStatus::Completed),
        Err(TransportError::Cancelled) => task.set_status(NativeTransferStatus::Cancelled),
        Err(error) => {
            if let Ok(mut message) = task.error_message.lock() {
                *message = Some(error.to_string());
            }
            task.set_status(NativeTransferStatus::Failed);
        }
    }
}

fn start_native_http_transfer_with_file(
    url: String,
    destination: File,
) -> Result<u64, TransportError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(TransportError::RequestFailed {
            message: "native transfers accept only HTTP(S) URLs".to_owned(),
        });
    }

    let task_id = next_native_transfer_id();
    let task = Arc::new(NativeTransferTask::new(task_id));
    {
        let mut registry =
            native_transfer_registry()
                .lock()
                .map_err(|_| TransportError::RequestFailed {
                    message: "native transfer registry is unavailable".to_owned(),
                })?;
        registry.insert(task_id, task.clone());
    }

    let spawn = std::thread::Builder::new()
        .name(format!("nova-transfer-{task_id}"))
        .spawn(move || run_native_http_transfer(url, destination, task));

    if let Err(error) = spawn {
        if let Ok(mut registry) = native_transfer_registry().lock() {
            registry.remove(&task_id);
        }
        return Err(TransportError::RequestFailed {
            message: format!("could not start native transfer thread: {error}"),
        });
    }

    Ok(task_id)
}

/// Returns the latest process-local native transfer state.
#[uniffi::export]
pub fn native_transfer_snapshot(task_id: u64) -> Option<NativeTransferSnapshot> {
    native_transfer_registry()
        .lock()
        .ok()
        .and_then(|registry| registry.get(&task_id).cloned())
        .map(|task| task.snapshot())
}

/// Requests cancellation of a live native transfer.
#[uniffi::export]
pub fn cancel_native_transfer(task_id: u64) -> bool {
    let task = native_transfer_registry()
        .lock()
        .ok()
        .and_then(|registry| registry.get(&task_id).cloned());
    let Some(task) = task else {
        return false;
    };
    task.cancel.store(true, Ordering::Release);
    true
}

/// Releases a terminal task snapshot from the process-local registry.
#[uniffi::export]
pub fn forget_native_transfer(task_id: u64) -> bool {
    let Ok(mut registry) = native_transfer_registry().lock() else {
        return false;
    };
    let terminal = registry.get(&task_id).is_some_and(|task| {
        matches!(
            task.snapshot().status,
            NativeTransferStatus::Completed
                | NativeTransferStatus::Failed
                | NativeTransferStatus::Cancelled
        )
    });
    if terminal {
        registry.remove(&task_id);
    }
    terminal
}

/// Validates that a mobile client and the Rust core agree on the public bridge
/// contract before any task command is accepted.
#[uniffi::export]
pub fn initialize(client_bridge_api_version: u32) -> Result<BridgeInfo, BridgeError> {
    if client_bridge_api_version != BRIDGE_API_VERSION {
        return Err(BridgeError::IncompatibleVersion {
            client_version: client_bridge_api_version,
            core_version: BRIDGE_API_VERSION,
        });
    }

    Ok(BridgeInfo {
        bridge_api_version: BRIDGE_API_VERSION,
        core_version: env!("CARGO_PKG_VERSION").to_owned(),
        task_schema: "nova.task.v1".to_owned(),
        recovery_schema_version: nova_core_model::RECOVERY_SCHEMA_VERSION,
    })
}

/// Performs a bounded HTTP metadata probe with NOVA's bundled libcurl.
///
/// This is intentionally the first network operation exposed by the mobile
/// bridge: Android can discover the final URL, status, and remote size without
/// inventing a second HTTP stack. Identity encoding keeps metadata aligned with
/// the byte representation that subsequent Range requests address.
#[uniffi::export]
pub fn probe_http_resource(url: String) -> Result<HttpResourceProbe, TransportError> {
    let mut easy = Easy::new();
    easy.url(&url).map_err(transport_error)?;
    easy.nobody(true).map_err(transport_error)?;
    easy.follow_location(true).map_err(transport_error)?;
    easy.max_redirections(10).map_err(transport_error)?;
    easy.connect_timeout(Duration::from_secs(15))
        .map_err(transport_error)?;
    easy.timeout(Duration::from_secs(30)).map_err(transport_error)?;
    easy.accept_encoding("identity").map_err(transport_error)?;
    easy.useragent(concat!("NOVA/", env!("CARGO_PKG_VERSION")))
        .map_err(transport_error)?;

    // Keep only validators from the final response block. Redirect and auth
    // negotiation headers must never become the identity of the payload.
    let validators = Arc::new(Mutex::new((None::<String>, None::<String>)));
    let validators_for_headers = validators.clone();
    easy.header_function(move |header| {
        let Ok(line) = std::str::from_utf8(header) else {
            return true;
        };
        let line = line.trim();
        if line.starts_with("HTTP/") {
            if let Ok(mut state) = validators_for_headers.lock() {
                *state = (None, None);
            }
            return true;
        }
        let Some((name, value)) = line.split_once(':') else {
            return true;
        };
        if let Ok(mut state) = validators_for_headers.lock() {
            if name.eq_ignore_ascii_case("etag") {
                state.0 = Some(value.trim().to_owned());
            } else if name.eq_ignore_ascii_case("last-modified") {
                state.1 = Some(value.trim().to_owned());
            }
        }
        true
    })
    .map_err(transport_error)?;

    easy.perform().map_err(transport_error)?;

    let status = easy.response_code().map_err(transport_error)?;
    let response_status =
        u16::try_from(status).map_err(|_| TransportError::InvalidStatus { status })?;
    #[allow(deprecated)]
    let reported_length = easy.content_length_download().map_err(transport_error)?;
    let content_length = if reported_length.is_finite()
        && reported_length >= 0.0
        && reported_length <= u64::MAX as f64
    {
        Some(reported_length as u64)
    } else {
        None
    };
    let effective_url = easy
        .effective_url()
        .map_err(transport_error)?
        .unwrap_or(&url)
        .to_owned();

    let (etag, last_modified) = validators
        .lock()
        .map(|state| state.clone())
        .unwrap_or((None, None));

    Ok(HttpResourceProbe {
        response_status,
        content_length,
        effective_url,
        etag,
        last_modified,
    })
}

/// Performs and validates an inclusive HTTP byte-range GET with native libcurl.
///
/// Payload bytes stay inside Rust and are streamed through the same guarded sink
/// that durable Android segment storage will use. The public probe intentionally
/// discards the bytes while exercising the exact production validation path.
#[uniffi::export]
pub fn probe_http_range(
    url: String,
    start: u64,
    end: u64,
) -> Result<HttpRangeProbe, TransportError> {
    let mut sink = std::io::sink();
    stream_http_range(&url, start, end, &mut sink)
}

/// Plans balanced inclusive byte ranges using the same platform-neutral policy
/// consumed by NOVA's native transfer engine.
///
/// Mobile lifecycle code may request fewer connections for battery/network
/// policy, but it must not invent a separate segmentation algorithm.
#[uniffi::export]
pub fn plan_transfer_ranges(total_bytes: u64, requested_connections: u32) -> Vec<TransferRange> {
    nova_core_model::plan_byte_ranges(total_bytes, requested_connections)
        .into_iter()
        .map(|range| TransferRange {
            start: range.start,
            end: range.end,
        })
        .collect()
}

/// Applies the same resume-corruption policy used by the shared NOVA core.
///
/// Transports (libcurl on the native path, or another host integration) must not
/// append response bytes until this returns `Append`. This keeps Android and
/// desktop aligned on range semantics while the mobile transport migration is
/// completed incrementally.
#[uniffi::export]
pub fn plan_http_resume(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
) -> ResumeAction {
    match nova_core_model::plan_http_resume(existing_bytes, response_status, content_range_start) {
        nova_core_model::ResumeAction::Append => ResumeAction::Append,
        nova_core_model::ResumeAction::Restart => ResumeAction::Restart,
    }
}

/// Applies NOVA's validator-aware crash-recovery policy.
///
/// Once a checkpoint has ETag/Last-Modified/size evidence, Android and desktop
/// both require that evidence to be re-confirmed before appending to disk.
#[uniffi::export]
pub fn plan_http_recovery(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
    previous: RecoveryIdentity,
    current: RecoveryIdentity,
) -> ResumeAction {
    let previous: nova_core_model::ResourceIdentity = previous.into();
    let current: nova_core_model::ResourceIdentity = current.into();
    match nova_core_model::plan_http_recovery(
        existing_bytes,
        response_status,
        content_range_start,
        &previous,
        &current,
    ) {
        nova_core_model::ResumeAction::Append => ResumeAction::Append,
        nova_core_model::ResumeAction::Restart => ResumeAction::Restart,
    }
}

/// Narrow primitive used by Android before the generated high-level task API is
/// activated. Keeping this handshake primitive means the APK can prove that the
/// packaged Rust library is present and ABI-compatible without introducing a
/// second Kotlin implementation of the NOVA task contract.
fn android_initialize_status(client_bridge_api_version: i32) -> i32 {
    let Ok(client_version) = u32::try_from(client_bridge_api_version) else {
        return -1;
    };

    initialize(client_version)
        .map(|info| i32::try_from(info.bridge_api_version).unwrap_or(-1))
        .unwrap_or(-1)
}

/// JNI-safe projection of the shared range planner.
///
/// Returns the planned number of segments or -1 for invalid JNI inputs.
fn android_plan_segment_count(total_bytes: i64, requested_connections: i32) -> i32 {
    let Ok(total_bytes) = u64::try_from(total_bytes) else {
        return -1;
    };
    let Ok(requested_connections) = u32::try_from(requested_connections) else {
        return -1;
    };

    i32::try_from(plan_transfer_ranges(total_bytes, requested_connections).len()).unwrap_or(-1)
}

/// Returns one inclusive range bound from the shared planner.
///
/// `bound` is 0 for start and 1 for end. Returns -1 for invalid inputs or an
/// out-of-bounds segment index.
fn android_plan_segment_bound(
    total_bytes: i64,
    requested_connections: i32,
    segment_index: i32,
    bound: i32,
) -> i64 {
    let Ok(total_bytes) = u64::try_from(total_bytes) else {
        return -1;
    };
    let Ok(requested_connections) = u32::try_from(requested_connections) else {
        return -1;
    };
    let Ok(segment_index) = usize::try_from(segment_index) else {
        return -1;
    };

    let Some(range) = plan_transfer_ranges(total_bytes, requested_connections)
        .get(segment_index)
        .copied()
    else {
        return -1;
    };
    let value = match bound {
        0 => range.start,
        1 => range.end,
        _ => return -1,
    };

    i64::try_from(value).unwrap_or(-1)
}

/// JNI-safe projection of the shared resume policy.
///
/// `content_range_start` uses `-1` to represent an absent `Content-Range` start.
/// Returns 0 for append, 1 for restart, and -1 for invalid JNI inputs.
fn android_plan_http_resume_status(
    existing_bytes: i64,
    response_status: i32,
    content_range_start: i64,
) -> i32 {
    let Ok(existing_bytes) = u64::try_from(existing_bytes) else {
        return -1;
    };
    let Ok(response_status) = u16::try_from(response_status) else {
        return -1;
    };
    let content_range_start = if content_range_start == -1 {
        None
    } else {
        let Ok(start) = u64::try_from(content_range_start) else {
            return -1;
        };
        Some(start)
    };

    match plan_http_resume(existing_bytes, response_status, content_range_start) {
        ResumeAction::Append => 0,
        ResumeAction::Restart => 1,
    }
}

fn android_native_transfer_status(task_id: i64) -> i32 {
    let Ok(task_id) = u64::try_from(task_id) else {
        return -1;
    };
    native_transfer_snapshot(task_id)
        .map(|snapshot| i32::from(snapshot.status.code()))
        .unwrap_or(-1)
}

fn android_native_transfer_bytes(task_id: i64, total: bool) -> i64 {
    let Ok(task_id) = u64::try_from(task_id) else {
        return -1;
    };
    let Some(snapshot) = native_transfer_snapshot(task_id) else {
        return -1;
    };
    let value = if total {
        snapshot.total_bytes
    } else {
        snapshot.downloaded_bytes
    };
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn android_cancel_native_transfer(task_id: i64) -> i32 {
    let Ok(task_id) = u64::try_from(task_id) else {
        return -1;
    };
    if cancel_native_transfer(task_id) { 1 } else { 0 }
}

fn android_forget_native_transfer(task_id: i64) -> i32 {
    let Ok(task_id) = u64::try_from(task_id) else {
        return -1;
    };
    if forget_native_transfer(task_id) { 1 } else { 0 }
}

#[cfg(target_os = "android")]
fn android_start_native_http_transfer(url: String, destination_fd: i32) -> i64 {
    use std::os::fd::FromRawFd;

    if destination_fd < 0 {
        return -1;
    }

    // Android owns the ParcelFileDescriptor passed across JNI. Duplicate it
    // before returning so Kotlin can close its descriptor immediately while
    // the native worker retains an independent lifetime.
    let duplicated_fd = unsafe { libc::dup(destination_fd) };
    if duplicated_fd < 0 {
        return -1;
    }
    let destination = unsafe { File::from_raw_fd(duplicated_fd) };
    start_native_http_transfer_with_file(url, destination)
        .ok()
        .and_then(|id| i64::try_from(id).ok())
        .unwrap_or(-1)
}

/// JNI entry point used by `NovaNativeCore` on Android.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeInitialize(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    client_bridge_api_version: i32,
) -> i32 {
    android_initialize_status(client_bridge_api_version)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanSegmentCount(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    total_bytes: i64,
    requested_connections: i32,
) -> i32 {
    android_plan_segment_count(total_bytes, requested_connections)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanSegmentStart(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    total_bytes: i64,
    requested_connections: i32,
    segment_index: i32,
) -> i64 {
    android_plan_segment_bound(total_bytes, requested_connections, segment_index, 0)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanSegmentEnd(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    total_bytes: i64,
    requested_connections: i32,
    segment_index: i32,
) -> i64 {
    android_plan_segment_bound(total_bytes, requested_connections, segment_index, 1)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativePlanHttpResume(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    existing_bytes: i64,
    response_status: i32,
    content_range_start: i64,
) -> i32 {
    android_plan_http_resume_status(existing_bytes, response_status, content_range_start)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeStartHttpTransfer(
    mut env: jni::JNIEnv<'_>,
    _receiver: jni::objects::JObject<'_>,
    url: jni::objects::JString<'_>,
    destination_fd: jni::sys::jint,
) -> jni::sys::jlong {
    let Ok(url) = env.get_string(&url) else {
        return -1;
    };
    android_start_native_http_transfer(url.into(), destination_fd)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeTransferStatus(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    task_id: i64,
) -> i32 {
    android_native_transfer_status(task_id)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeTransferDownloadedBytes(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    task_id: i64,
) -> i64 {
    android_native_transfer_bytes(task_id, false)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeTransferTotalBytes(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    task_id: i64,
) -> i64 {
    android_native_transfer_bytes(task_id, true)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeCancelTransfer(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    task_id: i64,
) -> i32 {
    android_cancel_native_transfer(task_id)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nova_downloadmanager_core_NovaNativeCore_nativeForgetTransfer(
    _env: *mut core::ffi::c_void,
    _receiver: *mut core::ffi::c_void,
    task_id: i64,
) -> i32 {
    android_forget_native_transfer(task_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn initialize_accepts_current_bridge_version() {
        let info = initialize(BRIDGE_API_VERSION).expect("current bridge version must initialize");
        assert_eq!(info.bridge_api_version, BRIDGE_API_VERSION);
        assert_eq!(info.task_schema, "nova.task.v1");
        assert_eq!(
            info.recovery_schema_version,
            nova_core_model::RECOVERY_SCHEMA_VERSION
        );
    }

    #[test]
    fn initialize_rejects_incompatible_bridge_version() {
        let result = initialize(BRIDGE_API_VERSION + 1);
        assert!(matches!(
            result,
            Err(BridgeError::IncompatibleVersion {
                client_version,
                core_version,
            }) if client_version == BRIDGE_API_VERSION + 1 && core_version == BRIDGE_API_VERSION
        ));
    }

    #[test]
    fn native_probe_uses_libcurl_head_and_reports_metadata() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe server");
        let address = listener.local_addr().expect("probe server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read probe request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("HEAD /payload.bin HTTP/"));
            assert!(request.contains("Accept-Encoding: identity"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 12345\r\nETag: \"nova-v1\"\r\nLast-Modified: Wed, 21 Oct 2015 07:28:00 GMT\r\nConnection: close\r\n\r\n",
                )
                .expect("write probe response");
        });

        let url = format!("http://{address}/payload.bin");
        let probe = probe_http_resource(url.clone()).expect("native probe must succeed");
        server.join().expect("probe server thread");

        assert_eq!(probe.response_status, 200);
        assert_eq!(probe.content_length, Some(12_345));
        assert_eq!(probe.effective_url, url);
        assert_eq!(probe.etag.as_deref(), Some("\"nova-v1\""));
        assert_eq!(
            probe.last_modified.as_deref(),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        );
    }

    #[test]
    fn native_full_download_stream_writes_only_final_success_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind download server");
        let address = listener.local_addr().expect("download server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept download connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read download request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /payload.bin HTTP/"));
            assert!(!request.contains("Range:"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: \"native-v1\"\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write download response");
        });

        let task = NativeTransferTask::new(7);
        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let probe =
            stream_http_download(&url, &mut payload, &task).expect("native download must succeed");
        server.join().expect("download server thread");

        assert_eq!(payload, b"abcdefgh");
        assert_eq!(task.downloaded_bytes.load(Ordering::Acquire), 8);
        assert_eq!(task.total_bytes.load(Ordering::Acquire), 8);
        assert_eq!(probe.etag.as_deref(), Some("\"native-v1\""));
    }

    #[test]
    fn native_full_download_never_persists_http_error_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind error server");
        let address = listener.local_addr().expect("error server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept error connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read error request");
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot-found",
                )
                .expect("write error response");
        });

        let task = NativeTransferTask::new(8);
        let url = format!("http://{address}/missing.bin");
        let mut payload = Vec::new();
        let result = stream_http_download(&url, &mut payload, &task);
        server.join().expect("error server thread");

        assert!(matches!(result, Err(TransportError::RequestFailed { .. })));
        assert!(payload.is_empty(), "HTTP error body must never reach the file");
        assert_eq!(task.downloaded_bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn native_transfer_manager_reports_completion_and_can_forget_task() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind task server");
        let address = listener.local_addr().expect("task server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept task connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read task request");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nnative",
                )
                .expect("write task response");
        });

        let path = std::env::temp_dir().join(format!(
            "nova-native-transfer-{}-{}.bin",
            std::process::id(),
            next_native_transfer_id()
        ));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&path)
            .expect("open native task output");
        let url = format!("http://{address}/payload.bin");
        let task_id =
            start_native_http_transfer_with_file(url, file).expect("start native transfer");

        let mut final_snapshot = None;
        for _ in 0..200 {
            let snapshot = native_transfer_snapshot(task_id).expect("native task snapshot");
            if matches!(
                snapshot.status,
                NativeTransferStatus::Completed
                    | NativeTransferStatus::Failed
                    | NativeTransferStatus::Cancelled
            ) {
                final_snapshot = Some(snapshot);
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        server.join().expect("task server thread");

        let snapshot = final_snapshot.expect("native task must reach a terminal state");
        assert_eq!(snapshot.status, NativeTransferStatus::Completed);
        assert_eq!(snapshot.downloaded_bytes, 6);
        assert_eq!(snapshot.total_bytes, 6);
        assert_eq!(std::fs::read(&path).expect("read native output"), b"native");
        assert!(forget_native_transfer(task_id));
        assert!(native_transfer_snapshot(task_id).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_range_probe_validates_partial_content() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /payload.bin HTTP/"));
            assert!(request.contains("Range: bytes=2-5"));
            assert!(request.contains("Accept-Encoding: identity"));
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-5/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\ncdef",
                )
                .expect("write range response");
        });

        let url = format!("http://{address}/payload.bin");
        let probe = probe_http_range(url.clone(), 2, 5).expect("valid range must succeed");
        server.join().expect("range server thread");

        assert_eq!(probe.response_status, 206);
        assert_eq!(probe.range_start, 2);
        assert_eq!(probe.range_end, 5);
        assert_eq!(probe.bytes_received, 4);
        assert_eq!(probe.effective_url, url);
    }

    #[test]
    fn native_range_stream_writes_only_validated_payload() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("Range: bytes=2-5"));
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-5/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\ncdef",
                )
                .expect("write range response");
        });

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let probe = stream_http_range(&url, 2, 5, &mut payload)
            .expect("validated native range stream must succeed");
        server.join().expect("range server thread");

        assert_eq!(probe.bytes_received, 4);
        assert_eq!(payload, b"cdef");
    }

    #[test]
    fn native_range_probe_rejects_server_ignoring_range() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let read = stream.read(&mut request).expect("read range request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("Range: bytes=2-5"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write ignored-range response");
        });

        let url = format!("http://{address}/payload.bin");
        let result = probe_http_range(url, 2, 5);
        server.join().expect("range server thread");

        assert!(matches!(
            result,
            Err(TransportError::RangeResponseRejected { .. })
        ));
    }

    #[test]
    fn native_range_stream_does_not_write_ignored_range_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read range request");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write ignored-range response");
        });

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let result = stream_http_range(&url, 2, 5, &mut payload);
        server.join().expect("range server thread");

        assert!(matches!(
            result,
            Err(TransportError::RangeResponseRejected { .. })
        ));
        assert!(payload.is_empty(), "rejected body must never reach the sink");
    }

    #[test]
    fn native_range_stream_does_not_write_mismatched_content_range() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind range server");
        let address = listener.local_addr().expect("range server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept range connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).expect("read range request");
            stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-4/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbcde",
                )
                .expect("write mismatched range response");
        });

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let result = stream_http_range(&url, 2, 5, &mut payload);
        server.join().expect("range server thread");

        assert!(matches!(
            result,
            Err(TransportError::RangeResponseRejected { .. })
        ));
        assert!(payload.is_empty(), "mismatched range must never reach the sink");
    }

    #[test]
    fn native_range_probe_rejects_invalid_bounds() {
        assert!(matches!(
            probe_http_range("https://example.invalid".to_owned(), 9, 4),
            Err(TransportError::InvalidRange { start: 9, end: 4 })
        ));
    }

    #[test]
    fn android_primitive_handshake_is_fail_closed() {
        assert_eq!(
            android_initialize_status(BRIDGE_API_VERSION as i32),
            BRIDGE_API_VERSION as i32
        );
        assert_eq!(android_initialize_status(-1), -1);
        assert_eq!(
            android_initialize_status((BRIDGE_API_VERSION + 1) as i32),
            -1
        );
    }

    #[test]
    fn ffi_range_plan_matches_shared_core() {
        assert_eq!(
            plan_transfer_ranges(10, 3),
            vec![
                TransferRange { start: 0, end: 3 },
                TransferRange { start: 4, end: 6 },
                TransferRange { start: 7, end: 9 },
            ]
        );
    }

    #[test]
    fn android_range_primitives_project_shared_plan() {
        assert_eq!(android_plan_segment_count(10, 3), 3);
        assert_eq!(android_plan_segment_bound(10, 3, 0, 0), 0);
        assert_eq!(android_plan_segment_bound(10, 3, 0, 1), 3);
        assert_eq!(android_plan_segment_bound(10, 3, 2, 0), 7);
        assert_eq!(android_plan_segment_bound(10, 3, 2, 1), 9);
    }

    #[test]
    fn android_range_primitives_reject_invalid_inputs() {
        assert_eq!(android_plan_segment_count(-1, 4), -1);
        assert_eq!(android_plan_segment_count(10, -1), -1);
        assert_eq!(android_plan_segment_bound(10, 3, -1, 0), -1);
        assert_eq!(android_plan_segment_bound(10, 3, 3, 0), -1);
        assert_eq!(android_plan_segment_bound(10, 3, 0, 2), -1);
    }

    #[test]
    fn ffi_resume_policy_matches_shared_core() {
        assert_eq!(
            plan_http_resume(4096, 206, Some(4096)),
            ResumeAction::Append
        );
        assert_eq!(plan_http_resume(4096, 200, None), ResumeAction::Restart);
        assert_eq!(
            plan_http_resume(4096, 206, Some(2048)),
            ResumeAction::Restart
        );
    }

    #[test]
    fn android_resume_primitive_projects_shared_policy() {
        assert_eq!(android_plan_http_resume_status(4096, 206, 4096), 0);
        assert_eq!(android_plan_http_resume_status(4096, 200, -1), 1);
        assert_eq!(android_plan_http_resume_status(4096, 206, 2048), 1);
    }

    #[test]
    fn android_resume_primitive_rejects_invalid_jni_inputs() {
        assert_eq!(android_plan_http_resume_status(-1, 206, 0), -1);
        assert_eq!(android_plan_http_resume_status(0, -1, -1), -1);
        assert_eq!(android_plan_http_resume_status(0, 70_000, -1), -1);
        assert_eq!(android_plan_http_resume_status(4096, 206, -2), -1);
    }
}
