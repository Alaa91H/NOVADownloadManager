//! Platform-neutral NOVA download transport and transfer planning.
//!
//! This crate is shared by desktop and mobile hosts. It deliberately owns no
//! Tauri, Axum, Android, JNI, Compose, notification, or storage-provider types.

use curl::easy::{Easy, List};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use nova_core_model::{ByteRange, ResumeAction, MAX_PARALLEL_SEGMENTS};

/// Request metadata shared by direct and media transfers.
///
/// Security-sensitive transport headers are owned by the native core and may
/// not be overridden through `headers`. Referer, cookies and user-agent have
/// explicit fields so media extractors can pass browser-compatible request
/// context without constructing raw command-line arguments.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HttpRequestContext {
    pub headers: BTreeMap<String, String>,
    pub referer: Option<String>,
    pub cookie_header: Option<String>,
    pub user_agent: Option<String>,
}

impl HttpRequestContext {
    pub fn validate(&self) -> Result<(), TransportError> {
        for (name, value) in &self.headers {
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err(TransportError::InvalidRequestContext {
                    message: format!("invalid HTTP header name '{name}'"),
                });
            }

            let normalized = name.to_ascii_lowercase();
            if matches!(
                normalized.as_str(),
                "host"
                    | "content-length"
                    | "transfer-encoding"
                    | "range"
                    | "if-range"
                    | "accept-encoding"
                    | "connection"
                    | "user-agent"
                    | "referer"
                    | "cookie"
            ) {
                return Err(TransportError::InvalidRequestContext {
                    message: format!("HTTP header '{name}' is owned by the native transport"),
                });
            }
            validate_request_value(value, "header value")?;
        }

