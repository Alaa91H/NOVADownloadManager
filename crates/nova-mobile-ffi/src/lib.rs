//! Typed FFI boundary for NOVA mobile clients.
//!
//! The bridge deliberately starts with a versioned compatibility handshake.
//! It must not expose the desktop daemon, Axum routes, Tauri commands, or
//! arbitrary filesystem paths. Task operations are added only after the shared
//! core owns their durable semantics.

use curl::easy::Easy;
use std::time::Duration;

uniffi::setup_scaffolding!();

/// Increment when a bridge change is not backward compatible.
pub const BRIDGE_API_VERSION: u32 = 1;

/// Typed capability and compatibility information returned before a mobile
/// client creates a core session.
#[derive(uniffi::Record)]
pub struct BridgeInfo {
    pub bridge_api_version: u32,
    pub core_version: String,
    pub task_schema: String,
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

/// HTTP metadata collected by NOVA's native libcurl transport.
#[derive(Clone, Debug, Eq, PartialEq, uniffi::Record)]
pub struct HttpResourceProbe {
    pub response_status: u16,
    pub content_length: Option<u64>,
    pub effective_url: String,
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
}

fn transport_error(error: curl::Error) -> TransportError {
    TransportError::RequestFailed {
        message: error.to_string(),
    }
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
    easy.perform().map_err(transport_error)?;

    let status = easy.response_code().map_err(transport_error)?;
    let response_status = u16::try_from(status)
        .map_err(|_| TransportError::InvalidStatus { status })?;
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

    Ok(HttpResourceProbe {
        response_status,
        content_length,
        effective_url,
    })
}

/// Performs and validates an inclusive HTTP byte-range GET with native libcurl.
///
/// The payload is consumed inside Rust rather than copied through the FFI. This
/// primitive is the integrity gate used before the mobile bridge starts writing
/// segment payloads to durable storage: a server that ignores Range, omits or
/// lies about Content-Range, or returns the wrong number of bytes is rejected.
#[uniffi::export]
pub fn probe_http_range(
    url: String,
    start: u64,
    end: u64,
) -> Result<HttpRangeProbe, TransportError> {
    if end < start {
        return Err(TransportError::InvalidRange { start, end });
    }
    let expected_bytes = end
        .checked_sub(start)
        .and_then(|length| length.checked_add(1))
        .ok_or(TransportError::InvalidRange { start, end })?;

    let mut easy = Easy::new();
    easy.url(&url).map_err(transport_error)?;
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

    let mut content_range = None;
    let mut bytes_received = 0_u64;
    {
        let mut transfer = easy.transfer();
        transfer
            .header_function(|header| {
                if header.starts_with(b"HTTP/") {
                    content_range = None;
                } else if let Some(range) = parse_content_range(header) {
                    content_range = Some(range);
                }
                true
            })
            .map_err(transport_error)?;
        transfer
            .write_function(|data| {
                bytes_received = bytes_received.saturating_add(data.len() as u64);
                Ok(data.len())
            })
            .map_err(transport_error)?;
        transfer.perform().map_err(transport_error)?;
    }

    let status = easy.response_code().map_err(transport_error)?;
    let response_status = u16::try_from(status)
        .map_err(|_| TransportError::InvalidStatus { status })?;
    if response_status != 206 {
        return Err(TransportError::RangeResponseRejected {
            message: format!("expected HTTP 206 for bytes {start}-{end}, got {response_status}"),
        });
    }
    if content_range != Some((start, end)) {
        return Err(TransportError::RangeResponseRejected {
            message: format!(
                "expected Content-Range bytes {start}-{end}, got {:?}",
                content_range
            ),
        });
    }
    if bytes_received != expected_bytes {
        return Err(TransportError::RangeResponseRejected {
            message: format!(
                "expected {expected_bytes} payload bytes for {start}-{end}, got {bytes_received}"
            ),
        });
    }

    let effective_url = easy
        .effective_url()
        .map_err(transport_error)?
        .unwrap_or(&url)
        .to_owned();

    Ok(HttpRangeProbe {
        response_status,
        range_start: start,
        range_end: end,
        bytes_received,
        effective_url,
    })
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
                    b"HTTP/1.1 200 OK\r\nContent-Length: 12345\r\nConnection: close\r\n\r\n",
                )
                .expect("write probe response");
        });

        let url = format!("http://{address}/payload.bin");
        let probe = probe_http_resource(url.clone()).expect("native probe must succeed");
        server.join().expect("probe server thread");

        assert_eq!(probe.response_status, 200);
        assert_eq!(probe.content_length, Some(12_345));
        assert_eq!(probe.effective_url, url);
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
    fn native_range_probe_rejects_invalid_bounds() {
        assert!(matches!(
            probe_http_range("https://example.invalid".to_owned(), 9, 4),
            Err(TransportError::InvalidRange { start: 9, end: 4 })
        ));
    }

    #[test]
    fn android_primitive_handshake_is_fail_closed() {
        assert_eq!(android_initialize_status(BRIDGE_API_VERSION as i32), 1);
        assert_eq!(android_initialize_status(-1), -1);
        assert_eq!(android_initialize_status((BRIDGE_API_VERSION + 1) as i32), -1);
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
        assert_eq!(plan_http_resume(4096, 206, Some(4096)), ResumeAction::Append);
        assert_eq!(plan_http_resume(4096, 200, None), ResumeAction::Restart);
        assert_eq!(plan_http_resume(4096, 206, Some(2048)), ResumeAction::Restart);
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
