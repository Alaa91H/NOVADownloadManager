use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;

use ::curl::easy::{
    Auth, Easy2, Handler, HttpVersion, IpResolve, List, NetRc, ProxyType, SslOpt, SslVersion,
    TimeCondition, WriteError,
};

use super::*;
use crate::daemon::direct::FileWriter;
use crate::daemon::utils::DEFAULT_USER_AGENT;
use sha2::Digest;

pub(crate) struct SegmentWriter {
    pub(super) file: File,
    pub(super) progress: SegmentProgress,
    pub(super) streaming_hasher: Option<sha2::Sha256>,
}

impl Handler for SegmentWriter {
    fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.progress.abort.load(Ordering::Relaxed) {
            return Ok(0);
        }
        if let Some(ref mut hasher) = self.streaming_hasher {
            sha2::Digest::update(hasher, data);
        }
        match self.file.write_all(data) {
            Ok(()) => {
                self.progress
                    .downloaded
                    .fetch_add(data.len() as u64, Ordering::Relaxed);
                Ok(data.len())
            }
            Err(e) => {
                log::warn!("SegmentWriter write error: {}", e);
                self.progress.abort.store(true, Ordering::Relaxed);
                Err(WriteError::Pause)
            }
        }
    }

    fn progress(&mut self, _dltotal: f64, _dlnow: f64, _ultotal: f64, _ulnow: f64) -> bool {
        !self.progress.abort.load(Ordering::Relaxed)
    }

    fn header(&mut self, data: &[u8]) -> bool {
        let Ok(line) = std::str::from_utf8(data) else {
            return true;
        };
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("HTTP/") {
            if let Some(code) = rest.split_whitespace().nth(1).and_then(|c| c.parse().ok()) {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    cap.status_code = code;
                }
            }
            return true;
        }
        let Some((name, value)) = line.split_once(':') else {
            return true;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "retry-after" => {
                if let Ok(secs) = value.parse::<u64>() {
                    self.progress
                        .retry_after
                        .store(secs.min(600), Ordering::Relaxed);
                } else if let Some(secs) = crate::daemon::utils::parse_retry_after_date(value) {
                    self.progress
                        .retry_after
                        .store(secs.min(600), Ordering::Relaxed);
                }
            }
            "etag" => {
                if crate::daemon::utils::is_strong_etag(value) {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        cap.validator = Some(value.to_string());
                    }
                }
            }
            "last-modified" => {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    if cap.validator.is_none() {
                        cap.validator = Some(value.to_string());
                    }
                }
            }
            "repr-digest" | "content-digest" | "digest" => {
                if let Some(d) = crate::daemon::utils::parse_sha256_digest(value) {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        cap.digest_sha256 = Some(d);
                    }
                    if self.streaming_hasher.is_none() {
                        self.streaming_hasher = Some(sha2::Sha256::new());
                    }
                }
            }
            "link" => {
                if let Some(url) = crate::daemon::utils::parse_link_duplicate_single(value) {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        cap.mirrors.push(url);
                    }
                }
            }
            _ => {}
        }
        true
    }
}

impl Drop for SegmentWriter {
    fn drop(&mut self) {
        if let Some(hasher) = self.streaming_hasher.take() {
            let hex = format!("{:x}", hasher.finalize());
            if let Ok(mut slot) = self.progress.streaming_digest_out.lock() {
                *slot = Some(hex);
            }
        }
    }
}

const HTML_HEAD_CAPTURE_LIMIT: usize = 64 * 1024;
#[derive(Default)]
pub(crate) struct HtmlHeadCapture {
    body: Vec<u8>,
}
impl Handler for HtmlHeadCapture {
    fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.body.len() < HTML_HEAD_CAPTURE_LIMIT {
            let remaining = HTML_HEAD_CAPTURE_LIMIT - self.body.len();
            self.body
                .extend_from_slice(&data[..data.len().min(remaining)]);
        }
        Ok(data.len())
    }
}
impl HtmlHeadCapture {
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

static CA_BUNDLE_PATH: OnceLock<String> = OnceLock::new();

fn installed_ca_bundle_path() -> &'static str {
    CA_BUNDLE_PATH.get_or_init(|| {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(parent) = exe_path.parent() {
                let candidate = parent.join("cacert.pem");
                if candidate.exists() {
                    return candidate.display().to_string();
                }
            }
        }
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let candidate = manifest.join("cacert.pem");
        if candidate.exists() {
            return candidate.display().to_string();
        }
        String::new()
    })
}

