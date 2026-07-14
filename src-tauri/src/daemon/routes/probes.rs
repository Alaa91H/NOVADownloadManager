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

use super::common::*;
use crate::daemon::utils::{parse_meta_refresh_url, refreshed_url};

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
    let mirror_priorities: Vec<u64> = parsed_mirrors.iter().map(|m| m.priority as u64).collect();
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

/// Stage 1 of the smart probe: HEAD request
/// Returns the final URL after redirects (if HEAD succeeded), or None.
/// Sets `best_payload` if size was obtained.
async fn probe_stage_head(
    client: &reqwest::Client,
    url: &str,
    body: Option<&CreateDownloadBody>,
    best_payload: &mut Option<serde_json::Value>,
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
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    > 0;
                let has_range = payload
                    .get("supportsSegments")
                    .and_then(|v| v.as_bool())
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
                best_payload.as_ref().map(|_| final_url)
            }
        }
        Err(e) => {
            log::warn!("probe HEAD {} failed: {}", url, e);
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
        "linkMirrors": link_mirrors,
        "probeMethod": "metadata-cache"
    })
}

fn cache_probe_payload(state: &SharedState, url: &str, payload: &serde_json::Value) {
    let size = payload
        .get("sizeBytes")
        .and_then(|v| v.as_u64())
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
    let get_str = |key: &str| {
        payload
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let mut headers = HashMap::new();
    if let Some(final_url) = get_str("finalUrl") {
        headers.insert("finalUrl".to_string(), final_url);
    }
    if let Some(mirrors) = payload.get("linkMirrors").and_then(|v| v.as_array()) {
        if !mirrors.is_empty() {
            if let Ok(json) = serde_json::to_string(mirrors) {
                headers.insert("linkMirrors".to_string(), json);
            }
        }
    }
    state.metadata_cache.put(CachedMetadata {
        url: url.to_string(),
        filename: get_str("fileName").unwrap_or_default(),
        content_type: get_str("contentType").filter(|v| !v.is_empty()),
        content_length: Some(size),
        content_range: get_str("contentRange").filter(|v| !v.is_empty()),
        content_disposition: get_str("contentDisposition").filter(|v| !v.is_empty()),
        etag: get_str("etag").filter(|v| !v.is_empty()),
        last_modified: get_str("lastModified").filter(|v| !v.is_empty()),
        accept_ranges: payload
            .get("resumable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        checksum: None,
        headers,
        cached_at: chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
    });
}

pub(super) async fn probe_url_with_options(
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
        log::warn!("Blocked probe of unsafe URL {}: {}", url, e);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    // Serve recent probe results from the metadata cache to avoid re-hitting
    // origin servers for the same URL (probe â†’ add-download double request).
    if let Some(cached) = state.metadata_cache.get(url) {
        return Ok(Json(probe_payload_from_cache(&cached)));
    }

    let result = probe_url_uncached(state, url, body).await;
    if let Ok(Json(payload)) = &result {
        cache_probe_payload(state, url, payload);
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

    // â”€â”€ Stage 1: HEAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let final_url = probe_stage_head(&client, url, body, &mut best_payload).await;

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
                .and_then(|v| v.as_u64())
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
        }
        if is_html {
            log::info!(
                "probe GET range=0-0 {} -> HTML response (redirect page?), skipping to Stage 3b",
                url
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
                    .and_then(|v| v.as_u64())
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
                    "probe GET range=0-1023 {} -> HTML response (redirect page?), skipping to Stage 3b",
                    url
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
        let status_reason = resp.status().canonical_reason().unwrap_or("").to_string();
        let content_type = header_string(resp.headers(), "content-type");
        let headers_snapshot = resp.headers().clone();
        let content_length = resp.content_length().unwrap_or(0);
        const MAX_PROBE_BODY_BYTES: u64 = 2 * 1024 * 1024;
        let body_text = if content_length > MAX_PROBE_BODY_BYTES {
            String::new()
        } else {
            resp.text().await.unwrap_or_default()
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
                    .and_then(|v| v.as_u64())
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
                    log::info!("probe meta-refresh redirect for {}: {}", url, refresh_url);
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
            }
            // A challenge/interstitial page means the origin returned HTML
            // instead of the file; the download engine re-resolves the effective
            // URL and retries, so just note it here.
            if is_cloudflare_challenge(&body_text) {
                log::info!("probe: challenge/interstitial page detected for {}", url);
            }
        } else {
            log::warn!(
                "probe GET (encoding) {} -> {} {}",
                url,
                status,
                status_reason
            );
        }
        body_text
    } else {
        String::new()
    };

    // â”€â”€ Stage 4: Synthetic fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // All network attempts failed (timeout / DNS / TLS / 4xx-5xx).
    // Return minimal metadata derived from the URL alone so the UI can still
    // show a sensible filename and file type without crashing.
    let fname = fallback_file_name(url);
    Ok(Json(serde_json::json!({
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
    })))
}

pub async fn handle_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
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

pub async fn handle_ytdlp_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    if url.starts_with('-') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid url"})),
        ));
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked yt-dlp probe of unsafe URL {}: {}", url, e);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(
                &ytdlp_bin,
                &["--dump-json", "--no-playlist", "--no-warnings", "--", &url2],
            )
        }),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({"error": "Probe timed out"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp spawn failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp probe failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("yt-dlp probe stderr: {}", stderr);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Probe failed"})),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let info: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        log::error!("yt-dlp probe parse failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?;

    let duration = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let hours = (duration / 3600.0).floor();
    let minutes = ((duration % 3600.0) / 60.0).floor();
    let seconds = (duration % 60.0).floor();
    let duration_str = if hours > 0.0 {
        format!(
            "{:02}:{:02}:{:02}",
            hours as u64, minutes as u64, seconds as u64
        )
    } else {
        format!("{:02}:{:02}", minutes as u64, seconds as u64)
    };

    Ok(Json(serde_json::json!({
        "id": info.get("id"),
        "title": info.get("title"),
        "duration": duration,
        "durationString": duration_str,
        "thumbnail": info.get("thumbnail"),
        "webpageUrl": info.get("webpage_url"),
        "formats": info.get("formats"),
    })))
}

pub async fn handle_ytdlp_probe_playlist(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    if url.starts_with('-') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid url"})),
        ));
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked yt-dlp playlist probe of unsafe URL {}: {}", url, e);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(
                &ytdlp_bin,
                &[
                    "--flat-playlist",
                    "--dump-json",
                    "--no-warnings",
                    "--",
                    &url2,
                ],
            )
        }),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({"error": "Probe timed out"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp spawn failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp probe failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("yt-dlp probe playlist stderr: {}", stderr);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Probe failed"})),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut playlist_title = "Playlist".to_string();

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(info) = serde_json::from_str::<serde_json::Value>(line) {
            if playlist_title == "Playlist" {
                playlist_title = info
                    .get("playlist_title")
                    .or(info.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Playlist")
                    .to_string();
            }
            let dur = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let hours = (dur / 3600.0).floor();
            let minutes = ((dur % 3600.0) / 60.0).floor();
            let seconds = (dur % 60.0).floor();
            let dur_str = if hours > 0.0 {
                format!(
                    "{:02}:{:02}:{:02}",
                    hours as u64, minutes as u64, seconds as u64
                )
            } else {
                format!("{:02}:{:02}", minutes as u64, seconds as u64)
            };
            entries.push(serde_json::json!({
                "id": info.get("id"),
                "title": info.get("title"),
                "url": info.get("url").or(info.get("webpage_url")),
                "duration": dur,
                "durationString": dur_str,
                "thumbnail": info.get("thumbnail"),
                "index": info.get("playlist_index"),
            }));
        }
    }

    Ok(Json(serde_json::json!({
        "title": playlist_title,
        "webpageUrl": url,
        "entries": entries,
    })))
}

pub async fn handle_ytdlp_ffmpeg(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let available = hidden_output(&state.ffmpeg_bin, &["-version"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    Json(serde_json::json!({"available": available, "binary": state.ffmpeg_bin.clone()}))
}

pub(crate) fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/probe", get(handle_probe).post(handle_probe_post))
        .route("/api/ytdlp/probe", get(handle_ytdlp_probe))
        .route(
            "/api/ytdlp/probe-playlist",
            get(handle_ytdlp_probe_playlist),
        )
        .route("/api/ytdlp/ffmpeg", get(handle_ytdlp_ffmpeg))
}
