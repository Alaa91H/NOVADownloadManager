use std::collections::HashMap;
use std::path::Path;

use super::*;
use crate::daemon::direct::DirectUrl;
use crate::daemon::types::CreateDownloadBody;
use crate::daemon::utils::{push_arg, DEFAULT_USER_AGENT};

const ALLOWED_CURL_RAW_OPTIONS: &[&str] = &[
    "--ipv4",
    "--ipv6",
    "--http1.0",
    "--http1.1",
    "--http2",
    "--http2-prior-knowledge",
    "--http3",
    "--http3-only",
    "--compressed",
    "--disable-epsv",
    "--ssl-no-revoke",
    "--tcp-fastopen",
    "--tcp-nodelay",
    "--no-keepalive",
    "--ssl-reqd",
    "--path-as-is",
    "--globoff",
    "--remote-time",
    "--retry-connrefused",
];

#[inline]
pub(crate) fn direct_str<'a>(
    direct_options: &'a HashMap<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    direct_options
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

#[inline]
pub(crate) fn direct_bool(
    direct_options: &HashMap<String, serde_json::Value>,
    key: &str,
) -> Option<bool> {
    direct_options.get(key).and_then(|v| v.as_bool())
}

#[inline]
pub(crate) fn direct_u64(
    direct_options: &HashMap<String, serde_json::Value>,
    key: &str,
) -> Option<u64> {
    direct_options
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n.max(0.0) as u64)))
}

pub(crate) fn direct_array(
    direct_options: &HashMap<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    direct_options
        .get(key)
        .and_then(|v| v.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[inline]
pub(crate) fn safe_value(value: &str) -> bool {
    !value.is_empty()
        && !value
            .bytes()
            .any(|b| b == 0 || b == b'\n' || b == b'\r' || b < 0x09 || (b > 0x09 && b < 0x20))
}

fn push_optional_arg(
    args: &mut Vec<String>,
    flag: &str,
    value: Option<&str>,
) -> Result<(), String> {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        if !safe_value(value) {
            return Err(format!("Rejected unsafe value for {}", flag));
        }
        push_arg(args, flag, value);
    }
    Ok(())
}

fn push_optional_u64(args: &mut Vec<String>, flag: &str, value: Option<u64>) {
    if let Some(value) = value.filter(|value| *value > 0) {
        push_arg(args, flag, &value.to_string());
    }
}

fn push_bool_flag(args: &mut Vec<String>, enabled: Option<bool>, flag: &str) {
    if enabled == Some(true) {
        args.push(flag.to_string());
    }
}

fn push_array_args(args: &mut Vec<String>, flag: &str, values: Vec<String>) -> Result<(), String> {
    for value in values {
        if !safe_value(&value) {
            return Err(format!("Rejected unsafe value for {}", flag));
        }
        push_arg(args, flag, &value);
    }
    Ok(())
}

fn push_header_lines(args: &mut Vec<String>, raw_headers: &str) {
    for line in raw_headers
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.contains(':') {
            push_arg(args, "--header", line);
        }
    }
}

fn apply_raw_curl_options(args: &mut Vec<String>, raw_options: &str) -> Result<(), String> {
    for line in raw_options
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let parts = crate::daemon::utils::shell_split(line);
        let option = parts.first().map(String::as_str).unwrap_or("");
        let allowed = ALLOWED_CURL_RAW_OPTIONS
            .iter()
            .any(|allowed| option == *allowed || option.starts_with(&format!("{}=", allowed)));
        let safe = !line.contains(|c: char| {
            c == ';' || c == '|' || c == '&' || c == '$' || c == '`' || c == '\n' || c == '\r'
        });
        if !allowed || !safe {
            return Err(format!("Rejected unsupported curl raw option '{}'", line));
        }
        args.extend(parts);
    }
    Ok(())
}

#[inline]
pub(crate) fn requested_connections(connections: Option<u32>) -> u32 {
    match connections.unwrap_or(0) {
        0 => DEFAULT_DIRECT_CONNECTIONS,
        n => n.clamp(1, MAX_DIRECT_CONNECTIONS),
    }
}

#[inline]
fn file_name_from_url(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or("download").trim();
    if name.is_empty() {
        "download".to_string()
    } else {
        name.to_string()
    }
}

pub(crate) fn destination_from_body(body: &CreateDownloadBody, url: &str) -> (String, PathBuf) {
    let name = body.name.clone().unwrap_or_else(|| file_name_from_url(url));
    if let Some(save_path) = body
        .save_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let path = PathBuf::from(save_path);
        return (name, path);
    }
    (name.clone(), PathBuf::from(name))
}

pub(crate) fn build_curl_args(
    body: &CreateDownloadBody,
    output_path: &Path,
) -> Result<Vec<String>, String> {
    build_curl_args_with_capabilities(body, output_path, true)
}