static SSL_INIT: OnceLock<()> = OnceLock::new();

pub fn init_download_ssl() {
    SSL_INIT.get_or_init(|| {
        let ca_path = installed_ca_bundle_path();
        if !ca_path.is_empty() {
            log::info!("curl SSL using bundled CA: {}", ca_path);
        } else {
            log::warn!("No bundled CA certificate found; HTTPS downloads may fail if OpenSSL cannot locate system CA certs.");
        }
    });
}

fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}/"))
}

fn if_range_header(plan: &DirectDownloadPlan) -> Option<String> {
    let validator = plan.validator.as_ref()?;
    if plan.validator_is_etag {
        if crate::daemon::utils::is_strong_etag(validator) {
            Some(format!("If-Range: {}", validator))
        } else {
            None
        }
    } else {
        Some(format!("If-Range: {}", validator))
    }
}

fn direct_headers(opts: &HashMap<String, serde_json::Value>) -> Result<Option<List>, String> {
    let mut list = List::new();
    let mut has_any = false;
    if let Some(raw_headers) = direct_str(opts, "headers") {
        for line in raw_headers
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if line.contains(':') {
                if !safe_value(line) {
                    return Err("Rejected unsafe header value".to_string());
                }
                list.append(line)
                    .map_err(|e| format!("Could not apply header: {e}"))?;
                has_any = true;
            }
        }
    }
    Ok(if has_any { Some(list) } else { None })
}

