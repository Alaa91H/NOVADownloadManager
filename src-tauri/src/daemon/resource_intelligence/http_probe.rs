use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::types::{
    CapabilityState, ErrorPhase, ProbeMethod, ProbeResult, RedirectChain, RedirectHop,
    ResolutionError, ResourceIdentity, ServerCapabilities,
};
use crate::daemon::utils::{infer_file_type, DEFAULT_USER_AGENT};

const PROBE_TIMEOUT_SECS: u64 = 15;
const PROBE_USER_AGENT: &str = DEFAULT_USER_AGENT;

pub struct HttpNegotiator<'a> {
    client: &'a reqwest::Client,
    url: String,
    custom_headers: HashMap<String, String>,
}

impl<'a> HttpNegotiator<'a> {
    pub fn new(client: &'a reqwest::Client, url: &str) -> Self {
        Self {
            client,
            url: url.to_owned(),
            custom_headers: HashMap::new(),
        }
    }

    pub fn with_headers(mut self, headers: HashMap<String, String>) -> Self {
        self.custom_headers = headers;
        self
    }

    pub async fn negotiate(&self) -> NegotiationResult {
        let start = Instant::now();
        let mut methods_attempted: Vec<ProbeMethod> = Vec::new();
        let mut errors: Vec<ResolutionError> = Vec::new();
        let mut redirect_chain = RedirectChain::default();

        // Stage 1: Fast HEAD probe.
        let head_result = self.probe_head().await;
        match &head_result {
            Some(r) => {
                methods_attempted.push(ProbeMethod::Head);
                if let Some(hop) = &r.redirect_hop {
                    redirect_chain.hops.push(hop.clone());
                }
                if let Some(err_msg) = &r.error {
                    errors.push(ResolutionError {
                        category: super::types::ErrorCategory::HttpFailure,
                        phase: ErrorPhase::HttpRequest,
                        message: err_msg.clone(),
                        http_status: Some(r.status_code),
                        retryable: r.status_code >= 500,
                        retry_after: None,
                    });
                }
            }
            None => {
                errors.push(ResolutionError {
                    category: super::types::ErrorCategory::ConnectionFailure,
                    phase: ErrorPhase::HttpRequest,
                    message: "HEAD request failed".to_owned(),
                    http_status: None,
                    retryable: true,
                    retry_after: None,
                });
            }
        }

        let head_payload = head_result.as_ref().filter(|r| r.status_code < 400);
        let has_size = head_payload
            .and_then(|r| r.headers.get("content-length"))
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&s| s > 0);
        let head_supports_range = head_payload
            .and_then(|r| r.headers.get("accept-ranges"))
            .is_some_and(|v| v.eq_ignore_ascii_case("bytes"))
            || head_payload
                .as_ref()
                .and_then(|r| r.headers.get("content-range"))
                .is_some_and(|v| v.to_lowercase().starts_with("bytes "));

        // Stage 2: GET Range: bytes=0-0 — proves range support + gets size + gets content.
        let range_result = self.probe_get_range().await;
        if let Some(r) = &range_result {
            methods_attempted.push(ProbeMethod::GetRange);
            if let Some(hop) = &r.redirect_hop {
                redirect_chain.hops.push(hop.clone());
            }
        }

        let range_payload = range_result.as_ref().filter(|r| r.status_code == 206);
        let range_proves_size = range_payload
            .and_then(|r| r.headers.get("content-range"))
            .and_then(|v| parse_content_range_total(v));
        let range_confirms_range = range_payload.is_some();

        // Stage 3: Fallback GET if HEAD and Range both failed to get size.
        let get_result = if has_size.is_none() && range_proves_size.is_none() {
            let r = self.probe_get().await;
            if let Some(ref res) = r {
                methods_attempted.push(ProbeMethod::Get);
                if let Some(hop) = &res.redirect_hop {
                    redirect_chain.hops.push(hop.clone());
                }
            }
            r
        } else {
            None
        };

        // Build resource identity from best available data.
        let final_url = range_payload
            .or(head_payload)
            .or(get_result.as_ref())
            .and_then(|r| r.final_url.clone())
            .unwrap_or_else(|| self.url.clone());

        let content_type = range_payload
            .or(head_payload)
            .or(get_result.as_ref())
            .and_then(|r| r.headers.get("content-type").cloned());

