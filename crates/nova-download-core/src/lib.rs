//! Platform-neutral NOVA download transport and transfer planning.
//!
//! This crate is shared by desktop and mobile hosts. It deliberately owns no
//! Tauri, Axum, Android, JNI, Compose, notification, or storage-provider types.

use curl::easy::Easy;
use std::cell::{Cell, RefCell};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

pub use nova_core_model::{ByteRange, ResumeAction, MAX_PARALLEL_SEGMENTS};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpResourceProbe {
    pub response_status: u16,
    pub content_length: Option<u64>,
    pub effective_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRangeProbe {
    pub response_status: u16,
    pub range_start: u64,
    pub range_end: u64,
    pub bytes_received: u64,
    pub effective_url: String,
}

#[derive(Debug, thiserror::Error)]
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

fn parse_http_status(header: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(header).ok()?.trim();
    if !line.starts_with("HTTP/") {
        return None;
    }
    line.split_whitespace().nth(1)?.parse().ok()
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

/// Shared balanced inclusive range planner.
///
/// `max_segments` is a host policy ceiling: desktop may allow more parallel
/// connections than mobile, while both hosts still use exactly the same range
/// geometry implementation.
pub fn plan_transfer_ranges_with_limit(
    total_bytes: u64,
    requested_connections: u32,
    max_segments: u32,
) -> Vec<ByteRange> {
    if total_bytes == 0 {
        return Vec::new();
    }

    let max_segments = max_segments.max(1);
    let requested = requested_connections.max(1).min(max_segments) as u64;
    let segment_count = requested.min(total_bytes);
    let base_len = total_bytes / segment_count;
    let remainder = total_bytes % segment_count;

    (0..segment_count)
        .map(|index| {
            let extra_before = index.min(remainder);
            let start = index * base_len + extra_before;
            let len = base_len + u64::from(index < remainder);
            ByteRange {
                start,
                end: start + len - 1,
            }
        })
        .collect()
}

/// Mobile-safe default range plan using the shared NOVA mobile ceiling.
pub fn plan_transfer_ranges(total_bytes: u64, requested_connections: u32) -> Vec<ByteRange> {
    plan_transfer_ranges_with_limit(total_bytes, requested_connections, MAX_PARALLEL_SEGMENTS)
}

pub fn plan_http_resume(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
) -> ResumeAction {
    nova_core_model::plan_http_resume(existing_bytes, response_status, content_range_start)
}

/// Probe HTTP metadata using NOVA's native libcurl transport.
pub fn probe_http_resource(url: &str) -> Result<HttpResourceProbe, TransportError> {
    let mut easy = Easy::new();
    easy.url(url).map_err(transport_error)?;
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
        .unwrap_or(url)
        .to_owned();

    Ok(HttpResourceProbe {
        response_status,
        content_length,
        effective_url,
    })
}

/// Perform and validate one inclusive HTTP byte-range GET.
///
/// The sink receives bytes only after the response proves HTTP 206 and the
/// exact requested Content-Range, preventing corrupt append/merge behavior.
pub fn stream_http_range<W: Write>(
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

pub fn probe_http_range(
    url: &str,
    start: u64,
    end: u64,
) -> Result<HttpRangeProbe, TransportError> {
    let mut sink = std::io::sink();
    stream_http_range(url, start, end, &mut sink)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpFileTransfer {
    pub response_status: u16,
    pub final_bytes: u64,
    pub total_bytes: Option<u64>,
    pub resumed_from: u64,
    pub effective_url: String,
}

fn stream_http_full<W: Write>(
    url: &str,
    sink: &mut W,
) -> Result<(u16, u64, String), TransportError> {
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

    let header_status = Cell::new(None::<u16>);
    let headers_validated = Cell::new(false);
    let bytes_received = Cell::new(0_u64);
    let sink_error = RefCell::new(None::<String>);

    let perform_result = {
        let mut transfer = easy.transfer();
        transfer
            .header_function(|header| {
                if let Some(status) = parse_http_status(header) {
                    header_status.set(Some(status));
                    headers_validated.set(false);
                } else if header == b"\r\n" || header == b"\n" {
                    headers_validated.set(
                        header_status
                            .get()
                            .is_some_and(|status| (200..300).contains(&status)),
                    );
                }
                true
            })
            .map_err(transport_error)?;
        transfer
            .write_function(|data| {
                if !headers_validated.get() {
                    return Ok(0);
                }
                if let Err(error) = sink.write_all(data) {
                    sink_error.replace(Some(format!(
                        "failed to persist native response body: {error}"
                    )));
                    return Ok(0);
                }
                let Some(next_total) = bytes_received.get().checked_add(data.len() as u64) else {
                    sink_error.replace(Some("native response byte counter overflow".to_owned()));
                    return Ok(0);
                };
                bytes_received.set(next_total);
                Ok(data.len())
            })
            .map_err(transport_error)?;
        transfer.perform()
    };

    if !headers_validated.get() {
        return Err(TransportError::RequestFailed {
            message: format!(
                "native HTTP transfer expected a successful 2xx response, got {:?}",
                header_status.get()
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
    let effective_url = easy
        .effective_url()
        .map_err(transport_error)?
        .unwrap_or(url)
        .to_owned();

    Ok((response_status, bytes_received.get(), effective_url))
}

/// Download a direct HTTP(S) resource to a host-provided path.
///
/// When the remote representation length is known, an existing partial file is
/// resumed through a validated HTTP range request. If the origin ignores range
/// requests, NOVA safely truncates and falls back to a full transfer instead of
/// appending incompatible bytes. Other transport failures preserve partial data
/// so a later session can attempt a validated resume.
pub fn download_http_to_path(
    url: &str,
    destination: &Path,
) -> Result<HttpFileTransfer, TransportError> {
    if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| TransportError::RequestFailed {
            message: format!("failed to create download staging directory: {error}"),
        })?;
    }

    let probe = probe_http_resource(url)?;
    let usable_length = if (200..300).contains(&probe.response_status) {
        probe.content_length
    } else {
        None
    };

    let mut existing_bytes = match std::fs::metadata(destination) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(TransportError::RequestFailed {
                message: format!("failed to inspect download staging file: {error}"),
            });
        }
    };

    if let Some(total_bytes) = usable_length {
        if existing_bytes > total_bytes {
            let file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(destination)
                .map_err(|error| TransportError::RequestFailed {
                    message: format!("failed to reset oversized staging file: {error}"),
                })?;
            drop(file);
            existing_bytes = 0;
        }

        if existing_bytes == total_bytes {
            return Ok(HttpFileTransfer {
                response_status: probe.response_status,
                final_bytes: total_bytes,
                total_bytes: Some(total_bytes),
                resumed_from: existing_bytes,
                effective_url: probe.effective_url,
            });
        }

        if total_bytes > 0 {
            let mut file = OpenOptions::new()
                .create(true)
                .append(existing_bytes > 0)
                .write(true)
                .truncate(existing_bytes == 0)
                .open(destination)
                .map_err(|error| TransportError::RequestFailed {
                    message: format!("failed to open download staging file: {error}"),
                })?;

            match stream_http_range(
                &probe.effective_url,
                existing_bytes,
                total_bytes - 1,
                &mut file,
            ) {
                Ok(range) => {
                    file.flush().map_err(|error| TransportError::RequestFailed {
                        message: format!("failed to flush download staging file: {error}"),
                    })?;
                    let final_bytes = existing_bytes
                        .checked_add(range.bytes_received)
                        .ok_or_else(|| TransportError::RequestFailed {
                            message: "download byte counter overflow".to_owned(),
                        })?;
                    return Ok(HttpFileTransfer {
                        response_status: range.response_status,
                        final_bytes,
                        total_bytes: Some(total_bytes),
                        resumed_from: existing_bytes,
                        effective_url: range.effective_url,
                    });
                }
                Err(TransportError::RangeResponseRejected { .. }) => {
                    // The origin does not honor byte ranges. Restart safely from
                    // zero rather than mixing a full response with partial data.
                }
                Err(error) => return Err(error),
            }
        }
    }

    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(destination)
        .map_err(|error| TransportError::RequestFailed {
            message: format!("failed to open download staging file: {error}"),
        })?;
    let (response_status, final_bytes, effective_url) =
        stream_http_full(&probe.effective_url, &mut file)?;
    file.flush().map_err(|error| TransportError::RequestFailed {
        message: format!("failed to flush download staging file: {error}"),
    })?;

    Ok(HttpFileTransfer {
        response_status,
        final_bytes,
        total_bytes: usable_length.or(Some(final_bytes)),
        resumed_from: 0,
        effective_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn planner_preserves_host_specific_ceiling() {
        let ranges = plan_transfer_ranges_with_limit(1_000_000, 128, 128);
        assert_eq!(ranges.len(), 128);
        assert_eq!(ranges.iter().map(|range| range.end - range.start + 1).sum::<u64>(), 1_000_000);
    }

    #[test]
    fn range_stream_writes_only_validated_payload() {
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
        let probe = stream_http_range(&url, 2, 5, &mut payload).expect("valid range");
        server.join().expect("range server thread");

        assert_eq!(probe.bytes_received, 4);
        assert_eq!(payload, b"cdef");
    }

    #[test]
    fn range_stream_rejects_server_ignoring_range() {
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
        assert!(payload.is_empty());
    }

    #[test]
    fn file_transfer_resumes_existing_validated_prefix() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind transfer server");
        let address = listener.local_addr().expect("transfer server address");
        let server = thread::spawn(move || {
            let (mut head_stream, _) = listener.accept().expect("accept HEAD connection");
            let mut head_request = [0_u8; 2048];
            let read = head_stream.read(&mut head_request).expect("read HEAD request");
            let head_request = String::from_utf8_lossy(&head_request[..read]);
            assert!(head_request.starts_with("HEAD /payload.bin HTTP/"));
            head_stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n",
                )
                .expect("write HEAD response");

            let (mut range_stream, _) = listener.accept().expect("accept range connection");
            let mut range_request = [0_u8; 2048];
            let read = range_stream
                .read(&mut range_request)
                .expect("read range request");
            let range_request = String::from_utf8_lossy(&range_request[..read]);
            assert!(range_request.contains("Range: bytes=4-7"));
            range_stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-7/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nefgh",
                )
                .expect("write range response");
        });

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-core-resume-{unique}.part"));
        std::fs::write(&path, b"abcd").expect("seed partial file");

        let url = format!("http://{address}/payload.bin");
        let result = download_http_to_path(&url, &path).expect("resume transfer");
        server.join().expect("transfer server thread");

        assert_eq!(result.resumed_from, 4);
        assert_eq!(result.final_bytes, 8);
        assert_eq!(std::fs::read(&path).expect("read result"), b"abcdefgh");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn file_transfer_falls_back_to_full_get_when_length_is_unknown() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind transfer server");
        let address = listener.local_addr().expect("transfer server address");
        let server = thread::spawn(move || {
            let (mut head_stream, _) = listener.accept().expect("accept HEAD connection");
            let mut head_request = [0_u8; 2048];
            let read = head_stream.read(&mut head_request).expect("read HEAD request");
            let head_request = String::from_utf8_lossy(&head_request[..read]);
            assert!(head_request.starts_with("HEAD /payload.bin HTTP/"));
            head_stream
                .write_all(
                    b"HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n",
                )
                .expect("write HEAD rejection");

            let (mut get_stream, _) = listener.accept().expect("accept GET connection");
            let mut get_request = [0_u8; 2048];
            let read = get_stream.read(&mut get_request).expect("read GET request");
            let get_request = String::from_utf8_lossy(&get_request[..read]);
            assert!(get_request.starts_with("GET /payload.bin HTTP/"));
            get_stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write GET response");
        });

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-core-full-{unique}.part"));

        let url = format!("http://{address}/payload.bin");
        let result = download_http_to_path(&url, &path).expect("full transfer");
        server.join().expect("transfer server thread");

        assert_eq!(result.resumed_from, 0);
        assert_eq!(result.final_bytes, 8);
        assert_eq!(std::fs::read(&path).expect("read result"), b"abcdefgh");
        let _ = std::fs::remove_file(path);
    }
}