        if let Some(value) = &self.referer {
            validate_request_value(value, "referer")?;
        }
        if let Some(value) = &self.cookie_header {
            validate_request_value(value, "cookie header")?;
        }
        if let Some(value) = &self.user_agent {
            validate_request_value(value, "user-agent")?;
        }

        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpBufferResponse {
    pub response_status: u16,
    pub effective_url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpResourceProbe {
    pub response_status: u16,
    pub content_length: Option<u64>,
    pub effective_url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

impl HttpResourceProbe {
    /// Strong representation validator suitable for HTTP If-Range.
    ///
    /// Weak ETags are deliberately rejected because they do not prove byte
    /// identity. Last-Modified is the conservative fallback when available.
    pub fn if_range_validator(&self) -> Option<&str> {
        self.etag
            .as_deref()
            .filter(|etag| !etag.trim_start().starts_with("W/"))
            .or(self.last_modified.as_deref())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ResumeIdentity {
    content_length: u64,
    validator_kind: &'static str,
    validator: String,
}

impl ResumeIdentity {
    fn from_probe(probe: &HttpResourceProbe) -> Option<Self> {
        let content_length = probe.content_length?;
        let etag = probe
            .etag
            .as_deref()
            .filter(|etag| !etag.trim_start().starts_with("W/"));
        let (validator_kind, validator) = if let Some(etag) = etag {
            ("etag", etag)
        } else {
            ("last-modified", probe.last_modified.as_deref()?)
        };
        if validator.contains('\r') || validator.contains('\n') {
            return None;
        }
        Some(Self {
            content_length,
            validator_kind,
            validator: validator.to_owned(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRangeProbe {
    pub response_status: u16,
    pub range_start: u64,
    pub range_end: u64,
    pub bytes_received: u64,
    pub effective_url: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransferControl {
    Continue,
    Pause,
    Cancel,
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
    #[error("invalid native HTTP request context: {message}")]
    InvalidRequestContext { message: String },
    #[error("native HTTP response exceeded the in-memory limit of {limit_bytes} bytes")]
    ResponseTooLarge { limit_bytes: usize },
    #[error("native transfer paused")]
    Paused,
    #[error("native transfer cancelled")]
    Cancelled,
}

fn transport_error(error: curl::Error) -> TransportError {
    TransportError::RequestFailed {
        message: error.to_string(),
    }
}

fn validate_request_value(value: &str, label: &str) -> Result<(), TransportError> {
    if value
        .chars()
        .any(|character| matches!(character, '\\r' | '\\n' | '\\0'))
    {
        return Err(TransportError::InvalidRequestContext {
            message: format!("{label} contains a forbidden control character"),
        });
    }
    Ok(())
}

fn apply_request_context(
    easy: &mut Easy,
    context: &HttpRequestContext,
    extra_headers: &[(&str, &str)],
) -> Result<(), TransportError> {
    context.validate()?;

    easy.useragent(
        context
            .user_agent
            .as_deref()
            .unwrap_or(concat!("NOVA/", env!("CARGO_PKG_VERSION"))),
    )
    .map_err(transport_error)?;

    let has_headers = !context.headers.is_empty()
        || context.referer.is_some()
        || context.cookie_header.is_some()
        || !extra_headers.is_empty();
    if has_headers {
        let mut headers = List::new();
        for (name, value) in &context.headers {
            headers
                .append(&format!("{name}: {value}"))
                .map_err(transport_error)?;
        }
        if let Some(referer) = &context.referer {
            headers
                .append(&format!("Referer: {referer}"))
                .map_err(transport_error)?;
        }
        if let Some(cookie) = &context.cookie_header {
            headers
                .append(&format!("Cookie: {cookie}"))
                .map_err(transport_error)?;
        }
        for (name, value) in extra_headers {
            headers
                .append(&format!("{name}: {value}"))
                .map_err(transport_error)?;
        }
        easy.http_headers(headers).map_err(transport_error)?;
    }

    Ok(())
}

fn ensure_http_url(url: &str) -> Result<(), TransportError> {
    let Some((scheme, rest)) = url.trim().split_once(':') else {
        return Err(TransportError::RequestFailed {
            message: "direct transfer URL is missing a scheme".to_owned(),
        });
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(TransportError::RequestFailed {
            message: format!("unsupported direct transfer URL scheme '{scheme}'"),
        });
    }
    if rest.is_empty() {
        return Err(TransportError::RequestFailed {
            message: "direct transfer URL is missing an authority".to_owned(),
        });
    }
    Ok(())
}

fn parse_http_status(header: &[u8]) -> Option<u16> {
    let line = std::str::from_utf8(header).ok()?.trim();
    if !line.starts_with("HTTP/") {
        return None;
    }
    line.split_whitespace().nth(1)?.parse().ok()
}

fn parse_header_value(header: &[u8], expected_name: &str) -> Option<String> {
    let line = std::str::from_utf8(header).ok()?.trim();
    let (name, value) = line.split_once(':')?;
    if !name.eq_ignore_ascii_case(expected_name) {
        return None;
    }
    Some(value.trim().to_owned())
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn resume_identity_path(destination: &Path) -> PathBuf {
    append_suffix(destination, ".nova-identity")
}

fn write_resume_identity(
    destination: &Path,
    identity: &ResumeIdentity,
) -> Result<(), TransportError> {
    let path = resume_identity_path(destination);
    let tmp = append_suffix(&path, ".tmp");
    let payload = format!(
        "NOVA-IDENTITY-1\n{}\n{}\n{}\n",
        identity.content_length, identity.validator_kind, identity.validator
    );
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to create resume identity: {error}"),
            })?;
        file.write_all(payload.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to persist resume identity: {error}"),
            })?;
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| TransportError::RequestFailed {
            message: format!("failed to replace resume identity: {error}"),
        })?;
    }
    std::fs::rename(&tmp, &path).map_err(|error| TransportError::RequestFailed {
        message: format!("failed to commit resume identity: {error}"),
    })
}

fn read_resume_identity(destination: &Path) -> Option<ResumeIdentity> {
    let payload = std::fs::read_to_string(resume_identity_path(destination)).ok()?;
    let mut lines = payload.lines();
    if lines.next()? != "NOVA-IDENTITY-1" {
        return None;
    }
    let content_length = lines.next()?.parse().ok()?;
    let validator_kind = match lines.next()? {
        "etag" => "etag",
        "last-modified" => "last-modified",
        _ => return None,
    };
    let validator = lines.next()?.to_owned();
    if validator.is_empty() || validator.contains('\r') || validator.contains('\n') {
        return None;
    }
    Some(ResumeIdentity {
        content_length,
        validator_kind,
        validator,
    })
}

fn remove_resume_identity(destination: &Path) {
    let _ = std::fs::remove_file(resume_identity_path(destination));
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
    probe_http_resource_with_context(url, &HttpRequestContext::default())
}

pub fn probe_http_resource_with_context(
    url: &str,
    context: &HttpRequestContext,
) -> Result<HttpResourceProbe, TransportError> {
    ensure_http_url(url)?;
    let mut easy = Easy::new();
    easy.url(url).map_err(transport_error)?;
    easy.nobody(true).map_err(transport_error)?;
    easy.follow_location(true).map_err(transport_error)?;
    easy.max_redirections(10).map_err(transport_error)?;
    easy.connect_timeout(Duration::from_secs(15))
        .map_err(transport_error)?;
    easy.timeout(Duration::from_secs(30)).map_err(transport_error)?;
    easy.accept_encoding("identity").map_err(transport_error)?;
    apply_request_context(&mut easy, context, &[])?;

    // libcurl reports headers for every redirect/auth response. Keep only the
    // validator set belonging to the final response block.
    let validators = Arc::new(Mutex::new((None::<String>, None::<String>)));
    let validators_for_headers = Arc::clone(&validators);
    easy.header_function(move |header| {
        if parse_http_status(header).is_some() {
            if let Ok(mut values) = validators_for_headers.lock() {
                *values = (None, None);
            }
            return true;
        }
        if let Ok(mut values) = validators_for_headers.lock() {
            if let Some(etag) = parse_header_value(header, "etag") {
                values.0 = Some(etag);
            } else if let Some(last_modified) = parse_header_value(header, "last-modified") {
                values.1 = Some(last_modified);
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
        .unwrap_or(url)
        .to_owned();

    let (etag, last_modified) = validators
        .lock()
        .map(|values| values.clone())
        .unwrap_or((None, None));

    Ok(HttpResourceProbe {
        response_status,
        content_length,
        effective_url,
        etag,
        last_modified,
    })
}

/// Fetch a small HTTP(S) response into memory with the same native request
/// context used by media transfers.
///
/// This is intended for manifests, metadata and small control resources. The
/// caller must provide a hard byte ceiling; exceeding it aborts the transfer.
pub fn fetch_http_bytes_with_context(
    url: &str,
    context: &HttpRequestContext,
    max_bytes: usize,
) -> Result<HttpBufferResponse, TransportError> {
    ensure_http_url(url)?;
    if max_bytes == 0 {
        return Err(TransportError::InvalidRequestContext {
            message: "in-memory response limit must be greater than zero".to_owned(),
        });
    }

    let mut easy = Easy::new();
    easy.url(url).map_err(transport_error)?;
    easy.follow_location(true).map_err(transport_error)?;
    easy.max_redirections(10).map_err(transport_error)?;
    easy.connect_timeout(Duration::from_secs(15))
        .map_err(transport_error)?;
    easy.timeout(Duration::from_secs(30)).map_err(transport_error)?;
    easy.accept_encoding("identity").map_err(transport_error)?;
    apply_request_context(&mut easy, context, &[])?;

    let header_status = Cell::new(None::<u16>);
    let headers_validated = Cell::new(false);
    let content_type = RefCell::new(None::<String>);
    let body = RefCell::new(Vec::<u8>::new());
    let exceeded_limit = Cell::new(false);

    let perform_result = {
        let mut transfer = easy.transfer();
        transfer
            .header_function(|header| {
                if let Some(status) = parse_http_status(header) {
                    header_status.set(Some(status));
                    headers_validated.set(false);
                    content_type.replace(None);
                } else if header == b"\\r\\n" || header == b"\\n" {
                    headers_validated.set(
                        header_status
                            .get()
                            .is_some_and(|status| (200..300).contains(&status)),
                    );
                } else if let Some(value) = parse_header_value(header, "content-type") {
                    content_type.replace(Some(value));
                }
                true
            })
            .map_err(transport_error)?;
        transfer
            .write_function(|data| {
                if !headers_validated.get() {
                    return Ok(data.len());
                }
                let mut output = body.borrow_mut();
                if output.len().saturating_add(data.len()) > max_bytes {
                    exceeded_limit.set(true);
                    return Ok(0);
                }
                output.extend_from_slice(data);
                Ok(data.len())
            })
            .map_err(transport_error)?;
        transfer.perform()
    };

    if exceeded_limit.get() {
        return Err(TransportError::ResponseTooLarge {
            limit_bytes: max_bytes,
        });
    }
    perform_result.map_err(transport_error)?;

    let status = easy.response_code().map_err(transport_error)?;
    let response_status =
        u16::try_from(status).map_err(|_| TransportError::InvalidStatus { status })?;
    if !(200..300).contains(&response_status) {
        return Err(TransportError::RequestFailed {
            message: format!("native HTTP fetch returned status {response_status}"),
        });
    }
    let effective_url = easy
        .effective_url()
        .map_err(transport_error)?
        .unwrap_or(url)
        .to_owned();

    Ok(HttpBufferResponse {
        response_status,
        effective_url,
        content_type: content_type.into_inner(),
        body: body.into_inner(),
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
    stream_http_range_with_context(
        url,
        start,
        end,
        sink,
        &HttpRequestContext::default(),
    )
}

pub fn stream_http_range_with_context<W: Write>(
    url: &str,
    start: u64,
    end: u64,
    sink: &mut W,
    context: &HttpRequestContext,
) -> Result<HttpRangeProbe, TransportError> {
    stream_http_range_controlled_with_context(
        url,
        start,
        end,
        sink,
        context,
        || TransferControl::Continue,
    )
}

pub fn stream_http_range_controlled<W: Write, F: FnMut() -> TransferControl>(
    url: &str,
    start: u64,
    end: u64,
    sink: &mut W,
    control: F,
) -> Result<HttpRangeProbe, TransportError> {
    stream_http_range_controlled_with_context(
        url,
        start,
        end,
        sink,
        &HttpRequestContext::default(),
        control,
    )
}

pub fn stream_http_range_controlled_with_context<
    W: Write,
    F: FnMut() -> TransferControl,
>(
    url: &str,
    start: u64,
    end: u64,
    sink: &mut W,
    context: &HttpRequestContext,
    control: F,
) -> Result<HttpRangeProbe, TransportError> {
    stream_http_range_controlled_with_validator(url, start, end, sink, context, None, control)
}

fn stream_http_range_controlled_with_validator<W: Write, F: FnMut() -> TransferControl>(
    url: &str,
    start: u64,
    end: u64,
    sink: &mut W,
    context: &HttpRequestContext,
    if_range: Option<&str>,
    mut control: F,
) -> Result<HttpRangeProbe, TransportError> {
    ensure_http_url(url)?;
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
    easy.accept_encoding("identity").map_err(transport_error)?;
    easy.range(&format!("{start}-{end}"))
        .map_err(transport_error)?;
    let mut extra_headers = Vec::new();
    if let Some(validator) = if_range {
        extra_headers.push(("If-Range", validator));
    }
    apply_request_context(&mut easy, context, &extra_headers)?;
    easy.progress(true).map_err(transport_error)?;

    let header_status = Cell::new(None::<u16>);
    let content_range = Cell::new(None::<(u64, u64)>);
    let headers_validated = Cell::new(false);
    let bytes_received = Cell::new(0_u64);
    let sink_error = RefCell::new(None::<String>);
    let stop_control = Cell::new(TransferControl::Continue);

    let perform_result = {
        let mut transfer = easy.transfer();
        transfer
            .progress_function(|_, _, _, _| {
                let command = control();
                stop_control.set(command);
                command == TransferControl::Continue
            })
            .map_err(transport_error)?;
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
                    // Redirect/error response bodies are consumed but never
                    // forwarded to the destination. Returning the consumed
                    // length lets libcurl continue to the final response.
                    return Ok(data.len());
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

    match stop_control.get() {
        TransferControl::Pause => return Err(TransportError::Paused),
        TransferControl::Cancel => return Err(TransportError::Cancelled),
        TransferControl::Continue => {}
    }

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

fn stream_http_full_controlled<W: Write, F: FnMut() -> TransferControl>(
    url: &str,
    sink: &mut W,
    context: &HttpRequestContext,
    mut control: F,
) -> Result<(u16, u64, String), TransportError> {
    ensure_http_url(url)?;
    let mut easy = Easy::new();
    easy.url(url).map_err(transport_error)?;
    easy.follow_location(true).map_err(transport_error)?;
    easy.max_redirections(10).map_err(transport_error)?;
    easy.connect_timeout(Duration::from_secs(15))
        .map_err(transport_error)?;
    easy.accept_encoding("identity").map_err(transport_error)?;
    apply_request_context(&mut easy, context, &[])?;
    easy.progress(true).map_err(transport_error)?;

    let header_status = Cell::new(None::<u16>);
    let headers_validated = Cell::new(false);
    let bytes_received = Cell::new(0_u64);
    let sink_error = RefCell::new(None::<String>);
    let stop_control = Cell::new(TransferControl::Continue);

    let perform_result = {
        let mut transfer = easy.transfer();
        transfer
            .progress_function(|_, _, _, _| {
                let command = control();
                stop_control.set(command);
                command == TransferControl::Continue
            })
            .map_err(transport_error)?;
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
                    // Redirect/error response bodies are consumed but never
                    // forwarded to the destination. Returning the consumed
                    // length lets libcurl continue to the final response.
                    return Ok(data.len());
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

    match stop_control.get() {
        TransferControl::Pause => return Err(TransportError::Paused),
        TransferControl::Cancel => return Err(TransportError::Cancelled),
        TransferControl::Continue => {}
    }

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
    download_http_to_path_with_context(url, destination, &HttpRequestContext::default())
}

pub fn download_http_to_path_with_context(
    url: &str,
    destination: &Path,
    context: &HttpRequestContext,
) -> Result<HttpFileTransfer, TransportError> {
    download_http_to_path_controlled_with_context(
        url,
        destination,
        context,
        || TransferControl::Continue,
    )
}

pub fn download_http_to_path_controlled<F: FnMut() -> TransferControl>(
    url: &str,
    destination: &Path,
    control: F,
) -> Result<HttpFileTransfer, TransportError> {
    download_http_to_path_controlled_with_context(
        url,
        destination,
        &HttpRequestContext::default(),
        control,
    )
}

pub fn download_http_to_path_controlled_with_context<F: FnMut() -> TransferControl>(
    url: &str,
    destination: &Path,
    context: &HttpRequestContext,
    mut control: F,
) -> Result<HttpFileTransfer, TransportError> {
    if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| TransportError::RequestFailed {
            message: format!("failed to create download staging directory: {error}"),
        })?;
    }

    let probe = probe_http_resource_with_context(url, context)?;
    let usable_length = if (200..300).contains(&probe.response_status) {
        probe.content_length
    } else {
        None
    };
    let current_identity = ResumeIdentity::from_probe(&probe);
    let stored_identity = read_resume_identity(destination);

    let mut existing_bytes = match std::fs::metadata(destination) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(TransportError::RequestFailed {
                message: format!("failed to inspect download staging file: {error}"),
            });
        }
    };

    // Existing bytes are reusable only when they were written under the same
    // byte-stable representation identity. Size alone is never sufficient.
    if existing_bytes > 0
        && (current_identity.is_none() || stored_identity.as_ref() != current_identity.as_ref())
    {
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(destination)
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to reset stale staging file: {error}"),
            })?;
        file.sync_all().map_err(|error| TransportError::RequestFailed {
            message: format!("failed to sync reset staging file: {error}"),
        })?;
        existing_bytes = 0;
        remove_resume_identity(destination);
    }

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
            file.sync_all().map_err(|error| TransportError::RequestFailed {
                message: format!("failed to sync reset staging file: {error}"),
            })?;
            existing_bytes = 0;
            remove_resume_identity(destination);
        }

        if existing_bytes == total_bytes && total_bytes > 0 {
            remove_resume_identity(destination);
            return Ok(HttpFileTransfer {
                response_status: probe.response_status,
                final_bytes: total_bytes,
                total_bytes: Some(total_bytes),
                resumed_from: existing_bytes,
                effective_url: probe.effective_url,
            });
        }

        // Range-based transfer is used only when an If-Range-capable identity
        // exists. If a server exposes only Content-Length, a full transfer is
        // safer than resuming unverifiable bytes.
        if total_bytes > 0 {
            if let Some(identity) = current_identity.as_ref() {
                if existing_bytes == 0 {
                    write_resume_identity(destination, identity)?;
                }

                let mut file = OpenOptions::new()
                    .create(true)
                    .append(existing_bytes > 0)
                    .write(true)
                    .truncate(existing_bytes == 0)
                    .open(destination)
                    .map_err(|error| TransportError::RequestFailed {
                        message: format!("failed to open download staging file: {error}"),
                    })?;

                match stream_http_range_controlled_with_validator(
                    &probe.effective_url,
                    existing_bytes,
                    total_bytes - 1,
                    &mut file,
                    context,
                    Some(&identity.validator),
                    &mut control,
                ) {
                    Ok(range) => {
                        file.flush()
                            .and_then(|_| file.sync_all())
                            .map_err(|error| TransportError::RequestFailed {
                                message: format!("failed to sync download staging file: {error}"),
                            })?;
                        let final_bytes = existing_bytes
                            .checked_add(range.bytes_received)
                            .ok_or_else(|| TransportError::RequestFailed {
                                message: "download byte counter overflow".to_owned(),
                            })?;
                        if final_bytes != total_bytes {
                            return Err(TransportError::RequestFailed {
                                message: format!(
                                    "download completed at {final_bytes} bytes but expected {total_bytes}"
                                ),
                            });
                        }
                        remove_resume_identity(destination);
                        return Ok(HttpFileTransfer {
                            response_status: range.response_status,
                            final_bytes,
                            total_bytes: Some(total_bytes),
                            resumed_from: existing_bytes,
                            effective_url: range.effective_url,
                        });
                    }
                    Err(TransportError::RangeResponseRejected { .. }) => {
                        // If-Range failed or the origin ignored Range. Discard
                        // the partial representation and restart from zero.
                        remove_resume_identity(destination);
                    }
                    Err(error) => {
                        // Paused/network-failed partial data retains its
                        // identity sidecar and can be validated on the next run.
                        let _ = file.flush();
                        let _ = file.sync_all();
                        return Err(error);
                    }
                }
            }
        }
    }

    remove_resume_identity(destination);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(destination)
        .map_err(|error| TransportError::RequestFailed {
            message: format!("failed to open download staging file: {error}"),
        })?;
    let (response_status, final_bytes, effective_url) =
        stream_http_full_controlled(&probe.effective_url, &mut file, context, &mut control)?;
    file.flush()
        .and_then(|_| file.sync_all())
        .map_err(|error| TransportError::RequestFailed {
            message: format!("failed to sync download staging file: {error}"),
        })?;

    Ok(HttpFileTransfer {
        response_status,
        final_bytes,
        total_bytes: usable_length.or(Some(final_bytes)),
        resumed_from: 0,
        effective_url,
    })
}

fn segment_manifest_path(destination: &Path) -> PathBuf {
    append_suffix(destination, ".nova-segments")
}

fn write_segment_manifest(
    destination: &Path,
    ranges: &[ByteRange],
) -> Result<(), TransportError> {
    let path = segment_manifest_path(destination);
    let tmp = append_suffix(&path, ".tmp");
    let mut payload = format!("NOVA-SEGMENTS-1\n{}\n", ranges.len());
    for range in ranges {
        payload.push_str(&format!("{}-{}\n", range.start, range.end));
    }

    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to create segment manifest: {error}"),
            })?;
        file.write_all(payload.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to persist segment manifest: {error}"),
            })?;
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| TransportError::RequestFailed {
            message: format!("failed to replace segment manifest: {error}"),
        })?;
    }
    std::fs::rename(&tmp, &path).map_err(|error| TransportError::RequestFailed {
        message: format!("failed to commit segment manifest: {error}"),
    })
}

fn read_segment_manifest(destination: &Path) -> Option<Vec<ByteRange>> {
    let payload = std::fs::read_to_string(segment_manifest_path(destination)).ok()?;
    let mut lines = payload.lines();
    if lines.next()? != "NOVA-SEGMENTS-1" {
        return None;
    }
    let count: usize = lines.next()?.parse().ok()?;
    if count == 0 || count > MAX_PARALLEL_SEGMENTS as usize {
        return None;
    }

    let mut ranges = Vec::with_capacity(count);
    for _ in 0..count {
        let (start, end) = lines.next()?.split_once('-')?;
        let start: u64 = start.parse().ok()?;
        let end: u64 = end.parse().ok()?;
        if end < start {
            return None;
        }
        ranges.push(ByteRange { start, end });
    }
    Some(ranges)
}

fn remove_segment_manifest(destination: &Path) {
    let _ = std::fs::remove_file(segment_manifest_path(destination));
}

fn segment_part_path(destination: &Path, index: usize) -> PathBuf {
    append_suffix(destination, &format!(".nova-seg-{index:04}"))
}

fn segment_done_path(destination: &Path, index: usize) -> PathBuf {
    append_suffix(&segment_part_path(destination, index), ".done")
}

fn segment_merge_path(destination: &Path) -> PathBuf {
    append_suffix(destination, ".nova-merge")
}

fn cleanup_segment_artifacts(destination: &Path, segment_count: usize) {
    for index in 0..segment_count {
        let _ = std::fs::remove_file(segment_part_path(destination, index));
        let _ = std::fs::remove_file(segment_done_path(destination, index));
    }
    let _ = std::fs::remove_file(segment_merge_path(destination));
    remove_segment_manifest(destination);
}

fn segment_artifacts_exist(destination: &Path, segment_count: usize) -> bool {
    (0..segment_count).any(|index| {
        segment_part_path(destination, index).exists()
            || segment_done_path(destination, index).exists()
    })
}

fn prepare_segment_part(
    destination: &Path,
    index: usize,
    expected_bytes: u64,
) -> Result<(u64, bool), TransportError> {
    let part = segment_part_path(destination, index);
    let done = segment_done_path(destination, index);
    let actual = match std::fs::metadata(&part) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => {
            return Err(TransportError::RequestFailed {
                message: format!("failed to inspect segment {index}: {error}"),
            })
        }
    };

    if actual == expected_bytes && done.is_file() {
        return Ok((actual, true));
    }

    // A full-size part without its fsynced completion marker is not trusted:
    // it may be a crash-time/preallocated artifact. Partial files are safe to
    // resume because their representation identity is checked before this call.
    let existing = if actual >= expected_bytes {
        if part.exists() {
            let file = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&part)
                .map_err(|error| TransportError::RequestFailed {
                    message: format!("failed to reset segment {index}: {error}"),
                })?;
            file.sync_all().map_err(|error| TransportError::RequestFailed {
                message: format!("failed to sync reset segment {index}: {error}"),
            })?;
        }
        0
    } else {
        actual
    };
    let _ = std::fs::remove_file(done);
    Ok((existing, false))
}

fn mark_segment_complete(destination: &Path, index: usize) -> Result<(), TransportError> {
    let marker = segment_done_path(destination, index);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(marker)
        .map_err(|error| TransportError::RequestFailed {
            message: format!("failed to create segment completion marker: {error}"),
        })?;
    file.write_all(b"NOVA-SEGMENT-DONE-1\n")
        .and_then(|_| file.sync_all())
        .map_err(|error| TransportError::RequestFailed {
            message: format!("failed to sync segment completion marker: {error}"),
        })
}

struct ProgressWriter<'a, W, P> {
    inner: W,
    aggregate: &'a AtomicU64,
    total: u64,
    progress: &'a P,
}