        let file_name = range_payload
            .or(head_payload)
            .or(get_result.as_ref())
            .and_then(|r| r.headers.get("content-disposition").cloned())
            .and_then(|cd| extract_filename_from_cd(&cd))
            .unwrap_or_else(|| extract_filename_from_url(&final_url));

        let file_type = infer_file_type(&file_name);

        let etag = range_payload
            .or(head_payload)
            .or(get_result.as_ref())
            .and_then(|r| r.headers.get("etag").cloned())
            .filter(|v| !v.is_empty());

        let last_modified = range_payload
            .or(head_payload)
            .or(get_result.as_ref())
            .and_then(|r| r.headers.get("last-modified").cloned())
            .filter(|v| !v.is_empty());

        let digest_sha256 = range_payload
            .or(head_payload)
            .or(get_result.as_ref())
            .and_then(extract_sha256_from_headers);

        let resource_identity = ResourceIdentity {
            final_url,
            content_type,
            content_length: has_size.or(range_proves_size),
            content_disposition: range_payload
                .or(head_payload)
                .and_then(|r| r.headers.get("content-disposition").cloned()),
            etag,
            last_modified,
            digest_sha256,
            file_name,
            file_type: file_type.to_owned(),
        };

        // Detect best final URL from redirects.
        redirect_chain.final_url = Some(resource_identity.final_url.clone());
        redirect_chain.security_downgrade =
            redirect_chain.hops.iter().any(|h| h.security_downgrade);
        redirect_chain.host_changes = redirect_chain
            .hops
            .iter()
            .filter(|h| h.host_changed)
            .map(|h| h.to.clone())
            .collect();
        redirect_chain.cross_origin = !redirect_chain.host_changes.is_empty();

        let best_method = if range_confirms_range {
            Some(ProbeMethod::GetRange)
        } else if head_payload.is_some() {
            Some(ProbeMethod::Head)
        } else {
            get_result.as_ref().map(|_| ProbeMethod::Get)
        };

        let mut capabilities = detect_capabilities(
            head_supports_range,
            range_confirms_range,
            has_size.or(range_proves_size),
            &head_result,
            &get_result,
        );

        // Extract RFC 6249 mirror URLs from Link headers across all probe
        // results. These feed into the mirror failover system so the download
        // engine can switch to an alternate source if the primary fails.
        let mut mirrors = Vec::new();
        for probe in [&head_result, &range_result, &get_result]
            .into_iter()
            .flatten()
        {
            for url in extract_link_mirrors(probe) {
                if !mirrors.contains(&url) {
                    mirrors.push(url);
                }
            }
        }
        capabilities.link_mirrors = mirrors;

        let total_duration = start.elapsed();