pub(crate) fn build_curl_args_with_capabilities(
    body: &CreateDownloadBody,
    output_path: &Path,
    fail_with_body_supported: bool,
) -> Result<Vec<String>, String> {
    let raw_url = body.url.as_deref().unwrap_or("").trim();
    let direct_url = DirectUrl::parse(raw_url)?;
    let url = direct_url.normalized.as_str();
    if url.starts_with("magnet:")
        || url.to_lowercase().ends_with(".torrent")
        || url.contains(".torrent?")
    {
        return Err("curl/libcurl is the direct-download engine. Magnet and torrent tasks need a separate torrent engine.".to_string());
    }

    let direct_options = body.direct_options.as_ref();
    let follow_redirects = direct_options
        .and_then(|dopts| direct_bool(dopts, "location"))
        .unwrap_or(true);
    let fail_with_body = direct_options
        .and_then(|dopts| direct_bool(dopts, "failWithBody"))
        .unwrap_or(true);
    let resumable = body.resumable.unwrap_or(true);

    let mut args = vec![
        "--show-error".to_string(),
        "--silent".to_string(),
        "--create-dirs".to_string(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
    ];
    if follow_redirects {
        args.push("--location".to_string());
    }
    if fail_with_body && fail_with_body_supported {
        args.push("--fail-with-body".to_string());
    } else {
        args.push("--fail".to_string());
    }

    if resumable {
        args.push("--continue-at".to_string());
        args.push("-".to_string());
    }

    let mut referer_from_direct = None;
    if let Some(dopts) = &body.direct_options {
        push_optional_arg(&mut args, "--proxy", direct_str(dopts, "proxy"))?;
        push_optional_arg(&mut args, "--noproxy", direct_str(dopts, "noproxy"))?;
        push_optional_arg(
            &mut args,
            "--interface",
            direct_str(dopts, "sourceAddress").or_else(|| direct_str(dopts, "interface")),
        )?;
        let ua = direct_str(dopts, "userAgent").unwrap_or(DEFAULT_USER_AGENT);
        push_arg(&mut args, "--user-agent", ua);
        if let Some(referer) = direct_str(dopts, "referer") {
            referer_from_direct = Some(referer.to_string());
        }
        if let Some(speed) = direct_u64(dopts, "speedLimitKbs").filter(|speed| *speed > 0) {
            push_arg(&mut args, "--limit-rate", &format!("{}K", speed));
        }
        if let Some(speed) = direct_u64(dopts, "speedLimitBytes").filter(|speed| *speed > 0) {
            push_arg(&mut args, "--limit-rate", &speed.to_string());
        }
        push_optional_u64(
            &mut args,
            "--speed-limit",
            direct_u64(dopts, "lowSpeedLimitBytes"),
        );
        push_optional_u64(&mut args, "--speed-time", direct_u64(dopts, "speedTimeSec"));
        if let Some(username) = direct_str(dopts, "username") {
            let password = direct_str(dopts, "password").unwrap_or("");
            push_arg(&mut args, "--user", &format!("{}:{}", username, password));
        }
        if let Some(retries) = direct_u64(dopts, "retryCount") {
            push_arg(&mut args, "--retry", &retries.to_string());
        }
        push_optional_u64(
            &mut args,
            "--retry-delay",
            direct_u64(dopts, "retryDelaySec"),
        );
        push_optional_u64(
            &mut args,
            "--retry-max-time",
            direct_u64(dopts, "retryMaxTimeSec"),
        );
        push_optional_u64(&mut args, "--max-time", direct_u64(dopts, "timeoutSec"));
        push_optional_u64(
            &mut args,
            "--connect-timeout",
            direct_u64(dopts, "connectTimeoutSec"),
        );
        push_optional_u64(&mut args, "--max-redirs", direct_u64(dopts, "maxRedirs"));
        push_optional_u64(
            &mut args,
            "--max-filesize",
            direct_u64(dopts, "maxFilesize"),
        );
        push_optional_arg(&mut args, "--range", direct_str(dopts, "range"))?;
        push_bool_flag(&mut args, direct_bool(dopts, "remoteTime"), "--remote-time");
        if direct_bool(dopts, "allowOverwrite") == Some(false) {
            args.push("--no-clobber".to_string());
        }
        if let Some(method) = direct_str(dopts, "requestMethod") {
            push_optional_arg(&mut args, "--request", Some(method))?;
        }
        push_optional_arg(&mut args, "--data-raw", direct_str(dopts, "data"))?;
        push_array_args(&mut args, "--form-string", direct_array(dopts, "form"))?;
        push_bool_flag(&mut args, direct_bool(dopts, "compressed"), "--compressed");
        push_bool_flag(&mut args, direct_bool(dopts, "insecure"), "--insecure");
        push_optional_arg(&mut args, "--cacert", direct_str(dopts, "caCert"))?;
        push_array_args(&mut args, "--resolve", direct_array(dopts, "resolve"))?;
        push_array_args(&mut args, "--connect-to", direct_array(dopts, "connectTo"))?;
        push_bool_flag(&mut args, direct_bool(dopts, "tcpNoDelay"), "--tcp-nodelay");
        push_bool_flag(&mut args, direct_bool(dopts, "pathAsIs"), "--path-as-is");
        push_bool_flag(&mut args, direct_bool(dopts, "globoff"), "--globoff");

        match direct_str(dopts, "httpVersion")
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "1.0" | "http1.0" => args.push("--http1.0".to_string()),
            "1.1" | "http1.1" => args.push("--http1.1".to_string()),
            "2" | "http2" => args.push("--http2".to_string()),
            "2-prior-knowledge" | "http2-prior-knowledge" => {
                args.push("--http2-prior-knowledge".to_string())
            }
            "3" | "http3" => args.push("--http3".to_string()),
            "3-only" | "http3-only" => args.push("--http3-only".to_string()),
            _ => {}
        }
        let mut headers = Vec::new();
        if let Some(raw_headers) = direct_str(dopts, "headers") {
            push_header_lines(&mut headers, raw_headers);
        }
        if let Some(cookies) = direct_str(dopts, "cookies") {
            push_arg(&mut args, "--cookie", cookies);
        }
        args.extend(headers);
        if let Some(raw_options) = direct_str(dopts, "rawOptions") {
            apply_raw_curl_options(&mut args, raw_options)?;
        }
    }

    if let Some(referer) = referer_from_direct.as_deref().or_else(|| {
        body.referer
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }) {
        push_arg(&mut args, "--referer", referer);
    }

    args.push(url.to_string());
    Ok(args)
}
