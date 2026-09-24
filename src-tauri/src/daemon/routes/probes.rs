use axum::extract::{Query, State};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use reqwest::header::RANGE;
use std::collections::HashMap;
use std::time::Duration;

use crate::daemon::engine::metadata_cache::CachedMetadata;
use crate::daemon::state::SharedState;
use crate::daemon::types::CreateDownloadBody;
use crate::daemon::utils::infer_file_type;

use super::common::{
    content_disposition_filename, extract_best_size, extract_sha256_digest, fallback_file_name,
    header_string, hidden_output, is_cloudflare_challenge,
    PROBE_HEAD_TIMEOUT_SECS, PROBE_RANGE_TIMEOUT_SECS, PROBE_USER_AGENT,
};
use crate::daemon::utils::{parse_meta_refresh_url, refreshed_url};

const MAX_PROBE_BODY_BYTES: usize = 2 * 1024 * 1024;

fn append_limited_probe_chunk(body: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> bool {
    let remaining = max_bytes.saturating_sub(body.len());
    if remaining == 0 {
        return false;
    }
    let accepted = chunk.len().min(remaining);
    body.extend_from_slice(&chunk[..accepted]);
    accepted == chunk.len()
}

async fn read_probe_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, reqwest::Error> {
    let mut body = Vec::with_capacity(max_bytes.min(16 * 1024));
    while let Some(chunk) = response.chunk().await? {
        if !append_limited_probe_chunk(&mut body, &chunk, max_bytes) {
            log::debug!("Probe response body exceeded the {max_bytes}-byte inspection limit");
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn probe_payload(
    url: &str,
    final_url: &str,
    headers: &reqwest::header::HeaderMap,
    status: u16,
    method: &str,
) -> serde_json::Value {
    let content_type = header_string(headers, "content-type");
    let accept_ranges = header_string(headers, "accept-ranges");
    let content_range = header_string(headers, "content-range");
    let content_disposition = header_string(headers, "content-disposition");
    let etag = header_string(headers, "etag");
    let last_modified = header_string(headers, "last-modified");
    // Extract Content-Digest / Digest / Repr-Digest for post-download
    // integrity verification (RFC 3230 / RFC 9530).
    let digest_sha256 = extract_sha256_digest(headers);
    // Accept-Ranges: bytes OR a Content-Range response means range support
    let supports_ranges = accept_ranges.eq_ignore_ascii_case("bytes")
        || content_range.to_ascii_lowercase().starts_with("bytes ");
    // Use the best available size across all known header variants
    let size = extract_best_size(headers, &content_range);
    let final_name = content_disposition_filename(&content_disposition)
        .unwrap_or_else(|| fallback_file_name(final_url));
    // Collect mirror URLs from Link: <url>; rel=duplicate headers (RFC 6249).
    // Also extract per-mirror priorities from `pri=N` Link parameters.
    let parsed_mirrors: Vec<crate::daemon::utils::ParsedLinkMirror> = headers
        .get_all("link")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(crate::daemon::utils::parse_link_mirrors)
        .collect();
    let mirror_priorities: Vec<u64> = parsed_mirrors
        .iter()
        .map(|m| u64::from(m.priority))
        .collect();
    let link_mirrors: Vec<String> = parsed_mirrors.into_iter().map(|m| m.url).collect();

    serde_json::json!({
        "url": url,
        "finalUrl": final_url,
        "fileName": final_name,
        "fileType": infer_file_type(&final_name),
        "sizeBytes": size,
        "resumable": supports_ranges || status == 206,
        "supportsSegments": (supports_ranges || status == 206) && size > 0,
        "acceptRanges": accept_ranges,
        "contentRange": content_range,
        "contentType": content_type,
        "contentDisposition": content_disposition,
        "digestSha256": digest_sha256,
        "etag": etag,
        "lastModified": last_modified,
        "linkMirrors": link_mirrors,
        "mirrorPriorities": mirror_priorities,
        "httpStatus": status,
        "probeMethod": method,
    })
}

fn direct_option_str<'a>(body: &'a CreateDownloadBody, key: &str) -> Option<&'a str> {
    body.direct_options
        .as_ref()
        .and_then(|opts| opts.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn probe_http_client(state: &SharedState, body: Option<&CreateDownloadBody>) -> reqwest::Client {
    let Some(body) = body else {
        return state.http_client.clone();
    };
    let mut builder = reqwest::Client::builder();
    // Match the download engine's redirect tolerance (curl follows up to 50
    // by default). reqwest's default (10) breaks deep-but-valid chains at
    // probe time even though the actual download would succeed.
    builder = builder.redirect(reqwest::redirect::Policy::limited(50));
    if let Some(proxy) = direct_option_str(body, "proxy") {
        if let Ok(proxy) = reqwest::Proxy::all(proxy) {
            builder = builder.proxy(proxy);
        }
    }
    if let Some(source) =
        direct_option_str(body, "sourceAddress").or_else(|| direct_option_str(body, "interface"))
    {
        if let Ok(addr) = source.parse::<std::net::IpAddr>() {
            builder = builder.local_address(addr);
        }
    }
    builder
        .build()
        .unwrap_or_else(|_| state.http_client.clone())
}

fn apply_probe_request_options(
    mut request: reqwest::RequestBuilder,
    body: Option<&CreateDownloadBody>,
) -> reqwest::RequestBuilder {
    // Add realistic browser headers that many strict servers and CDNs expect.
    // Some servers (Cloudflare, Akamai) reject requests missing
    // Accept-Language or Sec-Fetch-* headers as bot traffic.
    request = request
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header("sec-fetch-mode", "no-cors")
        .header("sec-fetch-site", "cross-site")
        .header("sec-fetch-dest", "empty");

    let Some(body) = body else {
        return request;
    };
    if let Some(user_agent) = direct_option_str(body, "userAgent") {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    if let Some(referer) = direct_option_str(body, "referer").or(body.referer.as_deref()) {
        request = request.header(reqwest::header::REFERER, referer);
    }
    if let Some(cookies) = direct_option_str(body, "cookies") {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if let Some(raw_headers) = direct_option_str(body, "headers") {
        for line in raw_headers
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.trim().as_bytes()),
                HeaderValue::from_str(value.trim()),
            ) {
                request = request.header(name, value);
            }
        }
    }
    request
}

/// Record the most informative HTTP error status observed during probing.
/// A 4xx (dead link, forbidden, rate-limited) is a stronger signal than a
/// 5xx (transient server hiccup): keep the first 4xx we see, otherwise keep
/// the first 5xx. Later duplicate classes are ignored so a definitive 404
/// from an early stage is not masked by a flaky 503 from a later one.
fn record_probe_error(
    last_error_status: &mut Option<u16>,
    last_error_reason: &mut String,
    status: u16,
    reason: &str,
) {
    let better = match *last_error_status {
        None => true,
        Some(prev) => {
            let prev_is_4xx = (400..500).contains(&prev);
            let new_is_4xx = (400..500).contains(&status);
            new_is_4xx && !prev_is_4xx
        }
    };
    if better {
        *last_error_status = Some(status);
        last_error_reason.clear();
        last_error_reason.push_str(reason);
    }
}

/// Stage 1 of the smart probe: HEAD request
/// Returns the final URL after redirects (if HEAD succeeded), or None.
/// Sets `best_payload` if size was obtained, and records the error status
/// when HEAD itself fails with 4xx/5xx so the fallback payload can explain
/// the failure.
async fn probe_stage_head(
    client: &reqwest::Client,
    url: &str,
    body: Option<&CreateDownloadBody>,
    best_payload: &mut Option<serde_json::Value>,
    last_error_status: &mut Option<u16>,
    last_error_reason: &mut String,
) -> Option<String> {
    match apply_probe_request_options(
        client
            .head(url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .timeout(Duration::from_secs(PROBE_HEAD_TIMEOUT_SECS)),
        body,
    )
    .send()
    .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let final_url = resp.url().to_string();
            if status < 400 {
                let payload = probe_payload(url, &final_url, resp.headers(), status, "HEAD");
                let ct = header_string(resp.headers(), "content-type");
                let is_html = ct.contains("text/html");
                let has_size = payload
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
                    > 0;
                let has_range = payload
                    .get("supportsSegments")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                // HEAD on CDNs that return HTML redirect pages (meta-refresh,
                // Cloudflare challenge) will have a bogus Content-Length for
                // the HTML itself. Only accept when it is NOT an HTML response.
                if has_size && (has_range || best_payload.is_none()) && !is_html {
                    *best_payload = Some(payload);
                }
                Some(final_url)
            } else {
                log::warn!(
                    "probe HEAD {} -> {} {}",
                    url,
                    status,
                    resp.status().canonical_reason().unwrap_or("")
                );
                record_probe_error(
                    last_error_status,
                    last_error_reason,
                    status,
                    resp.status().canonical_reason().unwrap_or(""),
                );
                best_payload.as_ref().map(|_| final_url)
            }
        }
        Err(e) => {
            log::warn!("probe HEAD {url} failed: {e}");
            None
        }
    }
}

fn probe_payload_from_cache(cached: &CachedMetadata) -> serde_json::Value {
    let final_url = cached
        .headers
        .get("finalUrl")
        .cloned()
        .unwrap_or_else(|| cached.url.clone());
    let link_mirrors: Vec<String> = cached
        .headers
        .get("linkMirrors")
        .and_then(|v| serde_json::from_str::<Vec<String>>(v).ok())
        .unwrap_or_default();
    let mirror_priorities: Vec<u64> = cached
        .headers
        .get("mirrorPriorities")
        .and_then(|v| serde_json::from_str::<Vec<u64>>(v).ok())
        .unwrap_or_default();
    serde_json::json!({
        "url": cached.url,
        "finalUrl": final_url,
        "fileName": cached.filename,
        "fileType": infer_file_type(&cached.filename),
        "sizeBytes": cached.content_length.unwrap_or(0),
        "resumable": cached.accept_ranges,
        "supportsSegments": cached.accept_ranges,
        "contentType": cached.content_type.clone().unwrap_or_default(),
        "contentRange": cached.content_range.clone().unwrap_or_default(),
        "contentDisposition": cached.content_disposition.clone().unwrap_or_default(),
        "acceptRanges": if cached.accept_ranges { "bytes" } else { "" },
        "etag": cached.etag.clone().unwrap_or_default(),
        "lastModified": cached.last_modified.clone().unwrap_or_default(),
        "digestSha256": cached.checksum.clone(),
        "linkMirrors": link_mirrors,
        "mirrorPriorities": mirror_priorities,
        "probeMethod": "metadata-cache"
    })
}

fn cache_probe_payload(state: &SharedState, url: &str, payload: &serde_json::Value) {
    let size = payload
        .get("sizeBytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let method = payload
        .get("probeMethod")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if size == 0 || method.starts_with("fallback") {
        return;
    }
    // Do not cache HTML redirect pages (meta-refresh, Cloudflare challenge)
    // as they are not the actual file.
    let ct = payload
        .get("contentType")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if ct.contains("text/html") {
        return;
    }
    let get_str = |key: &str| payload.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let mut headers = HashMap::new();
    if let Some(final_url) = get_str("finalUrl") {
        headers.insert("finalUrl".to_owned(), final_url);
    }
    for key in ["linkMirrors", "mirrorPriorities"] {
        if let Some(values) = payload.get(key).and_then(|v| v.as_array()) {
            if !values.is_empty() {
                if let Ok(json) = serde_json::to_string(values) {
                    headers.insert(key.to_owned(), json);
                }
            }
        }
    }
    state.metadata_cache.put(CachedMetadata {
        url: url.to_owned(),
        filename: get_str("fileName").unwrap_or_default(),
        content_type: get_str("contentType").filter(|v| !v.is_empty()),
        content_length: Some(size),
        content_range: get_str("contentRange").filter(|v| !v.is_empty()),
        content_disposition: get_str("contentDisposition").filter(|v| !v.is_empty()),
        etag: get_str("etag").filter(|v| !v.is_empty()),
        last_modified: get_str("lastModified").filter(|v| !v.is_empty()),
        accept_ranges: payload
            .get("resumable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        checksum: get_str("digestSha256").filter(|v| !v.is_empty()),
        headers,
        cached_at: chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
    });
}

pub async fn probe_url_with_options(
    state: &SharedState,
    url: &str,
    body: Option<&CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }

    // SSRF protection: reject URLs targeting internal networks
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked probe of unsafe URL {url}: {e}");
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    // Serve recent probe results from the metadata cache to avoid re-hitting
    // origin servers for the same URL (probe â†’ add-download double request).
    // A cache entry is keyed only by URL. Requests with caller-supplied
    // cookies, authorization headers, proxy routing or custom user-agent can
    // legitimately receive different metadata, so only the default public
    // probe may read or write this shared cache.
    if body.is_none() {
        if let Some(cached) = state.metadata_cache.get(url) {
            return Ok(Json(probe_payload_from_cache(&cached)));
        }
    }

    let result = probe_url_uncached(state, url, body).await;
    if body.is_none() {
        if let Ok(Json(payload)) = &result {
            cache_probe_payload(state, url, payload);
        }
    }
    result
}

async fn probe_url_uncached(
    state: &SharedState,
    url: &str,
    body: Option<&CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let client = probe_http_client(state, body);
    let mut best_payload: Option<serde_json::Value> = None;
    // The most informative HTTP status observed across stages. When every
    // attempt fails with a 4xx/5xx (dead mirror, forbidden, rate-limited),
    // surface that status in the fallback payload so the UI can show
    // "403 Forbidden" / "404 Not Found" instead of a generic unknown.
    let mut last_error_status: Option<u16> = None;
    let mut last_error_reason = String::new();

    // â”€â”€ Stage 1: HEAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let final_url = probe_stage_head(
        &client,
        url,
        body,
        &mut best_payload,
        &mut last_error_status,
        &mut last_error_reason,
    )
    .await;

    // â”€â”€ Stage 2: GET bytes=0-0 (single byte range) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let target_url = final_url.as_deref().unwrap_or(url);
    if let Ok(resp) = apply_probe_request_options(
        client
            .get(target_url)
            .header(RANGE, "bytes=0-0")
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
        body,
    )
    .send()
    .await
    {
        let status = resp.status().as_u16();
        let stage_final = resp.url().to_string();
        let ct = header_string(resp.headers(), "content-type");
        let is_html = ct.contains("text/html");
        if status == 206 || status == 416 {
            let payload = probe_payload(url, &stage_final, resp.headers(), status, "GET range=0-0");
            return Ok(Json(payload));
        }
        if status < 400 && !is_html {
            let payload = probe_payload(
                url,
                &stage_final,
                resp.headers(),
                status,
                "GET range=0-0 (no-range)",
            );
            let has_size = payload
                .get("sizeBytes")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
                > 0;
            if has_size && best_payload.is_none() {
                best_payload = Some(payload);
            }
        }
        if status >= 400 {
            log::warn!(
                "probe GET range=0-0 {} -> {} {}",
                url,
                status,
                resp.status().canonical_reason().unwrap_or("")
            );
            record_probe_error(
                &mut last_error_status,
                &mut last_error_reason,
                status,
                resp.status().canonical_reason().unwrap_or(""),
            );
        }
        if is_html {
            log::info!(
                "probe GET range=0-0 {url} -> HTML response (redirect page?), skipping to Stage 3b"
            );
        }
    }

    // â”€â”€ Stage 3: GET bytes=0-1023 (larger range peek) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if best_payload.is_none() {
        if let Ok(resp) = apply_probe_request_options(
            client
                .get(target_url)
                .header(RANGE, "bytes=0-1023")
                .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
                .header(reqwest::header::ACCEPT, "*/*")
                .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
            body,
        )
        .send()
        .await
        {
            let status = resp.status().as_u16();
            let stage_final = resp.url().to_string();
            let ct = header_string(resp.headers(), "content-type");
            let is_html = ct.contains("text/html");
            if status == 206 || status == 416 {
                let payload = probe_payload(
                    url,
                    &stage_final,
                    resp.headers(),
                    status,
                    "GET range=0-1023",
                );
                return Ok(Json(payload));
            }
            if status < 400 && !is_html {
                let payload = probe_payload(
                    url,
                    &stage_final,
                    resp.headers(),
                    status,
                    "GET range=0-1023",
                );
                let has_size = payload
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
                    > 0;
                if has_size {
                    return Ok(Json(payload));
                }
                if best_payload.is_none() {
                    best_payload = Some(payload);
                }
            }
            if is_html {
                log::info!(
                    "probe GET range=0-1023 {url} -> HTML response (redirect page?), skipping to Stage 3b"
                );
            }
            if status >= 400 {
                record_probe_error(
                    &mut last_error_status,
                    &mut last_error_reason,
                    status,
                    resp.status().canonical_reason().unwrap_or(""),
                );
            }
        }
    }

    // Return the best partial result we collected.
    if let Some(payload) = best_payload {
        return Ok(Json(payload));
    }

    // â”€â”€ Stage 3b: Plain GET with Accept-Encoding (fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Some CDNs (CloudFront, Akamai) block requests without a proper
    // Accept-Encoding header or without Range. Try a plain GET with
    // browser-like encoding and abort headers-only.
    let _stage3b_body = if let Ok(resp) = apply_probe_request_options(
        client
            .get(target_url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::ACCEPT_ENCODING, "gzip, deflate, br")
            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
        body,
    )
    .send()
    .await
    {
        let status = resp.status().as_u16();
        let stage_final = resp.url().to_string();
        let status_reason = resp.status().canonical_reason().unwrap_or("").to_owned();
        let content_type = header_string(resp.headers(), "content-type");
        let headers_snapshot = resp.headers().clone();
        let content_length = resp.content_length().unwrap_or(0);
        let body_text = if content_length > MAX_PROBE_BODY_BYTES as u64 {
            String::new()
        } else {
            match read_probe_body_limited(resp, MAX_PROBE_BODY_BYTES).await {
                Ok(body) => body,
                Err(error) => {
                    log::debug!("Could not read bounded Stage 3b probe body: {error}");
                    String::new()
                }
            }
        };
        if status < 400 {
            let is_html = content_type.contains("text/html")
                || body_text.trim_start().starts_with("<!DOCTYPE")
                || body_text.trim_start().starts_with("<html");
            // For non-HTML responses, return immediately if we have a size.
            // For HTML responses (meta-refresh, Cloudflare challenge), fall
            // through to the redirect/challenge handlers below.
            if !is_html {
                let payload = probe_payload(
                    url,
                    &stage_final,
                    &headers_snapshot,
                    status,
                    "GET (encoding)",
                );
                let has_size = payload
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
                    > 0;
                if has_size {
                    return Ok(Json(payload));
                }
                if let Some(payload) = best_payload.take() {
                    return Ok(Json(payload));
                }
            }
            // If body is HTML, try to extract a meta-refresh redirect URL
            if is_html {
                if let Some(refresh_url) = parse_meta_refresh_url(&body_text) {
                    log::info!("probe meta-refresh redirect for {url}: {refresh_url}");
                    // Follow the meta-refresh URL with a new GET request
                    if let Ok(refreshed) = apply_probe_request_options(
                        client
                            .get(refreshed_url(refresh_url, &stage_final))
                            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
                            .header(reqwest::header::ACCEPT, "*/*")
                            .header(RANGE, "bytes=0-0")
                            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
                        body,
                    )
                    .send()
                    .await
                    {
                        let r_status = refreshed.status().as_u16();
                        let r_final = refreshed.url().to_string();
                        if r_status == 206 || r_status == 416 || r_status < 400 {
                            let payload = probe_payload(
                                url,
                                &r_final,
                                refreshed.headers(),
                                r_status,
                                "GET meta-refresh range=0-0",
                            );
                            return Ok(Json(payload));
                        }
                    }
                }
                // No meta-refresh: some sites (Sublime "thank you" page,
                // SourceForge, GitHub releases) link the real file via plain
                // <a href> anchors. Follow the ranked candidates in order so
                // the probe reports the real file size instead of the HTML
                // page; the first-ranked link may be dead or another
                // interstitial, so try each until one answers with a file.
                let candidates =
                    crate::daemon::utils::extract_direct_download_links(&body_text, &stage_final);
                for link in candidates {
                    log::info!("probe direct-download link for {url}: {link}");
                    if let Ok(resp) = apply_probe_request_options(
                        client
                            .get(link)
                            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
                            .header(reqwest::header::ACCEPT, "*/*")
                            .header(RANGE, "bytes=0-0")
                            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
                        body,
                    )
                    .send()
                    .await
                    {
                        let r_status = resp.status().as_u16();
                        let r_final = resp.url().to_string();
                        // A candidate that itself answers with an HTML
                        // interstitial (e.g. a mirror pointing at another
                        // landing page) must not be reported as a file — skip
                        // it and try the next ranked candidate.
                        let is_html = resp
                            .headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok())
                            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"));
                        if (r_status == 206 || r_status == 416 || r_status < 400) && !is_html {
                            let payload = probe_payload(
                                url,
                                &r_final,
                                resp.headers(),
                                r_status,
                                "GET direct-download link range=0-0",
                            );
                            return Ok(Json(payload));
                        }
                    }
                }
            }
            // A challenge/interstitial page means the origin returned HTML
            // instead of the file; the download engine re-resolves the effective
            // URL and retries, so just note it here.
            if is_cloudflare_challenge(&body_text) {
                log::info!("probe: challenge/interstitial page detected for {url}");
            }
        } else {
            log::warn!("probe GET (encoding) {url} -> {status} {status_reason}");
            record_probe_error(
                &mut last_error_status,
                &mut last_error_reason,
                status,
                &status_reason,
            );
        }
        body_text
    } else {
        String::new()
    };

    // â”€â”€ Stage 4: Synthetic fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // All network attempts failed (timeout / DNS / TLS / 4xx-5xx). Return
    // minimal metadata derived from the URL alone so the UI can still show a
    // sensible filename and file type without crashing. When we did observe a
    // concrete HTTP error status (dead mirror, forbidden, rate-limited), carry
    // it through so the UI can explain why the link is unusable instead of
    // showing a generic unknown.
    let fname = fallback_file_name(url);
    let mut fallback = serde_json::json!({
        "url": url,
        "finalUrl": url,
        "fileName": fname,
        "fileType": infer_file_type(&fname),
        "sizeBytes": 0,
        "resumable": false,
        "supportsSegments": false,
        "contentType": "",
        "acceptRanges": "",
        "etag": "",
        "lastModified": "",
        "probeMethod": "fallback-no-response"
    });
    if let Some(status) = last_error_status {
        fallback["httpStatus"] = serde_json::Value::from(status);
        fallback["probeMethod"] =
            serde_json::Value::from(format!("fallback-http-{status} {last_error_reason}"));
    }
    Ok(Json(fallback))
}