        NegotiationResult {
            resource_identity,
            redirect_chain,
            capabilities,
            head_result,
            range_result,
            get_result,
            methods_attempted,
            best_method,
            errors,
            total_duration,
        }
    }

    async fn probe_head(&self) -> Option<ProbeResult> {
        let start = Instant::now();
        let mut req = self
            .client
            .head(&self.url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS));

        for (k, v) in &self.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let final_url = resp.url().to_string();
                let headers = header_map_to_string(resp.headers());
                let hop = if final_url == self.url {
                    None
                } else {
                    Some(RedirectHop {
                        from: self.url.clone(),
                        to: final_url.clone(),
                        status_code: status,
                        method: "HEAD".to_owned(),
                        host_changed: extract_host(&final_url) != extract_host(&self.url),
                        scheme_changed: extract_scheme(&final_url) != extract_scheme(&self.url),
                        security_downgrade: extract_scheme(&self.url) == "https"
                            && extract_scheme(&final_url) == "http",
                    })
                };

                Some(ProbeResult {
                    method: ProbeMethod::Head,
                    status_code: status,
                    headers,
                    duration: start.elapsed(),
                    final_url: Some(final_url),
                    error: if status >= 400 {
                        Some(format!("HEAD returned {status}"))
                    } else {
                        None
                    },
                    redirect_hop: hop,
                })
            }
            Err(e) => Some(ProbeResult {
                method: ProbeMethod::Head,
                status_code: 0,
                headers: HashMap::new(),
                duration: start.elapsed(),
                final_url: None,

                error: Some(e.to_string()),
                redirect_hop: None,
            }),
        }
    }

    async fn probe_get_range(&self) -> Option<ProbeResult> {
        let start = Instant::now();
        let mut req = self
            .client
            .get(&self.url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::RANGE, "bytes=0-0")
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS));

        for (k, v) in &self.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let final_url = resp.url().to_string();
                let headers = header_map_to_string(resp.headers());
                let hop = if final_url == self.url {
                    None
                } else {
                    Some(RedirectHop {
                        from: self.url.clone(),
                        to: final_url.clone(),
                        status_code: status,
                        method: "GET".to_owned(),
                        host_changed: extract_host(&final_url) != extract_host(&self.url),
                        scheme_changed: extract_scheme(&final_url) != extract_scheme(&self.url),
                        security_downgrade: extract_scheme(&self.url) == "https"
                            && extract_scheme(&final_url) == "http",
                    })
                };

                Some(ProbeResult {
                    method: ProbeMethod::GetRange,
                    status_code: status,
                    headers,
                    duration: start.elapsed(),
                    final_url: Some(final_url),

                    error: None,
                    redirect_hop: hop,
                })
            }
            Err(e) => Some(ProbeResult {
                method: ProbeMethod::GetRange,
                status_code: 0,
                headers: HashMap::new(),
                duration: start.elapsed(),
                final_url: None,

                error: Some(e.to_string()),
                redirect_hop: None,
            }),
        }
    }

    async fn probe_get(&self) -> Option<ProbeResult> {
        let start = Instant::now();
        let mut req = self
            .client
            .get(&self.url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS));

        for (k, v) in &self.custom_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        match req.send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let final_url = resp.url().to_string();
                let headers = header_map_to_string(resp.headers());
                let hop = if final_url == self.url {
                    None
                } else {
                    Some(RedirectHop {
                        from: self.url.clone(),
                        to: final_url.clone(),
                        status_code: status,
                        method: "GET".to_owned(),
                        host_changed: extract_host(&final_url) != extract_host(&self.url),
                        scheme_changed: extract_scheme(&final_url) != extract_scheme(&self.url),
                        security_downgrade: extract_scheme(&self.url) == "https"
                            && extract_scheme(&final_url) == "http",
                    })
                };

                Some(ProbeResult {
                    method: ProbeMethod::Get,
                    status_code: status,
                    headers,
                    duration: start.elapsed(),
                    final_url: Some(final_url),

                    error: None,
                    redirect_hop: hop,
                })
            }
            Err(e) => Some(ProbeResult {
                method: ProbeMethod::Get,
                status_code: 0,
                headers: HashMap::new(),
                duration: start.elapsed(),
                final_url: None,

                error: Some(e.to_string()),
                redirect_hop: None,
            }),
        }
    }
}

fn detect_capabilities(
    head_supports_range: bool,
    range_confirmed: bool,
    size: Option<u64>,
    head_result: &Option<ProbeResult>,
    get_result: &Option<ProbeResult>,
) -> ServerCapabilities {
    let range_support = if range_confirmed || head_supports_range {
        CapabilityState::Confirmed
    } else {
        CapabilityState::Unknown
    };

    let resume_support = match &range_support {
        CapabilityState::Confirmed => CapabilityState::Confirmed,
        CapabilityState::NotSupported => CapabilityState::NotSupported,
        CapabilityState::Unknown => CapabilityState::Unknown,
    };

    let parallel_connections = if range_confirmed && size.unwrap_or(0) > 1_048_576 {
        CapabilityState::Confirmed
    } else {
        CapabilityState::Unknown
    };

    // Infer a reasonable connection count from the probe results. This feeds
    // into `background_resolve_and_start` → `rie_connections` → the curl
    // download thread so it doesn't default to a single connection when the
    // server clearly supports parallel ranges.
    let detected_connections = if range_confirmed {
        let size = size.unwrap_or(0);
        if size >= 100_000_000 {
            Some(8) // 100MB+ → aggressive parallelism
        } else if size >= 10_000_000 {
            Some(4) // 10MB+ → moderate parallelism
        } else if size >= 1_048_576 {
            Some(2) // 1MB+ → conservative parallelism
        } else {
            Some(1) // <1MB → single connection
        }
    } else {
        None // Unknown range support → let the engine decide
    };

    // Detect compression from Content-Encoding header.
    let compression = head_result
        .as_ref()
        .or(get_result.as_ref())
        .and_then(|r| r.headers.get("content-encoding"))
        .map_or(CapabilityState::Unknown, |ce| {
            if ce.eq_ignore_ascii_case("identity") {
                CapabilityState::NotSupported
            } else {
                CapabilityState::Confirmed
            }
        });

    // Detect chunked transfer from Transfer-Encoding header.
    let chunked_transfer = head_result
        .as_ref()
        .or(get_result.as_ref())
        .and_then(|r| r.headers.get("transfer-encoding"))
        .map_or(CapabilityState::Unknown, |te| {
            if te.to_ascii_lowercase().contains("chunked") {
                CapabilityState::Confirmed
            } else {
                CapabilityState::NotSupported
            }
        });

    // Detect HTTP/2 multiplexing from response status line (parsed into
    // header map as a synthetic key by the probe runner, or from the
    // Content-Type to at least know the server is modern).
    let http2_multiplexing = head_result
        .as_ref()
        .or(get_result.as_ref())
        .and_then(|r| r.headers.get("http-version"))
        .map_or(CapabilityState::Unknown, |hv| {
            if hv.starts_with('2') || hv.starts_with("h2") {
                CapabilityState::Confirmed
            } else {
                CapabilityState::NotSupported
            }
        });

    ServerCapabilities {
        range_support,
        resume_support,
        parallel_connections,
        compression,
        chunked_transfer,
        http2_multiplexing,
        content_length_reliable: if size.unwrap_or(0) > 0 {
            CapabilityState::Confirmed
        } else {
            CapabilityState::Unknown
        },
        detected_connections,
        link_mirrors: Vec::new(),
    }
}