impl<W: Write, P: Fn(u64, Option<u64>) + Sync> Write for ProgressWriter<'_, W, P> {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(data)?;
        if written > 0 {
            let downloaded =
                self.aggregate.fetch_add(written as u64, Ordering::AcqRel) + written as u64;
            (self.progress)(downloaded.min(self.total), Some(self.total));
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Download a known, validator-backed representation through independent byte
/// ranges and atomically merge the completed segments.
///
/// Parallelism is a policy input; range geometry, response validation, durable
/// segment artifacts and corruption avoidance remain platform-neutral.
pub fn download_http_to_path_segmented_controlled<
    F: Fn() -> TransferControl + Sync,
    P: Fn(u64, Option<u64>) + Sync,
>(
    url: &str,
    destination: &Path,
    requested_connections: u32,
    control: F,
    progress: P,
) -> Result<HttpFileTransfer, TransportError> {
    download_http_to_path_segmented_controlled_with_context(
        url,
        destination,
        requested_connections,
        &HttpRequestContext::default(),
        control,
        progress,
    )
}

pub fn download_http_to_path_segmented_controlled_with_context<
    F: Fn() -> TransferControl + Sync,
    P: Fn(u64, Option<u64>) + Sync,
>(
    url: &str,
    destination: &Path,
    requested_connections: u32,
    context: &HttpRequestContext,
    control: F,
    progress: P,
) -> Result<HttpFileTransfer, TransportError> {
    if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| TransportError::RequestFailed {
            message: format!("failed to create download staging directory: {error}"),
        })?;
    }

    let probe = probe_http_resource_with_context(url, context)?;
    let Some(identity) = ResumeIdentity::from_probe(&probe) else {
        return download_http_to_path_controlled_with_context(url, destination, context, || control());
    };
    let total_bytes = identity.content_length;
    let ranges = plan_transfer_ranges(total_bytes, requested_connections);
    if ranges.len() <= 1 {
        return download_http_to_path_controlled_with_context(url, destination, context, || control());
    }

    // A legacy/single-stream partial destination is allowed to finish through
    // the single-stream recovery path instead of being re-sharded in place.
    let existing_destination = std::fs::metadata(destination)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let has_segments =
        segment_artifacts_exist(destination, MAX_PARALLEL_SEGMENTS as usize);
    if existing_destination > 0 && !has_segments {
        return download_http_to_path_controlled_with_context(url, destination, context, || control());
    }

    let stored_identity = read_resume_identity(destination);
    let stored_ranges = read_segment_manifest(destination);
    let reusable_segments = has_segments
        && stored_identity.as_ref() == Some(&identity)
        && stored_ranges.as_deref() == Some(ranges.as_slice());
    if has_segments && !reusable_segments {
        cleanup_segment_artifacts(destination, MAX_PARALLEL_SEGMENTS as usize);
        remove_resume_identity(destination);
    }
    if read_resume_identity(destination).as_ref() != Some(&identity) {
        write_resume_identity(destination, &identity)?;
    }
    if read_segment_manifest(destination).as_deref() != Some(ranges.as_slice()) {
        write_segment_manifest(destination, &ranges)?;
    }

    let mut prepared = Vec::with_capacity(ranges.len());
    let mut resumed_from = 0_u64;
    for (index, range) in ranges.iter().copied().enumerate() {
        let expected = range.end - range.start + 1;
        let (existing, complete) = prepare_segment_part(destination, index, expected)?;
        resumed_from = resumed_from
            .checked_add(existing)
            .ok_or_else(|| TransportError::RequestFailed {
                message: "segment resume byte counter overflow".to_owned(),
            })?;
        prepared.push((index, range, existing, complete));
    }

    let aggregate = AtomicU64::new(resumed_from);
    progress(resumed_from.min(total_bytes), Some(total_bytes));
    let abort = AtomicBool::new(false);
    let effective_url = probe.effective_url.clone();
    let validator = identity.validator.clone();

    let mut results = Vec::new();
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for &(index, range, existing, complete) in &prepared {
            if complete {
                continue;
            }
            let part = segment_part_path(destination, index);
            let aggregate = &aggregate;
            let abort = &abort;
            let control = &control;
            let progress = &progress;
            let effective_url = &effective_url;
            let validator = &validator;

            handles.push(scope.spawn(move || -> Result<(), TransportError> {
                let mut file = OpenOptions::new()
                    .create(true)
                    .append(existing > 0)
                    .write(true)
                    .truncate(existing == 0)
                    .open(&part)
                    .map_err(|error| TransportError::RequestFailed {
                        message: format!("failed to open segment {index}: {error}"),
                    })?;
                let start = range.start + existing;
                let mut writer = ProgressWriter {
                    inner: &mut file,
                    aggregate,
                    total: total_bytes,
                    progress,
                };
                let result = stream_http_range_controlled_with_validator(
                    effective_url,
                    start,
                    range.end,
                    &mut writer,
                    context,
                    Some(validator),
                    || {
                        let command = control();
                        if command != TransferControl::Continue {
                            return command;
                        }
                        if abort.load(Ordering::Acquire) {
                            TransferControl::Cancel
                        } else {
                            TransferControl::Continue
                        }
                    },
                );
                drop(writer);

                if let Err(error) = file.flush().and_then(|_| file.sync_all()) {
                    abort.store(true, Ordering::Release);
                    return Err(TransportError::RequestFailed {
                        message: format!("failed to sync segment {index}: {error}"),
                    });
                }

                match result {
                    Ok(_) => {
                        let expected = range.end - range.start + 1;
                        let actual = std::fs::metadata(&part)
                            .map(|metadata| metadata.len())
                            .unwrap_or(0);
                        if actual != expected {
                            abort.store(true, Ordering::Release);
                            return Err(TransportError::RequestFailed {
                                message: format!(
                                    "segment {index} completed at {actual} bytes but expected {expected}"
                                ),
                            });
                        }
                        mark_segment_complete(destination, index)
                    }
                    Err(error) => {
                        abort.store(true, Ordering::Release);
                        Err(error)
                    }
                }
            }));
        }

        for handle in handles {
            match handle.join() {
                Ok(result) => results.push(result),
                Err(_) => results.push(Err(TransportError::RequestFailed {
                    message: "native segment worker panicked".to_owned(),
                })),
            }
        }
    });

    match control() {
        TransferControl::Pause => return Err(TransportError::Paused),
        TransferControl::Cancel => {
            cleanup_segment_artifacts(destination, MAX_PARALLEL_SEGMENTS as usize);
            remove_resume_identity(destination);
            return Err(TransportError::Cancelled);
        }
        TransferControl::Continue => {}
    }

    if results
        .iter()
        .any(|result| matches!(result, Err(TransportError::RangeResponseRejected { .. })))
    {
        cleanup_segment_artifacts(destination, MAX_PARALLEL_SEGMENTS as usize);
        remove_resume_identity(destination);
        let _ = std::fs::remove_file(destination);
        return download_http_to_path_controlled_with_context(url, destination, context, || control());
    }

    if let Some(error) = results.into_iter().find_map(Result::err) {
        if matches!(&error, TransportError::Cancelled) && abort.load(Ordering::Acquire) {
            return Err(TransportError::RequestFailed {
                message: "parallel transfer aborted after a segment failure".to_owned(),
            });
        }
        return Err(error);
    }

    let merge_path = segment_merge_path(destination);
    let merge_result = (|| -> Result<(), TransportError> {
        let mut merged = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&merge_path)
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to create segment merge file: {error}"),
            })?;

        for index in 0..ranges.len() {
            match control() {
                TransferControl::Pause => return Err(TransportError::Paused),
                TransferControl::Cancel => return Err(TransportError::Cancelled),
                TransferControl::Continue => {}
            }
            let mut part =
                File::open(segment_part_path(destination, index)).map_err(|error| {
                    TransportError::RequestFailed {
                        message: format!("failed to open segment {index} for merge: {error}"),
                    }
                })?;
            std::io::copy(&mut part, &mut merged).map_err(|error| {
                TransportError::RequestFailed {
                    message: format!("failed to merge segment {index}: {error}"),
                }
            })?;
        }
        merged
            .flush()
            .and_then(|_| merged.sync_all())
            .map_err(|error| TransportError::RequestFailed {
                message: format!("failed to sync merged download: {error}"),
            })?;
        let merged_bytes = std::fs::metadata(&merge_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if merged_bytes != total_bytes {
            return Err(TransportError::RequestFailed {
                message: format!(
                    "merged download is {merged_bytes} bytes but expected {total_bytes}"
                ),
            });
        }
        Ok(())
    })();

    if let Err(error) = merge_result {
        let _ = std::fs::remove_file(&merge_path);
        if matches!(&error, TransportError::Cancelled) {
            cleanup_segment_artifacts(destination, MAX_PARALLEL_SEGMENTS as usize);
            remove_resume_identity(destination);
        }
        return Err(error);
    }

    if destination.exists() {
        std::fs::remove_file(destination).map_err(|error| TransportError::RequestFailed {
            message: format!("failed to replace existing download destination: {error}"),
        })?;
    }
    std::fs::rename(&merge_path, destination).map_err(|error| TransportError::RequestFailed {
        message: format!("failed to commit merged download: {error}"),
    })?;
    cleanup_segment_artifacts(destination, MAX_PARALLEL_SEGMENTS as usize);
    remove_resume_identity(destination);
    progress(total_bytes, Some(total_bytes));

    Ok(HttpFileTransfer {
        response_status: 206,
        final_bytes: total_bytes,
        total_bytes: Some(total_bytes),
        resumed_from,
        effective_url,
    })
}