pub async fn handle_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map_or("", |s| s.as_str());
    probe_url_with_options(&state, url, None).await
}

pub async fn handle_probe_post(
    State(state): State<SharedState>,
    Json(body): Json<CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url_owned = body.url.clone().unwrap_or_default();
    let url = url_owned.trim();
    probe_url_with_options(&state, url, Some(&body)).await
}

fn parse_native_media_header_lines(
    request: &mut nova_media_core::ExtractRequest,
    headers: &str,
) -> Result<(), String> {
    for line in headers.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("Invalid media header line: {line}"))?;
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            return Err(format!("Invalid media header line: {line}"));
        }
        request.headers.insert(name.to_owned(), value.to_owned());
    }
    Ok(())
}

fn native_extract_request_from_body(
    body: &CreateDownloadBody,
) -> Result<nova_media_core::ExtractRequest, String> {
    let url = body.url.as_deref().unwrap_or_default().trim();
    if url.is_empty() {
        return Err("Missing url".to_owned());
    }

    let mut request = nova_media_core::ExtractRequest::new(url);
    if let Some(referer) = body.referer.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        request.headers.insert("Referer".to_owned(), referer.to_owned());
    }

    if let Some(media) = body.media_options.as_ref() {
        if media.cookies_from_browser.as_deref().is_some_and(|value| !value.trim().is_empty()) {
            return Err(
                "Native media resolver does not import browser cookies yet; provide an explicit Cookie header instead"
                    .to_owned(),
            );
        }

        if let Some(cookies) = media.cookies.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            let looks_like_cookie_header =
                cookies.contains('=') && !cookies.ends_with(".txt") && !cookies.contains('\\');
            if !looks_like_cookie_header {
                return Err(
                    "Native media resolver does not read cookie files yet; provide cookies as a Cookie header"
                        .to_owned(),
                );
            }
            request.headers.insert("Cookie".to_owned(), cookies.to_owned());
        }

        if let Some(user_agent) = media
            .user_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request
                .headers
                .insert("User-Agent".to_owned(), user_agent.to_owned());
        }
        if let Some(referer) = media
            .referer
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request
                .headers
                .insert("Referer".to_owned(), referer.to_owned());
        }
        if let Some(headers) = media
            .headers
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            parse_native_media_header_lines(&mut request, headers)?;
        }
    }

    request
        .request_context()
        .map_err(|error| error.to_string())?;
    Ok(request)
}