fn header_map_to_string(map: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    map.iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|val| (k.as_str().to_owned(), val.to_owned()))
        })
        .collect()
}

fn extract_host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default()
}

fn extract_scheme(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .map(|u| u.scheme().to_owned())
        .unwrap_or_default()
}

fn parse_content_range_total(header: &str) -> Option<u64> {
    // Format: bytes 0-0/12345
    header.split('/').nth(1)?.trim().parse::<u64>().ok()
}

fn extract_filename_from_cd(cd: &str) -> Option<String> {
    // Try filename*=UTF-8''encoded first.
    if let Some(fstar) = cd.split(';').find(|s| s.contains("filename*=")) {
        if let Some(val) = fstar.split("filename*=").nth(1) {
            let val = val.trim().trim_matches('\'');
            if let Some(encoded) = val.split("''").nth(1) {
                return Some(percent_decode(encoded));
            }
        }
    }
    // Fallback to filename="..." or filename=...
    let cd_lower = cd.to_lowercase();
    if let Some(pos) = cd_lower.find("filename=") {
        let after = &cd[pos + "filename=".len()..];
        let name = after.trim().trim_matches('"').trim_matches('\'');
        let name = name.split(';').next().unwrap_or(name).trim();
        if !name.is_empty() {
            return Some(name.to_owned());
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let mut result = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| input.to_owned())
}

fn extract_filename_from_url(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| {
            let path = u.path();
            path.rsplit('/')
                .next()
                .filter(|s| !s.is_empty() && *s != "/")
                .map(String::from)
        })
        .unwrap_or_else(|| "download".to_owned())
}

fn extract_sha256_from_headers(result: &ProbeResult) -> Option<String> {
    // Check Digest header: sha-256=...
    if let Some(digest) = result.headers.get("digest") {
        if let Some(val) = digest.split("sha-256=").nth(1) {
            let val = val.trim().trim_end_matches(',').trim().to_owned();
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    // Check Content-Digest header (RFC 9530).
    if let Some(digest) = result.headers.get("content-digest") {
        if let Some(val) = digest.split("sha-256=").nth(1) {
            let val = val.trim().trim_end_matches(',').trim().to_owned();
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

fn extract_link_mirrors(result: &ProbeResult) -> Vec<String> {
    result
        .headers
        .get("link")
        .map(|link| {
            link.split(',')
                .filter_map(|part| {
                    let part = part.trim();
                    if part.contains("rel=\"duplicate\"") || part.contains("rel=duplicate") {
                        part.split('<').nth(1)?.split('>').next().map(String::from)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

pub struct NegotiationResult {
    pub resource_identity: ResourceIdentity,
    pub redirect_chain: RedirectChain,
    pub capabilities: ServerCapabilities,
    pub head_result: Option<ProbeResult>,
    pub range_result: Option<ProbeResult>,
    pub get_result: Option<ProbeResult>,
    pub methods_attempted: Vec<ProbeMethod>,
    pub best_method: Option<ProbeMethod>,
    pub errors: Vec<ResolutionError>,
    pub total_duration: Duration,
}