pub fn download_http_to_path_segmented(
    url: &str,
    destination: &Path,
    requested_connections: u32,
) -> Result<HttpFileTransfer, TransportError> {
    download_http_to_path_segmented_with_context(
        url,
        destination,
        requested_connections,
        &HttpRequestContext::default(),
    )
}

pub fn download_http_to_path_segmented_with_context(
    url: &str,
    destination: &Path,
    requested_connections: u32,
    context: &HttpRequestContext,
) -> Result<HttpFileTransfer, TransportError> {
    download_http_to_path_segmented_controlled_with_context(
        url,
        destination,
        requested_connections,
        context,
        || TransferControl::Continue,
        |_, _| {},
    )
}

/// Remove every durable artifact owned by the shared HTTP transfer engine.
///
/// Hosts should call this for an explicit destructive cancel/delete operation,
/// including when no native session is currently alive.
pub fn discard_http_download_artifacts(destination: &Path) {
    let _ = std::fs::remove_file(destination);
    remove_resume_identity(destination);
    cleanup_segment_artifacts(destination, MAX_PARALLEL_SEGMENTS as usize);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::io::ErrorKind;
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn spawn_optional_server(listener: TcpListener, response: &'static [u8]) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("configure nonblocking test listener");

            for _ in 0..200 {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
                        let mut request = [0_u8; 2048];
                        let _ = stream.read(&mut request);
                        let _ = stream.write_all(response);
                        return;
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return,
                }
            }
        })
    }

    #[test]
    fn request_context_rejects_transport_owned_and_injected_headers() {
        let mut context = HttpRequestContext::default();
        context
            .headers
            .insert("Range".to_owned(), "bytes=0-10".to_owned());
        assert!(matches!(
            context.validate(),
            Err(TransportError::InvalidRequestContext { .. })
        ));

        let mut injected = HttpRequestContext::default();
        injected
            .headers
            .insert("X-Test".to_owned(), "ok\\r\\nInjected: yes".to_owned());
        assert!(matches!(
            injected.validate(),
            Err(TransportError::InvalidRequestContext { .. })
        ));
    }

    #[test]
    fn bounded_fetch_forwards_typed_media_request_context() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind context server");
        let address = listener.local_addr().expect("context server address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept context request");
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).expect("read context request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("X-Nova-Media: native"));
            assert!(request.contains("Referer: https://example.test/watch"));
            assert!(request.contains("Cookie: session=authorized"));
            assert!(request.contains("User-Agent: NOVA-Media-Test/1"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\\r\\nContent-Type: application/vnd.apple.mpegurl\\r\\nContent-Length: 8\\r\\nConnection: close\\r\\n\\r\\n#EXTM3U\\n",
                )
                .expect("write context response");
        });

        let mut context = HttpRequestContext::default();
        context
            .headers
            .insert("X-Nova-Media".to_owned(), "native".to_owned());
        context.referer = Some("https://example.test/watch".to_owned());
        context.cookie_header = Some("session=authorized".to_owned());
        context.user_agent = Some("NOVA-Media-Test/1".to_owned());

        let response = fetch_http_bytes_with_context(
            &format!("http://{address}/master.m3u8"),
            &context,
            1024,
        )
        .expect("bounded native fetch");
        server.join().expect("context server");

        assert_eq!(response.body, b"#EXTM3U\\n");
        assert_eq!(
            response.content_type.as_deref(),
            Some("application/vnd.apple.mpegurl")
        );
    }

    #[test]
    fn native_http_transport_rejects_non_http_schemes() {
        assert!(probe_http_resource("file:///tmp/secret").is_err());
        assert!(probe_http_resource("ftp://example.invalid/file").is_err());
    }

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
    fn controlled_range_stream_can_pause_without_corrupting_sink() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind pause server");
        let address = listener.local_addr().expect("pause server address");
        let server = spawn_optional_server(
            listener,
            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/8\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
        );

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let result = stream_http_range_controlled(
            &url,
            0,
            7,
            &mut payload,
            || TransferControl::Pause,
        );
        server.join().expect("pause server thread");

        assert!(matches!(result, Err(TransportError::Paused)));
        assert!(payload.is_empty());
    }

    #[test]
    fn controlled_range_stream_can_cancel_without_corrupting_sink() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind cancel server");
        let address = listener.local_addr().expect("cancel server address");
        let server = spawn_optional_server(
            listener,
            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/8\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
        );

        let url = format!("http://{address}/payload.bin");
        let mut payload = Vec::new();
        let result = stream_http_range_controlled(
            &url,
            0,
            7,
            &mut payload,
            || TransferControl::Cancel,
        );
        server.join().expect("cancel server thread");

        assert!(matches!(result, Err(TransportError::Cancelled)));
        assert!(payload.is_empty());
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
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: \"resume-v1\"\r\nConnection: close\r\n\r\n",
                )
                .expect("write HEAD response");

            let (mut range_stream, _) = listener.accept().expect("accept range connection");
            let mut range_request = [0_u8; 2048];
            let read = range_stream
                .read(&mut range_request)
                .expect("read range request");
            let range_request = String::from_utf8_lossy(&range_request[..read]);
            assert!(range_request.contains("Range: bytes=4-7"));
            assert!(range_request.contains("If-Range: \"resume-v1\""));
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
        write_resume_identity(
            &path,
            &ResumeIdentity {
                content_length: 8,
                validator_kind: "etag",
                validator: "\"resume-v1\"".to_owned(),
            },
        )
        .expect("persist resume identity");

        let url = format!("http://{address}/payload.bin");
        let result = download_http_to_path(&url, &path).expect("resume transfer");
        server.join().expect("transfer server thread");

        assert_eq!(result.resumed_from, 4);
        assert_eq!(result.final_bytes, 8);
        assert_eq!(std::fs::read(&path).expect("read result"), b"abcdefgh");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_identity_discards_same_size_partial_before_resume() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stale identity server");
        let address = listener.local_addr().expect("stale identity address");
        let server = thread::spawn(move || {
            let (mut head_stream, _) = listener.accept().expect("accept HEAD connection");
            let mut request = [0_u8; 2048];
            let _ = head_stream.read(&mut request).expect("read HEAD request");
            head_stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: \"v2\"\r\nConnection: close\r\n\r\n",
                )
                .expect("write HEAD response");

            let (mut range_stream, _) = listener.accept().expect("accept fresh range");
            let mut request = [0_u8; 2048];
            let read = range_stream.read(&mut request).expect("read fresh range");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("Range: bytes=0-7"));
            assert!(request.contains("If-Range: \"v2\""));
            range_stream
                .write_all(
                    b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-7/8\r\nContent-Length: 8\r\nConnection: close\r\n\r\nABCDEFGH",
                )
                .expect("write fresh representation");
        });

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-core-stale-{unique}.part"));
        std::fs::write(&path, b"abcd").expect("seed stale bytes");
        write_resume_identity(
            &path,
            &ResumeIdentity {
                content_length: 8,
                validator_kind: "etag",
                validator: "\"v1\"".to_owned(),
            },
        )
        .expect("seed stale identity");

        let url = format!("http://{address}/payload.bin");
        let result = download_http_to_path(&url, &path).expect("restart stale representation");
        server.join().expect("stale identity server");

        assert_eq!(result.resumed_from, 0);
        assert_eq!(std::fs::read(&path).expect("read fresh file"), b"ABCDEFGH");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn existing_partial_without_validator_restarts_with_full_get() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind no-validator server");
        let address = listener.local_addr().expect("no-validator address");
        let server = thread::spawn(move || {
            let (mut head_stream, _) = listener.accept().expect("accept HEAD connection");
            let mut request = [0_u8; 2048];
            let _ = head_stream.read(&mut request).expect("read HEAD request");
            head_stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n",
                )
                .expect("write HEAD response");

            let (mut get_stream, _) = listener.accept().expect("accept full GET");
            let mut request = [0_u8; 2048];
            let read = get_stream.read(&mut request).expect("read full GET");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /payload.bin HTTP/"));
            assert!(!request.contains("Range:"));
            get_stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabcdefgh",
                )
                .expect("write full response");
        });

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-core-unverified-{unique}.part"));
        std::fs::write(&path, b"stale").expect("seed unverifiable bytes");

        let url = format!("http://{address}/payload.bin");
        let result = download_http_to_path(&url, &path).expect("safe full restart");
        server.join().expect("no-validator server");

        assert_eq!(result.resumed_from, 0);
        assert_eq!(std::fs::read(&path).expect("read restarted file"), b"abcdefgh");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn segment_manifest_rejects_changed_parallel_geometry() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-core-layout-{unique}.part"));
        let four_way = plan_transfer_ranges(100, 4);
        let two_way = plan_transfer_ranges(100, 2);

        write_segment_manifest(&path, &four_way).expect("write segment manifest");
        assert_eq!(read_segment_manifest(&path).as_deref(), Some(four_way.as_slice()));
        assert_ne!(read_segment_manifest(&path).as_deref(), Some(two_way.as_slice()));

        cleanup_segment_artifacts(&path, MAX_PARALLEL_SEGMENTS as usize);
        assert!(!segment_manifest_path(&path).exists());
    }

    #[test]
    fn segmented_transfer_downloads_parallel_ranges_and_merges_in_order() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind segmented server");
        let address = listener.local_addr().expect("segmented server address");
        let server = thread::spawn(move || {
            let (mut head_stream, _) = listener.accept().expect("accept HEAD connection");
            let mut request = [0_u8; 2048];
            let _ = head_stream.read(&mut request).expect("read HEAD request");
            head_stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nETag: \"seg-v1\"\r\nConnection: close\r\n\r\n",
                )
                .expect("write HEAD response");

            for _ in 0..2 {
                let (mut stream, _) = listener.accept().expect("accept segment connection");
                let mut request = [0_u8; 2048];
                let read = stream.read(&mut request).expect("read segment request");
                let request = String::from_utf8_lossy(&request[..read]);
                assert!(request.contains("If-Range: \"seg-v1\""));
                if request.contains("Range: bytes=0-3") {
                    stream
                        .write_all(
                            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd",
                        )
                        .expect("write first range");
                } else if request.contains("Range: bytes=4-7") {
                    stream
                        .write_all(
                            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-7/8\r\nContent-Length: 4\r\nConnection: close\r\n\r\nefgh",
                        )
                        .expect("write second range");
                } else {
                    panic!("unexpected segmented request: {request}");
                }
            }
        });

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-core-segmented-{unique}.part"));
        let latest_progress = AtomicU64::new(0);
        let url = format!("http://{address}/payload.bin");
        let result = download_http_to_path_segmented_controlled(
            &url,
            &path,
            2,
            || TransferControl::Continue,
            |downloaded, total| {
                assert_eq!(total, Some(8));
                latest_progress.store(downloaded, Ordering::Release);
            },
        )
        .expect("parallel segmented transfer");
        server.join().expect("segmented server");

        assert_eq!(result.final_bytes, 8);
        assert_eq!(result.resumed_from, 0);
        assert_eq!(latest_progress.load(Ordering::Acquire), 8);
        assert_eq!(std::fs::read(&path).expect("read merged result"), b"abcdefgh");
        assert!(!resume_identity_path(&path).exists());
        assert!(!segment_part_path(&path, 0).exists());
        assert!(!segment_part_path(&path, 1).exists());
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