pub(super) fn resolve_native_media_request(
    request: nova_media_core::ExtractRequest,
) -> Result<serde_json::Value, String> {
    use nova_media_core::{
        resolve_youtube_pending_formats, select_youtube_download_plan, youtube_video_id,
        ExtractorRegistry, YouTubeExtractor, YouTubePlayerScriptSolver, YouTubeSelectionPolicy,
    };

    let parsed = request.parsed_url().map_err(|error| error.to_string())?;

    if youtube_video_id(&parsed).is_some() {
        let extractor = YouTubeExtractor;
        let mut extraction = extractor
            .extract_native(&request)
            .map_err(|error| error.to_string())?;

        let challenge_resolution = if extraction.pending_formats.is_empty() {
            serde_json::Value::Null
        } else {
            let context = request.request_context().map_err(|error| error.to_string())?;
            let solver = YouTubePlayerScriptSolver;
            match resolve_youtube_pending_formats(&mut extraction, &context, &solver) {
                Ok(resolution) => serde_json::json!({
                    "resolved": resolution,
                }),
                Err(error) => serde_json::json!({
                    "error": error.to_string(),
                }),
            }
        };

        let selection = select_youtube_download_plan(
            &extraction,
            YouTubeSelectionPolicy::default(),
        );

        return Ok(serde_json::json!({
            "engine": "nova-native",
            "extractor": "youtube-native",
            "descriptor": extraction.descriptor,
            "selection": selection,
            "challengeResolution": challenge_resolution,
            "youtube": {
                "videoId": extraction.video_id,
                "pendingFormats": extraction.pending_formats,
                "playerJsUrl": extraction.player_js_url,
                "visitorData": extraction.visitor_data,
            }
        }));
    }

    let registry = ExtractorRegistry::with_native_defaults();
    let descriptor = registry.resolve(&request).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "engine": "nova-native",
        "extractor": "registry",
        "descriptor": descriptor,
        "selection": serde_json::Value::Null,
    }))
}

