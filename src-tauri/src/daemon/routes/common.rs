use axum::http::StatusCode;
use axum::response::Json;
use std::process::{Command, Output};

use crate::daemon::utils::hide_command_window;
use crate::daemon::utils::DEFAULT_USER_AGENT;

pub(super) const PROBE_HEAD_TIMEOUT_SECS: u64 = 15;
pub(super) const PROBE_RANGE_TIMEOUT_SECS: u64 = 20;
pub(super) const PROBE_USER_AGENT: &str = DEFAULT_USER_AGENT;

pub(super) fn daemon_error(message: String) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": message})),
    )
}

pub(super) fn hidden_command(command: &str) -> Command {
    let mut cmd = Command::new(command);
    hide_command_window(&mut cmd);
    cmd.stdin(std::process::Stdio::null());
    cmd
}

pub(super) fn hidden_output(command: &str, args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = hidden_command(command);
    cmd.args(args).output()
}

pub(super) fn header_string(headers: &reqwest::header::HeaderMap, key: &str) -> String {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

pub(super) fn header_u64(headers: &reqwest::header::HeaderMap, key: &str) -> u64 {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

pub(super) fn extract_best_size(headers: &reqwest::header::HeaderMap, content_range: &str) -> u64 {
    let from_range = content_range_total(content_range);
    if from_range > 0 {
        return from_range;
    }
    for key in &[
        "content-length",
        "x-content-length",
        "x-uncompressed-content-length",
        "x-file-size",
        "x-full-content-length",
        "x-original-content-length",
        "x-compressed-content-length",
    ] {
        let v = header_u64(headers, key);
        if v > 0 {
            return v;
        }
    }
    0
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ContentRangeParsed {
    pub(super) unit: String,
    pub(super) start: Option<u64>,
    pub(super) end: Option<u64>,
    pub(super) total: Option<u64>,
    pub(super) unsatisfied: bool,
}

impl ContentRangeParsed {
    pub(super) fn parse(header: &str) -> Option<Self> {
        let header = header.trim();
        if header.is_empty() {
            return None;
        }
        let (unit, rest) = header.split_once(char::is_whitespace)?;
        let unit = unit.to_string();
        let rest = rest.trim();
        if rest.starts_with('*') {
            let total = rest.strip_prefix("*/")?.trim().parse::<u64>().ok();
            return Some(Self {
                unit,
                start: None,
                end: None,
                total,
                unsatisfied: true,
            });
        }
        let (range_part, total_part) = rest.split_once('/')?;
        let start_end = range_part.trim();
        let total = total_part.trim();
        let total = if total == "*" {
            None
        } else {
            total.parse::<u64>().ok()
        };
        if let Some((s, e)) = start_end.split_once('-') {
            let start = s.trim().parse::<u64>().ok();
            let end = if e.trim() == "*" {
                None
            } else {
                e.trim().parse::<u64>().ok()
            };
            return Some(Self {
                unit,
                start,
                end,
                total,
                unsatisfied: false,
            });
        }
        None
    }

    pub(super) fn total_bytes(&self) -> u64 {
        self.total.unwrap_or(0)
    }

    pub(super) fn is_bytes_unit(&self) -> bool {
        self.unit.eq_ignore_ascii_case("bytes")
    }
}

pub(super) fn content_range_total(content_range: &str) -> u64 {
    ContentRangeParsed::parse(content_range)
        .filter(|p| p.is_bytes_unit())
        .map(|p| p.total_bytes())
        .unwrap_or(0)
}

pub(super) fn split_cd_params(value: &str) -> Vec<&str> {
    let mut params = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' if in_quotes => {
                in_quotes = false;
            }
            b'"' if !in_quotes => {
                in_quotes = true;
            }
            b';' if !in_quotes => {
                params.push(value[start..i].trim());
                start = i + 1;
            }
            b'\\' if in_quotes && i + 1 < bytes.len() => {
                i += 2;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    params.push(value[start..].trim());
    params
}

pub(super) fn unescape_quoted_string(s: &str) -> &str {
    let s = s.trim();
    let s = if s.starts_with('"') && s.len() >= 2 {
        &s[1..]
    } else {
        s
    };
    if s.ends_with('"') && !s.is_empty() {
        &s[..s.len() - 1]
    } else {
        s
    }
}

pub(super) fn resolve_quote_escapes(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            out.push(bytes[i + 1]);
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

pub(super) fn content_disposition_filename(value: &str) -> Option<String> {
    let params = split_cd_params(value);
    for param in &params {
        let param_lower = param.to_ascii_lowercase();
        if let Some(name) = param_lower
            .strip_prefix("filename*=")
            .map(|_| &param[("filename*=".len())..])
        {
            let name = name.trim();
            if let Some(rest) = name.strip_prefix("UTF-8''") {
                let raw = rest.trim_matches('"').trim();
                if raw.is_empty() {
                    continue;
                }
                let decoded = percent_decode_str(raw);
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            } else if let Some(rest) = name.strip_prefix("ISO-8859-1''") {
                let raw = rest.trim_matches('"').trim();
                if raw.is_empty() {
                    continue;
                }
                let decoded = percent_decode_str_iso8859(raw);
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            } else if let Some((_charset, after)) = name
                .split_once('\'')
                .and_then(|(c, r)| r.split_once('\'').map(|(_, v)| (c, v)))
            {
                let raw = after.trim_matches('"').trim();
                if raw.is_empty() {
                    continue;
                }
                let decoded = percent_decode_str(raw);
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            } else {
                let raw = name.trim_matches('"').trim();
                if !raw.is_empty() {
                    return Some(raw.to_string());
                }
            }
        }
    }
    for param in &params {
        let param_lower = param.to_ascii_lowercase();
        if let Some(name) = param_lower
            .strip_prefix("filename=")
            .map(|_| &param[("filename=".len())..])
        {
            let name = name.trim();
            let name = if name.starts_with('"') {
                let inner = unescape_quoted_string(name);
                resolve_quote_escapes(inner)
            } else {
                name.to_string()
            };
            let name = name.trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

pub(super) fn percent_decode_str(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = hex_pair_to_byte(bytes[i + 1], bytes[i + 2]) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        if let Some(ch) = std::char::from_u32(bytes[i] as u32) {
            for b in ch.to_string().as_bytes() {
                result.push(*b);
            }
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| input.to_string())
}

pub(super) fn percent_decode_str_iso8859(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = hex_pair_to_byte(bytes[i + 1], bytes[i + 2]) {
                result.push(byte as char);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

fn hex_pair_to_byte(high: u8, low: u8) -> Option<u8> {
    fn hex_digit(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    Some((hex_digit(high)? << 4) | hex_digit(low)?)
}

pub(super) fn fallback_file_name(url: &str) -> String {
    let clean = url.split('?').next().unwrap_or(url).trim_end_matches('/');
    let name = clean.rsplit('/').next().unwrap_or("download").trim();
    if name.is_empty() {
        "download".to_string()
    } else {
        name.to_string()
    }
}

pub(super) fn is_cloudflare_challenge(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("cf-chl-bypass")
        || lower.contains("challenge-platform")
        || lower.contains("cf_chl_opt")
        || (lower.contains("cloudflare")
            && lower.contains("challenge")
            && lower.contains("<script"))
}

pub(super) fn extract_sha256_digest(headers: &reqwest::header::HeaderMap) -> Option<String> {
    crate::daemon::utils::extract_digest_from_headers(headers)
}