pub(crate) fn apply_easy_options<H: Handler>(
    easy: &mut Easy2<H>,
    plan: &DirectDownloadPlan,
    range: Option<(u64, u64)>,
) -> Result<(), String> {
    let opts = &plan.direct_options;
    easy.url(&plan.url)
        .map_err(|e| format!("Invalid URL: {e}"))?;
    easy.get(true)
        .map_err(|e| format!("Could not configure GET: {e}"))?;
    easy.follow_location(plan.follow_redirects)
        .map_err(|e| format!("Could not configure redirects: {e}"))?;
    easy.fail_on_error(plan.fail_on_error)
        .map_err(|e| format!("Could not configure fail-on-error: {e}"))?;
    easy.progress(true)
        .map_err(|e| format!("Could not enable progress callback: {e}"))?;
    if direct_u64(opts, "maxRedirs").is_none() {
        easy.max_redirections(20)
            .map_err(|e| format!("Could not configure default redirect limit: {e}"))?;
    }
    easy.autoreferer(true)
        .map_err(|e| format!("Could not enable auto-referer: {e}"))?;
    easy.tcp_keepalive(true)
        .map_err(|e| format!("Could not enable TCP keepalive: {e}"))?;

    let mut conditional_headers: Vec<String> = Vec::new();

    if let Some((start, end)) = range {
        easy.range(&format!("{}-{}", start, end))
            .map_err(|e| format!("Could not configure range: {e}"))?;
    } else if plan.resumable {
        let existing = FileWriter::current_size(&plan.output_path);
        if existing > 0 {
            easy.resume_from(existing)
                .map_err(|e| format!("Could not configure resume: {e}"))?;
        }
    }
    if let Some(val) = if_range_header(plan) {
        conditional_headers.push(val);
    }

    if let Some(proxy) = direct_str(opts, "proxy") {
        easy.proxy(proxy)
            .map_err(|e| format!("Could not configure proxy: {e}"))?;
    }
    if let Some(no_proxy) = direct_str(opts, "noproxy") {
        easy.noproxy(no_proxy)
            .map_err(|e| format!("Could not configure noproxy: {e}"))?;
    }
    if let Some(interface) =
        direct_str(opts, "sourceAddress").or_else(|| direct_str(opts, "interface"))
    {
        easy.interface(interface)
            .map_err(|e| format!("Could not bind source interface: {e}"))?;
    }
    let user_agent = direct_str(opts, "userAgent").unwrap_or(DEFAULT_USER_AGENT);
    easy.useragent(user_agent)
        .map_err(|e| format!("Could not configure user-agent: {e}"))?;
    if let Some(referer) = plan.referer.as_deref() {
        easy.referer(referer)
            .map_err(|e| format!("Could not configure referer: {e}"))?;
    } else if let Some(origin) = url_origin(&plan.url) {
        let _ = easy.referer(&origin);
    }
    if let Some(cookies) = direct_str(opts, "cookies") {
        easy.cookie(cookies)
            .map_err(|e| format!("Could not configure cookies: {e}"))?;
    }
    if direct_bool(opts, "compressed") != Some(false) {
        easy.accept_encoding("")
            .map_err(|e| format!("Could not enable compression: {e}"))?;
    }
    if direct_bool(opts, "insecure") == Some(true) {
        log::warn!(
            "TLS verification disabled via 'insecure' option for download from {}",
            plan.url
        );
        easy.ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable TLS peer verification: {e}"))?;
        easy.ssl_verify_host(false)
            .map_err(|e| format!("Could not disable TLS host verification: {e}"))?;
    }
    if let Some(ca) = direct_str(opts, "caCert") {
        easy.cainfo(ca)
            .map_err(|e| format!("Could not configure CA file: {e}"))?;
    } else if !installed_ca_bundle_path().is_empty() {
        if let Err(e) = easy.cainfo(installed_ca_bundle_path()) {
            log::warn!("Could not set bundled CA file: {}", e);
        }
    }
    if let Some(doh) = direct_str(opts, "dohUrl") {
        easy.doh_url(Some(doh))
            .map_err(|e| format!("Could not configure DNS-over-HTTPS: {e}"))?;
    }
    if let Some(dns) = direct_str(opts, "dnsServers") {
        easy.dns_servers(dns)
            .map_err(|e| format!("Could not configure DNS servers: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "dnsCacheTimeoutSec") {
        easy.dns_cache_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure DNS cache timeout: {e}"))?;
    }
    if let Some(jar) = direct_str(opts, "cookieJar") {
        easy.cookie_jar(jar)
            .map_err(|e| format!("Could not configure cookie jar: {e}"))?;
    }
    if let Some(pubkey) = direct_str(opts, "pinnedPubKey") {
        easy.pinned_public_key(pubkey)
            .map_err(|e| format!("Could not configure certificate pinning: {e}"))?;
    }
    if let Some(size) = direct_u64(opts, "maxFilesize").filter(|v| *v > 0) {
        easy.max_filesize(size)
            .map_err(|e| format!("Could not configure max file size: {e}"))?;
    }
    if let Some(size) = direct_u64(opts, "bufferSize").filter(|v| *v > 0) {
        easy.buffer_size(size as usize)
            .map_err(|e| format!("Could not configure buffer size: {e}"))?;
    }
    if let Some(speed) = direct_u64(opts, "speedLimitBytes")
        .or_else(|| direct_u64(opts, "speedLimitKbs").map(|v| v * 1024))
        .filter(|v| *v > 0)
    {
        easy.max_recv_speed(speed)
            .map_err(|e| format!("Could not configure speed limit: {e}"))?;
    }
    if let Some(limit) = direct_u64(opts, "lowSpeedLimitBytes").filter(|v| *v > 0) {
        easy.low_speed_limit(limit.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure low-speed limit: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "speedTimeSec").filter(|v| *v > 0) {
        easy.low_speed_time(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure low-speed time: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "timeoutSec").filter(|v| *v > 0) {
        easy.timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure timeout: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "connectTimeoutSec").filter(|v| *v > 0) {
        easy.connect_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure connect timeout: {e}"))?;
    }
    if let Some(max) = direct_u64(opts, "maxRedirs") {
        easy.max_redirections(max.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure redirect limit: {e}"))?;
    }
    if direct_u64(opts, "connectTimeoutSec").is_none() {
        let _ = easy.connect_timeout(Duration::from_secs(30));
    }
    if direct_u64(opts, "lowSpeedLimitBytes").is_none()
        && direct_u64(opts, "speedTimeSec").is_none()
    {
        let _ = easy.low_speed_limit(500);
        let _ = easy.low_speed_time(Duration::from_secs(15));
    }
    if let Some(user) = direct_str(opts, "username") {
        easy.username(user)
            .map_err(|e| format!("Could not configure username: {e}"))?;
    }
    if let Some(pass) = direct_str(opts, "password") {
        easy.password(pass)
            .map_err(|e| format!("Could not configure password: {e}"))?;
    }
    if let Some(auth_type) = direct_str(opts, "authType") {
        let mut auth = Auth::new();
        let lower = auth_type.to_ascii_lowercase();
        match lower.as_str() {
            "basic" => {
                auth.basic(true);
            }
            "digest" => {
                auth.digest(true);
            }
            "ntlm" => {
                auth.ntlm(true);
            }
            "negotiate" | "gssapi" => {
                auth.gssnegotiate(true);
            }
            "any" => {
                auth.auto(true);
            }
            _ => {
                auth.basic(true);
            }
        }
        easy.http_auth(&auth)
            .map_err(|e| format!("Could not configure HTTP auth: {e}"))?;
    }
    if let Some(netrc_val) = direct_str(opts, "netrc") {
        let lower = netrc_val.to_ascii_lowercase();
        match lower.as_str() {
            "optional" | "yes" => easy
                .netrc(NetRc::Optional)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            "required" | "true" | "on" => easy
                .netrc(NetRc::Required)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            "no" | "false" | "off" | "ignored" => easy
                .netrc(NetRc::Ignored)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            _ => easy
                .netrc(NetRc::Optional)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
        }
    }
    if direct_bool(opts, "netrcOptional") == Some(true) {
        easy.netrc(NetRc::Optional)
            .map_err(|e| format!("Could not configure netrc-optional: {e}"))?;
    }
    if let Some(cert) = direct_str(opts, "cert") {
        easy.ssl_cert(cert)
            .map_err(|e| format!("Could not configure SSL certificate: {e}"))?;
    }
    if let Some(cert_type) = direct_str(opts, "certType") {
        easy.ssl_cert_type(cert_type)
            .map_err(|e| format!("Could not configure certificate type: {e}"))?;
    }
    if let Some(key) = direct_str(opts, "key") {
        easy.ssl_key(key)
            .map_err(|e| format!("Could not configure SSL key: {e}"))?;
    }
    if let Some(key_type) = direct_str(opts, "keyType") {
        easy.ssl_key_type(key_type)
            .map_err(|e| format!("Could not configure key type: {e}"))?;
    }
    if let Some(key_pass) = direct_str(opts, "pass") {
        easy.key_password(key_pass)
            .map_err(|e| format!("Could not configure key password: {e}"))?;
    }
    if let Some(ciphers) = direct_str(opts, "ciphers") {
        easy.ssl_cipher_list(ciphers)
            .map_err(|e| format!("Could not configure TLS cipher list: {e}"))?;
    }
    if let Some(tls_max) = direct_str(opts, "tlsMax") {
        let lower = tls_max.to_ascii_lowercase();
        let max_ver = match lower.as_str() {
            "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
            "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
            "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
            "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = max_ver {
            easy.ssl_min_max_version(SslVersion::Default, ver)
                .map_err(|e| format!("Could not configure TLS max version: {e}"))?;
        }
    }
    if let Some(ca_path) = direct_str(opts, "caPath") {
        easy.capath(ca_path)
            .map_err(|e| format!("Could not configure CA path: {e}"))?;
    }
    if direct_bool(opts, "sslReqd") == Some(true) {
        easy.ssl_verify_peer(true)
            .map_err(|e| format!("Could not enable SSL peer verification: {e}"))?;
        easy.ssl_verify_host(true)
            .map_err(|e| format!("Could not enable SSL host verification: {e}"))?;
    }
    if let Some(proxy_user) = direct_str(opts, "proxyUser") {
        if let Some(proxy_pass) = direct_str(opts, "proxyPassword") {
            let cred = format!("{}:{}", proxy_user, proxy_pass);
            easy.proxy_username(&cred)
                .map_err(|e| format!("Could not configure proxy credentials: {e}"))?;
        } else {
            easy.proxy_username(proxy_user)
                .map_err(|e| format!("Could not configure proxy username: {e}"))?;
        }
    }
    if let Some(proxy_auth_val) = direct_str(opts, "proxyAnyAuth") {
        let lower = proxy_auth_val.to_ascii_lowercase();
        let mut auth = Auth::new();
        match lower.as_str() {
            "basic" => {
                auth.basic(true);
            }
            "digest" => {
                auth.digest(true);
            }
            "ntlm" => {
                auth.ntlm(true);
            }
            "negotiate" | "gssapi" => {
                auth.gssnegotiate(true);
            }
            "any" | "auto" => {
                auth.auto(true);
            }
            _ => {
                auth.auto(true);
            }
        }
        easy.proxy_auth(&auth)
            .map_err(|e| format!("Could not configure proxy auth: {e}"))?;
    }
    if direct_bool(opts, "remoteTime") == Some(true) {
        easy.fetch_filetime(true)
            .map_err(|e| format!("Could not enable remote time fetch: {e}"))?;
    }
    if let Some(method) = direct_str(opts, "requestMethod") {
        easy.custom_request(method)
            .map_err(|e| format!("Could not configure custom request method: {e}"))?;
    }
    if let Some(post_data) = direct_str(opts, "data") {
        easy.post_fields_copy(post_data.as_bytes())
            .map_err(|e| format!("Could not configure POST data: {e}"))?;
    }
    if let Some(time_cond) = direct_str(opts, "timeCond") {
        let lower = time_cond.to_ascii_lowercase();
        let cond = match lower.as_str() {
            "if-modified-since" | "modified" => Some(TimeCondition::IfModifiedSince),
            "if-unmodified-since" | "unmodified" => Some(TimeCondition::IfUnmodifiedSince),
            _ => None,
        };
        if let Some(c) = cond {
            easy.time_condition(c)
                .map_err(|e| format!("Could not configure time condition: {e}"))?;
            if let Some(ts) = direct_u64(opts, "timeValue") {
                easy.time_value(ts as i64)
                    .map_err(|e| format!("Could not configure time value: {e}"))?;
            }
        }
    }
    if direct_bool(opts, "tcpNoDelay") == Some(true) {
        easy.tcp_nodelay(true)
            .map_err(|e| format!("Could not enable TCP no-delay: {e}"))?;
    }
    if direct_bool(opts, "pathAsIs") == Some(true) {
        easy.path_as_is(true)
            .map_err(|e| format!("Could not enable path-as-is: {e}"))?;
    }
    if let Some(keepalive_sec) = direct_u64(opts, "keepaliveTimeSec").filter(|v| *v > 0) {
        let dur = Duration::from_secs(keepalive_sec);
        easy.tcp_keepidle(dur)
            .map_err(|e| format!("Could not configure keepalive idle time: {e}"))?;
        easy.tcp_keepintvl(dur)
            .map_err(|e| format!("Could not configure keepalive interval: {e}"))?;
    }
    let resolve_entries = direct_array(opts, "resolve");
    if !resolve_entries.is_empty() {
        let mut list = List::new();
        for entry in &resolve_entries {
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add DNS resolve entry: {e}"))?;
        }
        easy.resolve(list)
            .map_err(|e| format!("Could not configure DNS resolve overrides: {e}"))?;
    }
    let connect_to_entries = direct_array(opts, "connectTo");
    if !connect_to_entries.is_empty() {
        let mut list = List::new();
        for entry in &connect_to_entries {
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add connect-to entry: {e}"))?;
        }
        easy.connect_to(list)
            .map_err(|e| format!("Could not configure connect-to overrides: {e}"))?;
    }
    if let Some(max_connects) = direct_u64(opts, "maxConnects").filter(|v| *v > 0) {
        easy.max_connects(max_connects.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure max connects: {e}"))?;
    }
    match direct_str(opts, "httpVersion")
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "1.0" | "http1.0" => easy
            .http_version(HttpVersion::V10)
            .map_err(|e| format!("Could not force HTTP/1.0: {e}"))?,
        "1.1" | "http1.1" => easy
            .http_version(HttpVersion::V11)
            .map_err(|e| format!("Could not force HTTP/1.1: {e}"))?,
        "2" | "http2" => easy
            .http_version(HttpVersion::V2)
            .map_err(|e| format!("Could not force HTTP/2: {e}"))?,
        "2-prior-knowledge" | "http2-prior-knowledge" => easy
            .http_version(HttpVersion::V2PriorKnowledge)
            .map_err(|e| format!("Could not force HTTP/2 prior knowledge: {e}"))?,
        "3" | "http3" | "3-only" | "http3-only" => easy
            .http_version(HttpVersion::V3)
            .map_err(|e| format!("Could not force HTTP/3: {e}"))?,
        _ => {}
    }
    if let Some(ip) = direct_str(opts, "ipResolve") {
        let lower = ip.to_ascii_lowercase();
        match lower.as_str() {
            "4" | "ipv4" | "4-only" => easy
                .ip_resolve(IpResolve::V4)
                .map_err(|e| format!("Could not force IPv4: {e}"))?,
            "6" | "ipv6" | "6-only" => easy
                .ip_resolve(IpResolve::V6)
                .map_err(|e| format!("Could not force IPv6: {e}"))?,
            _ => {}
        }
    }
    if let Some(tls_min) = direct_str(opts, "tlsMin") {
        let lower = tls_min.to_ascii_lowercase();
        let min_ver = match lower.as_str() {
            "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
            "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
            "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
            "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = min_ver {
            easy.ssl_min_max_version(ver, SslVersion::Default)
                .map_err(|e| format!("Could not configure TLS min version: {e}"))?;
        }
    }
    if let (Some(tls_min), Some(tls_max)) = (direct_str(opts, "tlsMin"), direct_str(opts, "tlsMax"))
    {
        let parse_ver = |s: &str| -> Option<SslVersion> {
            let l = s.to_ascii_lowercase();
            match l.as_str() {
                "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
                "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
                "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
                "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
                _ => None,
            }
        };
        if let (Some(min_v), Some(max_v)) = (parse_ver(tls_min), parse_ver(tls_max)) {
            easy.ssl_min_max_version(min_v, max_v)
                .map_err(|e| format!("Could not configure TLS version range: {e}"))?;
        }
    }
    if let Some(opts_str) = direct_str(opts, "sslOptions") {
        let mut ssl_opt = SslOpt::new();
        let lower = opts_str.to_ascii_lowercase();
        if lower.contains("no-revoke") {
            ssl_opt.no_revoke(true);
        }
        if lower.contains("no-partial") {
            ssl_opt.no_partial_chain(true);
        }
        if lower.contains("native-ca") {
            ssl_opt.native_ca(true);
        }
        if lower.contains("auto-client-cert") {
            ssl_opt.auto_client_cert(true);
        }
        easy.ssl_options(&ssl_opt)
            .map_err(|e| format!("Could not configure SSL options: {e}"))?;
    }
    if let Some(crl) = direct_str(opts, "crlFile") {
        easy.crlfile(crl)
            .map_err(|e| format!("Could not configure CRL file: {e}"))?;
    }
    if let Some(issuer) = direct_str(opts, "issuerCert") {
        easy.issuer_cert(issuer)
            .map_err(|e| format!("Could not configure issuer certificate: {e}"))?;
    }
    if direct_bool(opts, "sslSessionIdCache") == Some(false) {
        easy.ssl_sessionid_cache(false)
            .map_err(|e| format!("Could not disable SSL session ID cache: {e}"))?;
    }
    if let Some(proxy_cainfo) = direct_str(opts, "proxyCaInfo") {
        easy.proxy_cainfo(proxy_cainfo)
            .map_err(|e| format!("Could not configure proxy CA info: {e}"))?;
    }
    if let Some(proxy_capath) = direct_str(opts, "proxyCaPath") {
        easy.proxy_capath(proxy_capath)
            .map_err(|e| format!("Could not configure proxy CA path: {e}"))?;
    }
    if let Some(proxy_cert) = direct_str(opts, "proxyCert") {
        easy.proxy_sslcert(proxy_cert)
            .map_err(|e| format!("Could not configure proxy SSL cert: {e}"))?;
    }
    if let Some(proxy_cert_type) = direct_str(opts, "proxyCertType") {
        easy.proxy_sslcert_type(proxy_cert_type)
            .map_err(|e| format!("Could not configure proxy cert type: {e}"))?;
    }
    if let Some(proxy_key) = direct_str(opts, "proxyKey") {
        easy.proxy_sslkey(proxy_key)
            .map_err(|e| format!("Could not configure proxy SSL key: {e}"))?;
    }
    if let Some(proxy_key_type) = direct_str(opts, "proxyKeyType") {
        easy.proxy_sslkey_type(proxy_key_type)
            .map_err(|e| format!("Could not configure proxy key type: {e}"))?;
    }
    if let Some(proxy_key_pass) = direct_str(opts, "proxyKeyPassword") {
        easy.proxy_key_password(proxy_key_pass)
            .map_err(|e| format!("Could not configure proxy key password: {e}"))?;
    }
    if let Some(proxy_cipher) = direct_str(opts, "proxyCiphers") {
        easy.proxy_ssl_cipher_list(proxy_cipher)
            .map_err(|e| format!("Could not configure proxy cipher list: {e}"))?;
    }
    if let Some(proxy_tls_max) = direct_str(opts, "proxyTlsMax") {
        let lower = proxy_tls_max.to_ascii_lowercase();
        let max_ver = match lower.as_str() {
            "1.0" => Some(SslVersion::Tlsv10),
            "1.1" => Some(SslVersion::Tlsv11),
            "1.2" => Some(SslVersion::Tlsv12),
            "1.3" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = max_ver {
            easy.proxy_ssl_min_max_version(SslVersion::Default, ver)
                .map_err(|e| format!("Could not configure proxy TLS max version: {e}"))?;
        }
    }
    if let Some(proxy_tls_min) = direct_str(opts, "proxyTlsMin") {
        let lower = proxy_tls_min.to_ascii_lowercase();
        let min_ver = match lower.as_str() {
            "1.0" => Some(SslVersion::Tlsv10),
            "1.1" => Some(SslVersion::Tlsv11),
            "1.2" => Some(SslVersion::Tlsv12),
            "1.3" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = min_ver {
            easy.proxy_ssl_min_max_version(ver, SslVersion::Default)
                .map_err(|e| format!("Could not configure proxy TLS min version: {e}"))?;
        }
    }
    if direct_bool(opts, "proxyVerifyPeer") == Some(false) {
        easy.proxy_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable proxy peer verification: {e}"))?;
    }
    if direct_bool(opts, "proxyVerifyHost") == Some(false) {
        easy.proxy_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable proxy host verification: {e}"))?;
    }
    if let Some(proxy_type_val) = direct_str(opts, "proxyType") {
        let lower = proxy_type_val.to_ascii_lowercase();
        let pt = match lower.as_str() {
            "socks4" => Some(ProxyType::Socks4),
            "socks5" => Some(ProxyType::Socks5),
            "socks4a" => Some(ProxyType::Socks4a),
            "socks5h" => Some(ProxyType::Socks5Hostname),
            _ => None,
        };
        if let Some(pt_val) = pt {
            easy.proxy_type(pt_val)
                .map_err(|e| format!("Could not configure proxy type: {e}"))?;
        }
    }
    if direct_bool(opts, "proxyTunnel") == Some(true) {
        easy.http_proxy_tunnel(true)
            .map_err(|e| format!("Could not enable proxy tunnel: {e}"))?;
    }
    if direct_bool(opts, "unrestrictedAuth") == Some(true) {
        easy.unrestricted_auth(true)
            .map_err(|e| format!("Could not enable unrestricted auth: {e}"))?;
    }
    if direct_bool(opts, "transferEncoding") == Some(true) {
        easy.transfer_encoding(true)
            .map_err(|e| format!("Could not enable transfer encoding: {e}"))?;
    }
    if direct_bool(opts, "http09Allowed") == Some(true) {
        easy.http_09_allowed(true)
            .map_err(|e| format!("Could not enable HTTP/0.9: {e}"))?;
    }
    if let Some(timeout) = direct_u64(opts, "expect100TimeoutMs") {
        easy.expect_100_timeout(Duration::from_millis(timeout))
            .map_err(|e| format!("Could not configure expect-100 timeout: {e}"))?;
    }
    if direct_bool(opts, "freshConnect") == Some(true) {
        easy.fresh_connect(true)
            .map_err(|e| format!("Could not force fresh connection: {e}"))?;
    }
    if direct_bool(opts, "forbidReuse") == Some(true) {
        easy.forbid_reuse(true)
            .map_err(|e| format!("Could not forbid connection reuse: {e}"))?;
    }
    if let Some(age) = direct_u64(opts, "maxAgeConn") {
        easy.maxage_conn(Duration::from_secs(age))
            .map_err(|e| format!("Could not configure max connection age: {e}"))?;
    }
    if let Some(range) = direct_str(opts, "localPortRange") {
        if let Some((start, _end)) = range.split_once('-') {
            if let Ok(s) = start.trim().parse::<u16>() {
                easy.local_port_range(s)
                    .map_err(|err| format!("Could not configure local port range: {err}"))?;
            }
        }
    }
    if direct_bool(opts, "dohSslVerifyPeer") == Some(false) {
        easy.doh_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable DoH peer verification: {e}"))?;
    }
    if direct_bool(opts, "dohSslVerifyHost") == Some(false) {
        easy.doh_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable DoH host verification: {e}"))?;
    }
    let mut header_list: List = if let Some(headers) = direct_headers(opts)? {
        headers
    } else {
        let mut list = List::new();
        list.append("Accept: */*")
            .map_err(|e| format!("Could not add Accept header: {e}"))?;
        list.append("Accept-Language: en-US,en;q=0.9")
            .map_err(|e| format!("Could not add Accept-Language header: {e}"))?;
        list.append("Cache-Control: no-store")
            .map_err(|e| format!("Could not add Cache-Control header: {e}"))?;
        list.append("Connection: keep-alive")
            .map_err(|e| format!("Could not add Connection header: {e}"))?;
        if plan.digest_sha256.is_none() {
            list.append("Want-Digest: sha-256")
                .map_err(|e| format!("Could not add Want-Digest header: {e}"))?;
            list.append("Want-Content-Digest: sha-256")
                .map_err(|e| format!("Could not add Want-Content-Digest header: {e}"))?;
        }
        if let Some(bearer) = direct_str(opts, "oauth2Bearer") {
            list.append(&format!("Authorization: Bearer {}", bearer))
                .map_err(|e| format!("Could not add OAuth2 bearer header: {e}"))?;
        }
        list
    };
    for hdr in &conditional_headers {
        header_list
            .append(hdr)
            .map_err(|e| format!("Could not add conditional header: {e}"))?;
    }
    if let Some(etag_file) = direct_str(opts, "etagCompare") {
        if let Ok(etag_value) = std::fs::read_to_string(etag_file) {
            let etag_value = etag_value.trim().to_string();
            if !etag_value.is_empty() {
                header_list
                    .append(&format!("If-None-Match: {}", etag_value))
                    .map_err(|e| format!("Could not add If-None-Match header: {e}"))?;
            }
        }
    }
    easy.http_headers(header_list)
        .map_err(|e| format!("Could not configure HTTP headers: {e}"))?;
    Ok(())
}

pub(crate) fn create_easy_for_range_ext(
    plan: &DirectDownloadPlan,
    path: &Path,
    progress: SegmentProgress,
    range: Option<(u64, u64)>,
    bandwidth_limit: Option<u64>,
    preallocate_bytes: Option<u64>,
) -> Result<Easy2<SegmentWriter>, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create segment folder: {e}"))?;
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Could not open segment output file: {e}"))?;
    if let Some(size) = preallocate_bytes {
        let current = file
            .metadata()
            .map(|m| m.len())
            .unwrap_or(0);
        if current == 0 && size > 0 {
            file.set_len(size)
                .map_err(|e| format!("Could not preallocate segment file (disk may be full): {e}"))?;
        }
    }
    let mut easy = Easy2::new(SegmentWriter {
        file,
        progress,
        streaming_hasher: None,
    });
    apply_easy_options(&mut easy, plan, range)?;
    if let Some(limit) = bandwidth_limit.filter(|l| *l > 0) {
        let _ = easy.max_recv_speed(limit);
    }
    Ok(easy)
}