async fn run_native_media_resolve(
    request: nova_media_core::ExtractRequest,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = request.url.clone();
    if let Err(error) = crate::daemon::utils::is_safe_target_url(&url) {
        log::warn!("Blocked native media resolve of unsafe URL {url}: {error}");
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        ));
    }

    let resolve = tokio::task::spawn_blocking(move || resolve_native_media_request(request));
    let result = tokio::time::timeout(Duration::from_secs(35), resolve)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({"error": "Native media resolve timed out"})),
            )
        })?
        .map_err(|error| {
            log::error!("Native media resolve worker failed: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Native media resolve worker failed"})),
            )
        })?
        .map_err(|error| {
            log::warn!("Native media resolve failed: {error}");
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": error})),
            )
        })?;

    Ok(Json(result))
}

pub async fn handle_native_media_resolve(
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map_or("", String::as_str).trim();
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    run_native_media_resolve(nova_media_core::ExtractRequest::new(url)).await
}

pub async fn handle_native_media_resolve_post(
    Json(body): Json<CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let request = native_extract_request_from_body(&body).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        )
    })?;
    run_native_media_resolve(request).await
}


pub(super) fn native_media_probe_payload(
    resolved: &serde_json::Value,
    url: &str,
) -> Result<serde_json::Value, String> {
    let descriptor = resolved
        .get("descriptor")
        .ok_or_else(|| "Native media descriptor missing".to_owned())?;
    let metadata = descriptor.get("metadata").unwrap_or(&serde_json::Value::Null);
    let duration_millis = metadata
        .get("duration_millis")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let duration = duration_millis as f64 / 1000.0;
    let hours = (duration / 3600.0).floor() as u64;
    let minutes = ((duration % 3600.0) / 60.0).floor() as u64;
    let seconds = (duration % 60.0).floor() as u64;
    let duration_string = if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    };

    let stable_page_url = metadata
        .get("webpage_url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(url);
    let formats = descriptor
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .map(|streams| {
            streams
                .iter()
                .map(|stream| {
                    let bitrate = stream.get("bitrate_bps").and_then(serde_json::Value::as_u64);
                    let audio_bitrate = stream
                        .get("audio_bitrate_bps")
                        .and_then(serde_json::Value::as_u64);
                    let video_codec = stream
                        .get("video_codec")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("none");
                    let audio_codec = stream
                        .get("audio_codec")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("none");
                    let kind = stream
                        .get("kind")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let has_video =
                        video_codec != "none" || matches!(kind, "video" | "audio-video");
                    let has_audio =
                        audio_codec != "none" || matches!(kind, "audio" | "audio-video");
                    let height = stream.get("height").and_then(serde_json::Value::as_u64);
                    let language = stream
                        .get("language")
                        .and_then(serde_json::Value::as_str);
                    let label = height
                        .map(|value| format!("{value}p"))
                        .or_else(|| language.map(str::to_owned))
                        .unwrap_or_else(|| {
                            if has_video {
                                "Video".to_owned()
                            } else if has_audio {
                                "Audio".to_owned()
                            } else {
                                "Media".to_owned()
                            }
                        });
                    let codecs = [video_codec, audio_codec]
                        .into_iter()
                        .filter(|codec| *codec != "none" && !codec.is_empty())
                        .collect::<Vec<_>>()
                        .join(", ");
                    let mut format = serde_json::Map::new();
                    format.insert("url".to_owned(), serde_json::json!(stable_page_url));
                    format.insert(
                        "formatId".to_owned(),
                        serde_json::json!(
                            stream
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("native")
                        ),
                    );
                    format.insert("label".to_owned(), serde_json::json!(label));
                    format.insert(
                        "ext".to_owned(),
                        serde_json::json!(
                            stream
                                .get("container")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("")
                        ),
                    );
                    format.insert(
                        "container".to_owned(),
                        serde_json::json!(
                            stream
                                .get("container")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("")
                        ),
                    );
                    format.insert(
                        "filesize".to_owned(),
                        serde_json::json!(
                            stream
                                .get("content_length")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0)
                        ),
                    );
                    format.insert(
                        "filesizeApprox".to_owned(),
                        serde_json::json!(
                            stream
                                .get("content_length")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0)
                        ),
                    );
                    format.insert(
                        "estimatedSizeBytes".to_owned(),
                        serde_json::json!(
                            stream
                                .get("content_length")
                                .and_then(serde_json::Value::as_u64)
                                .unwrap_or(0)
                        ),
                    );
                    format.insert("vcodec".to_owned(), serde_json::json!(video_codec));
                    format.insert("acodec".to_owned(), serde_json::json!(audio_codec));
                    format.insert("codecs".to_owned(), serde_json::json!(codecs));
                    format.insert("hasVideo".to_owned(), serde_json::json!(has_video));
                    format.insert("hasAudio".to_owned(), serde_json::json!(has_audio));

                    if let Some(value) = stream.get("height").and_then(serde_json::Value::as_u64) {
                        format.insert("height".to_owned(), serde_json::json!(value));
                    }
                    if let Some(value) = stream.get("width").and_then(serde_json::Value::as_u64) {
                        format.insert("width".to_owned(), serde_json::json!(value));
                    }
                    if let Some(value) = language {
                        format.insert("formatNote".to_owned(), serde_json::json!(value));
                    }
                    if let Some(value) = bitrate {
                        format.insert("tbr".to_owned(), serde_json::json!(value as f64 / 1000.0));
                        format.insert("vbr".to_owned(), serde_json::json!(value as f64 / 1000.0));
                    }
                    if let Some(value) = audio_bitrate {
                        format.insert("abr".to_owned(), serde_json::json!(value as f64 / 1000.0));
                    }
                    if let Some(value) = bitrate.or(audio_bitrate) {
                        format.insert("bandwidth".to_owned(), serde_json::json!(value));
                    }
                    if let Some(value) = stream.get("fps").and_then(serde_json::Value::as_f64) {
                        format.insert("fps".to_owned(), serde_json::json!(value));
                    }

                    serde_json::Value::Object(format)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let id = resolved
        .pointer("/youtube/videoId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("native");

    Ok(serde_json::json!({
        "id": id,
        "title": metadata.get("title").and_then(serde_json::Value::as_str).unwrap_or("Media"),
        "duration": duration,
        "durationString": duration_string,
        "thumbnail": metadata.get("thumbnail_url").and_then(serde_json::Value::as_str).unwrap_or(""),
        "webpageUrl": metadata.get("webpage_url").and_then(serde_json::Value::as_str).unwrap_or(url),
        "uploader": metadata.get("uploader").and_then(serde_json::Value::as_str).unwrap_or(""),
        "description": metadata.get("description").and_then(serde_json::Value::as_str).unwrap_or(""),
        "isLive": descriptor.get("is_live").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "formats": formats,
        "engine": "nova-media-engine"
    }))
}

pub async fn handle_native_media_probe(
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map_or("", String::as_str).trim();
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    if let Err(error) = crate::daemon::utils::is_safe_target_url(url) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        ));
    }

    let request = nova_media_core::ExtractRequest::new(url);
    let resolved = tokio::task::spawn_blocking(move || resolve_native_media_request(request))
        .await
        .map_err(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Native media probe worker failed: {error}")})),
            )
        })?
        .map_err(|error| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": error})),
            )
        })?;

    let payload = native_media_probe_payload(&resolved, url).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        )
    })?;
    Ok(Json(payload))
}

pub async fn handle_native_media_probe_playlist(
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map_or("", String::as_str).trim();
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    if let Err(error) = crate::daemon::utils::is_safe_target_url(url) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        ));
    }

    let request = nova_media_core::ExtractRequest::new(url);
    let playlist = tokio::task::spawn_blocking(move || {
        nova_media_core::resolve_youtube_playlist(&request)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Native playlist worker failed: {error}")
            })),
        )
    })?
    .map_err(|error| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error": error})),
        )
    })?;

    let entries = playlist
        .entries
        .into_iter()
        .map(|entry| {
            let duration = entry.duration_millis.unwrap_or(0) as f64 / 1000.0;
            let hours = (duration / 3600.0).floor() as u64;
            let minutes = ((duration % 3600.0) / 60.0).floor() as u64;
            let seconds = (duration % 60.0).floor() as u64;
            let duration_string = if hours > 0 {
                format!("{hours:02}:{minutes:02}:{seconds:02}")
            } else {
                format!("{minutes:02}:{seconds:02}")
            };
            serde_json::json!({
                "id": entry.id,
                "title": entry.title,
                "url": entry.url,
                "duration": duration,
                "durationString": duration_string,
                "thumbnail": entry.thumbnail_url.unwrap_or_default(),
                "index": entry.index,
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(serde_json::json!({
        "id": playlist.id,
        "title": playlist.title,
        "webpageUrl": playlist.webpage_url,
        "entries": entries,
        "truncated": playlist.truncated,
        "engine": "nova-media-engine",
    })))
}

pub async fn handle_media_postprocess_status(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let ffmpeg_bin = state.ffmpeg_binary();
    let available = hidden_output(&ffmpeg_bin, &["-version"]).is_ok_and(|output| output.status.success());
    Json(serde_json::json!({
        "available": available,
        "engine": "nova-media-postprocess",
        "backend": "ffmpeg"
    }))
}

fn retired_media_bridge_response(
    replacement: &'static str,
) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::GONE,
        Json(serde_json::json!({
            "error": "The Media Bridge API has been retired.",
            "replacement": replacement,
            "engine": "nova-media-engine"
        })),
    )
}

async fn handle_deprecated_media_bridge_probe() -> (StatusCode, Json<serde_json::Value>) {
    retired_media_bridge_response("/api/media/probe")
}

async fn handle_deprecated_media_bridge_playlist_probe() -> (StatusCode, Json<serde_json::Value>) {
    retired_media_bridge_response("/api/media/probe-playlist")
}

#[cfg(test)]
mod bounded_body_tests {
    use super::{append_limited_probe_chunk, retired_media_bridge_response};
    use axum::http::StatusCode;
    use axum::Json;

    #[test]
    fn retired_media_bridge_routes_point_to_native_replacements() {
        let (status, Json(payload)) = retired_media_bridge_response("/api/media/probe");
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(payload["replacement"], "/api/media/probe");
        assert_eq!(payload["engine"], "nova-media-engine");
    }

    #[test]
    fn streamed_probe_body_never_exceeds_its_inspection_budget() {
        let mut body = Vec::new();
        assert!(append_limited_probe_chunk(&mut body, b"abcd", 6));
        assert!(!append_limited_probe_chunk(&mut body, b"efgh", 6));
        assert_eq!(body, b"abcdef");
    }
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/probe", get(handle_probe).post(handle_probe_post))
        .route(
            "/api/media/resolve",
            get(handle_native_media_resolve).post(handle_native_media_resolve_post),
        )
        .route(
            "/api/media/native/resolve",
            get(handle_native_media_resolve).post(handle_native_media_resolve_post),
        )
        .route("/api/media/probe", get(handle_native_media_probe))
        .route(
            "/api/media/probe-playlist",
            get(handle_native_media_probe_playlist),
        )
        .route(
            "/api/media/bridge/probe",
            get(handle_deprecated_media_bridge_probe),
        )
        .route(
            "/api/media/bridge/probe-playlist",
            get(handle_deprecated_media_bridge_playlist_probe),
        )
        .route(
            "/api/media/postprocess/status",
            get(handle_media_postprocess_status),
        )
}

#[cfg(test)]
mod tests {
    use super::probe_payload_from_cache;
    use crate::daemon::engine::metadata_cache::CachedMetadata;
    use std::collections::HashMap;

    #[test]
    fn cached_probe_preserves_digest_and_mirror_priorities() {
        let mut headers = HashMap::new();
        headers.insert(
            "linkMirrors".to_owned(),
            r#"["https://mirror-a.example/file.zip","https://mirror-b.example/file.zip"]"#
                .to_owned(),
        );
        headers.insert("mirrorPriorities".to_owned(), "[1,3]".to_owned());
        let cached = CachedMetadata {
            url: "https://origin.example/file.zip".to_owned(),
            filename: "file.zip".to_owned(),
            content_type: Some("application/zip".to_owned()),
            content_length: Some(1024),
            content_range: None,
            content_disposition: None,
            etag: Some("\"etag\"".to_owned()),
            last_modified: None,
            accept_ranges: true,
            checksum: Some("a".repeat(64)),
            headers,
            cached_at: "2026-08-17 00:00:00".to_owned(),
        };

        let payload = probe_payload_from_cache(&cached);
        assert_eq!(payload["digestSha256"], "a".repeat(64));
        assert_eq!(
            payload["linkMirrors"][0],
            "https://mirror-a.example/file.zip"
        );
        assert_eq!(payload["mirrorPriorities"], serde_json::json!([1, 3]));
    }
}
