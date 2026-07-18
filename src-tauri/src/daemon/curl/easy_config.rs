use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::raw::c_long;
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

// Raw FFI constants for curl options not wrapped by the curl crate.
// CURLOPTTYPE_OBJECTPOINT == CURLOPTTYPE_STRINGPOINT == 10_000
const CURLOPT_PRE_PROXY: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 262;
const CURLOPT_NETRC_FILE: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 118;
const CURLOPT_TLS13_CIPHERS: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 276;
const CURLOPT_FTP_CREATE_MISSING_DIRS: curl_sys::CURLoption =
    curl_sys::CURLOPTTYPE_LONG + 110;
const CURLOPT_PROTOCOLS_STR: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 318;
const CURLOPT_REDIR_PROTOCOLS_STR: curl_sys::CURLoption =
    curl_sys::CURLOPTTYPE_OBJECTPOINT + 319;
const CURLOPT_DNS_INTERFACE: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 221;

unsafe fn raw_setopt_str(
    easy_ptr: *mut curl_sys::CURL,
    option: curl_sys::CURLoption,
    value: &str,
) -> Result<(), String> {
    let c_val =
        std::ffi::CString::new(value).map_err(|e| format!("Could not convert option to CString: {e}"))?;
    let code = unsafe { curl_sys::curl_easy_setopt(easy_ptr, option, c_val.as_ptr()) };
    if code == curl_sys::CURLE_OK {
        Ok(())
    } else {
        Err(format!("libcurl rejected option (code {})", code))
    }
}

unsafe fn raw_setopt_long(
    easy_ptr: *mut curl_sys::CURL,
    option: curl_sys::CURLoption,
    value: c_long,
) -> Result<(), String> {
    let code = unsafe { curl_sys::curl_easy_setopt(easy_ptr, option, value) };
    if code == curl_sys::CURLE_OK {
        Ok(())
    } else {
        Err(format!("libcurl rejected option (code {})", code))
    }
}

fn parse_rate_to_bytes(rate_str: &str) -> Option<u64> {
    let trimmed = rate_str.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (num_str, multiplier) = if let Some(s) = trimmed.strip_suffix(['T', 't']) {
        (s, 1024u64.pow(4))
    } else if let Some(s) = trimmed.strip_suffix(['G', 'g']) {
        (s, 1024u64.pow(3))
    } else if let Some(s) = trimmed.strip_suffix(['M', 'm']) {
        (s, 1024u64.pow(2))
    } else if let Some(s) = trimmed.strip_suffix(['K', 'k']) {
        (s, 1024)
    } else {
        (trimmed, 1)
    };
    let num: f64 = num_str.trim().parse().ok()?;
    Some((num * multiplier as f64) as u64)
}

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
            "etag" if crate::daemon::utils::is_strong_etag(value) => {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    cap.validator = Some(value.to_string());
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

        let build_link_mode = option_env!("NOVA_BUILD_LIBCURL_LINK_MODE").unwrap_or("unknown");
        let build_prefix = option_env!("NOVA_BUILD_LIBCURL_PREFIX").unwrap_or("unknown");
        if build_link_mode.contains("fallback") || build_prefix == "unmanaged" {
            log::warn!(
                "NOVA libcurl runtime: using fallback/system libcurl (link_mode={}, prefix={}). \
                 Native statically-built libcurl is not linked. TLS backend and protocol support \
                 may differ from production builds.",
                build_link_mode, build_prefix
            );
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

fn direct_headers(config: &CurlTransferConfig) -> Result<Option<List>, String> {
    let mut list = List::new();
    let mut has_any = false;
    if let Some(raw_headers) = config.str_("headers") {
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
    if plan.config.u64_("maxRedirs").is_none() {
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

    if let Some(proxy) = plan.config.str_("proxy") {
        easy.proxy(proxy)
            .map_err(|e| format!("Could not configure proxy: {e}"))?;
    }
    if let Some(pre_proxy) = plan.config.str_("preProxy") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_PRE_PROXY, pre_proxy)
                .map_err(|e| format!("Could not configure pre-proxy: {e}"))?;
        }
    }
    if let Some(no_proxy) = plan.config.str_("noproxy") {
        easy.noproxy(no_proxy)
            .map_err(|e| format!("Could not configure noproxy: {e}"))?;
    }
    if let Some(interface) = plan
        .config
        .str_("sourceAddress")
        .or_else(|| plan.config.str_("interface"))
    {
        easy.interface(interface)
            .map_err(|e| format!("Could not bind source interface: {e}"))?;
    }
    let user_agent = plan.config.str_("userAgent").unwrap_or(DEFAULT_USER_AGENT);
    easy.useragent(user_agent)
        .map_err(|e| format!("Could not configure user-agent: {e}"))?;
    if let Some(referer) = plan.referer.as_deref() {
        easy.referer(referer)
            .map_err(|e| format!("Could not configure referer: {e}"))?;
    } else if let Some(origin) = url_origin(&plan.url) {
        let _ = easy.referer(&origin);
    }
    if let Some(cookies) = plan.config.str_("cookies") {
        easy.cookie(cookies)
            .map_err(|e| format!("Could not configure cookies: {e}"))?;
    }
    if plan.config.bool_("compressed") != Some(false) {
        easy.accept_encoding("")
            .map_err(|e| format!("Could not enable compression: {e}"))?;
    }
    if plan.config.bool_("insecure") == Some(true) {
        log::warn!(
            "TLS verification disabled via 'insecure' option for download from {}",
            plan.url
        );
        easy.ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable TLS peer verification: {e}"))?;
        easy.ssl_verify_host(false)
            .map_err(|e| format!("Could not disable TLS host verification: {e}"))?;
    }
    if let Some(ca) = plan.config.str_("caCert") {
        easy.cainfo(ca)
            .map_err(|e| format!("Could not configure CA file: {e}"))?;
    } else if !installed_ca_bundle_path().is_empty() {
        if let Err(e) = easy.cainfo(installed_ca_bundle_path()) {
            log::warn!("Could not set bundled CA file: {}", e);
        }
    }
    if let Some(doh) = plan.config.str_("dohUrl") {
        easy.doh_url(Some(doh))
            .map_err(|e| format!("Could not configure DNS-over-HTTPS: {e}"))?;
    }
    if let Some(dns) = plan.config.str_("dnsServers") {
        easy.dns_servers(dns)
            .map_err(|e| format!("Could not configure DNS servers: {e}"))?;
    }
    if let Some(dns_iface) = plan.config.str_("dnsInterface") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_DNS_INTERFACE, dns_iface)
                .map_err(|e| format!("Could not configure DNS interface: {e}"))?;
        }
    }
    if let Some(proto) = plan.config.str_("proto") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_PROTOCOLS_STR, proto)
                .map_err(|e| format!("Could not configure allowed protocols: {e}"))?;
        }
    }
    if let Some(proto_redir) = plan.config.str_("protoRedir") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_REDIR_PROTOCOLS_STR, proto_redir)
                .map_err(|e| format!("Could not configure redirect protocols: {e}"))?;
        }
    }
    if let Some(sec) = plan.config.u64_("dnsCacheTimeoutSec") {
        easy.dns_cache_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure DNS cache timeout: {e}"))?;
    }
    if let Some(jar) = plan.config.str_("cookieJar") {
        easy.cookie_jar(jar)
            .map_err(|e| format!("Could not configure cookie jar: {e}"))?;
    }
    if let Some(pubkey) = plan.config.str_("pinnedPubKey") {
        easy.pinned_public_key(pubkey)
            .map_err(|e| format!("Could not configure certificate pinning: {e}"))?;
    }
    if let Some(size) = plan.config.u64_("maxFilesize").filter(|v| *v > 0) {
        easy.max_filesize(size)
            .map_err(|e| format!("Could not configure max file size: {e}"))?;
    }
    if let Some(size) = plan.config.u64_("bufferSize").filter(|v| *v > 0) {
        easy.buffer_size(size as usize)
            .map_err(|e| format!("Could not configure buffer size: {e}"))?;
    }
    if let Some(speed) = plan
        .config
        .u64_("speedLimitBytes")
        .or_else(|| plan.config.u64_("speedLimitKbs").map(|v| v * 1024))
        .filter(|v| *v > 0)
    {
        easy.max_recv_speed(speed)
            .map_err(|e| format!("Could not configure speed limit: {e}"))?;
    } else if let Some(rate_str) = plan.config.str_("rate") {
        if let Some(rate_bytes) = parse_rate_to_bytes(rate_str) {
            easy.max_recv_speed(rate_bytes)
                .map_err(|e| format!("Could not configure rate limit: {e}"))?;
        }
    }
    if let Some(limit) = plan.config.u64_("lowSpeedLimitBytes").filter(|v| *v > 0) {
        easy.low_speed_limit(limit.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure low-speed limit: {e}"))?;
    }
    if let Some(sec) = plan.config.u64_("speedTimeSec").filter(|v| *v > 0) {
        easy.low_speed_time(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure low-speed time: {e}"))?;
    }
    if let Some(sec) = plan.config.u64_("timeoutSec").filter(|v| *v > 0) {
        easy.timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure timeout: {e}"))?;
    }
    if let Some(sec) = plan.config.u64_("connectTimeoutSec").filter(|v| *v > 0) {
        easy.connect_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure connect timeout: {e}"))?;
    }
    if let Some(max) = plan.config.u64_("maxRedirs") {
        easy.max_redirections(max.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure redirect limit: {e}"))?;
    }
    if plan.config.u64_("connectTimeoutSec").is_none() {
        let _ = easy.connect_timeout(Duration::from_secs(30));
    }
    if plan.config.u64_("lowSpeedLimitBytes").is_none()
        && plan.config.u64_("speedTimeSec").is_none()
    {
        let _ = easy.low_speed_limit(500);
        let _ = easy.low_speed_time(Duration::from_secs(15));
    }
    if let Some(user) = plan.config.str_("username") {
        easy.username(user)
            .map_err(|e| format!("Could not configure username: {e}"))?;
    }
    if let Some(pass) = plan.config.str_("password") {
        easy.password(pass)
            .map_err(|e| format!("Could not configure password: {e}"))?;
    }
    if let Some(auth_type) = plan.config.str_("authType") {
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
    if let Some(netrc_val) = plan.config.str_("netrc") {
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
    if plan.config.bool_("netrcOptional") == Some(true) {
        easy.netrc(NetRc::Optional)
            .map_err(|e| format!("Could not configure netrc-optional: {e}"))?;
    }
    if let Some(netrc_file) = plan.config.str_("netrcFile") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_NETRC_FILE, netrc_file)
                .map_err(|e| format!("Could not configure netrc file: {e}"))?;
        }
    }
    if let Some(cert) = plan.config.str_("cert") {
        easy.ssl_cert(cert)
            .map_err(|e| format!("Could not configure SSL certificate: {e}"))?;
    }
    if let Some(cert_type) = plan.config.str_("certType") {
        easy.ssl_cert_type(cert_type)
            .map_err(|e| format!("Could not configure certificate type: {e}"))?;
    }
    if let Some(key) = plan.config.str_("key") {
        easy.ssl_key(key)
            .map_err(|e| format!("Could not configure SSL key: {e}"))?;
    }
    if let Some(key_type) = plan.config.str_("keyType") {
        easy.ssl_key_type(key_type)
            .map_err(|e| format!("Could not configure key type: {e}"))?;
    }
    if let Some(key_pass) = plan.config.str_("pass") {
        easy.key_password(key_pass)
            .map_err(|e| format!("Could not configure key password: {e}"))?;
    }
    if let Some(ciphers) = plan.config.str_("ciphers") {
        easy.ssl_cipher_list(ciphers)
            .map_err(|e| format!("Could not configure TLS cipher list: {e}"))?;
    }
    if let Some(tls13_ciphers) = plan.config.str_("tls13Ciphers") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_TLS13_CIPHERS, tls13_ciphers)
                .map_err(|e| format!("Could not configure TLS 1.3 ciphers: {e}"))?;
        }
    }
    if let Some(tls_max) = plan.config.str_("tlsMax") {
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
    if let Some(ca_path) = plan.config.str_("caPath") {
        easy.capath(ca_path)
            .map_err(|e| format!("Could not configure CA path: {e}"))?;
    }
    if plan.config.bool_("sslReqd") == Some(true) {
        easy.ssl_verify_peer(true)
            .map_err(|e| format!("Could not enable SSL peer verification: {e}"))?;
        easy.ssl_verify_host(true)
            .map_err(|e| format!("Could not enable SSL host verification: {e}"))?;
    }
    if let Some(proxy_user) = plan.config.str_("proxyUser") {
        if let Some(proxy_pass) = plan.config.str_("proxyPassword") {
            let cred = format!("{}:{}", proxy_user, proxy_pass);
            easy.proxy_username(&cred)
                .map_err(|e| format!("Could not configure proxy credentials: {e}"))?;
        } else {
            easy.proxy_username(proxy_user)
                .map_err(|e| format!("Could not configure proxy username: {e}"))?;
        }
    }
    if let Some(proxy_auth_val) = plan.config.str_("proxyAnyAuth") {
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
    if plan.config.bool_("remoteTime") == Some(true) {
        easy.fetch_filetime(true)
            .map_err(|e| format!("Could not enable remote time fetch: {e}"))?;
    }
    if let Some(method) = plan.config.str_("requestMethod") {
        easy.custom_request(method)
            .map_err(|e| format!("Could not configure custom request method: {e}"))?;
    }
    if let Some(post_data) = plan.config.str_("data") {
        easy.post_fields_copy(post_data.as_bytes())
            .map_err(|e| format!("Could not configure POST data: {e}"))?;
    }
    if let Some(time_cond) = plan.config.str_("timeCond") {
        let lower = time_cond.to_ascii_lowercase();
        let cond = match lower.as_str() {
            "if-modified-since" | "modified" => Some(TimeCondition::IfModifiedSince),
            "if-unmodified-since" | "unmodified" => Some(TimeCondition::IfUnmodifiedSince),
            _ => None,
        };
        if let Some(c) = cond {
            easy.time_condition(c)
                .map_err(|e| format!("Could not configure time condition: {e}"))?;
            if let Some(ts) = plan.config.u64_("timeValue") {
                easy.time_value(ts as i64)
                    .map_err(|e| format!("Could not configure time value: {e}"))?;
            }
        }
    }
    if plan.config.bool_("tcpNoDelay") == Some(true) {
        easy.tcp_nodelay(true)
            .map_err(|e| format!("Could not enable TCP no-delay: {e}"))?;
    }
    if plan.config.bool_("pathAsIs") == Some(true) {
        easy.path_as_is(true)
            .map_err(|e| format!("Could not enable path-as-is: {e}"))?;
    }
    if plan.config.bool_("ftpCreateDirs") == Some(true) {
        unsafe {
            raw_setopt_long(easy.raw(), CURLOPT_FTP_CREATE_MISSING_DIRS, 1)
                .map_err(|e| format!("Could not enable FTP create dirs: {e}"))?;
        }
    }
    if let Some(keepalive_sec) = plan.config.u64_("keepaliveTimeSec").filter(|v| *v > 0) {
        let dur = Duration::from_secs(keepalive_sec);
        easy.tcp_keepidle(dur)
            .map_err(|e| format!("Could not configure keepalive idle time: {e}"))?;
        easy.tcp_keepintvl(dur)
            .map_err(|e| format!("Could not configure keepalive interval: {e}"))?;
    }
    let resolve_entries = plan.config.array_("resolve");
    if !resolve_entries.is_empty() {
        let mut list = List::new();
        for entry in &resolve_entries {
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add DNS resolve entry: {e}"))?;
        }
        easy.resolve(list)
            .map_err(|e| format!("Could not configure DNS resolve overrides: {e}"))?;
    }
    let connect_to_entries = plan.config.array_("connectTo");
    if !connect_to_entries.is_empty() {
        let mut list = List::new();
        for entry in &connect_to_entries {
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add connect-to entry: {e}"))?;
        }
        easy.connect_to(list)
            .map_err(|e| format!("Could not configure connect-to overrides: {e}"))?;
    }
    if let Some(max_connects) = plan.config.u64_("maxConnects").filter(|v| *v > 0) {
        easy.max_connects(max_connects.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure max connects: {e}"))?;
    }
    match plan
        .config
        .str_("httpVersion")
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
    if let Some(ip) = plan.config.str_("ipResolve") {
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
    if let Some(tls_min) = plan.config.str_("tlsMin") {
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
    if let (Some(tls_min), Some(tls_max)) = (plan.config.str_("tlsMin"), plan.config.str_("tlsMax"))
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
    if let Some(opts_str) = plan.config.str_("sslOptions") {
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
    if let Some(crl) = plan.config.str_("crlFile") {
        easy.crlfile(crl)
            .map_err(|e| format!("Could not configure CRL file: {e}"))?;
    }
    if let Some(issuer) = plan.config.str_("issuerCert") {
        easy.issuer_cert(issuer)
            .map_err(|e| format!("Could not configure issuer certificate: {e}"))?;
    }
    if plan.config.bool_("sslSessionIdCache") == Some(false) {
        easy.ssl_sessionid_cache(false)
            .map_err(|e| format!("Could not disable SSL session ID cache: {e}"))?;
    }
    if let Some(proxy_cainfo) = plan.config.str_("proxyCaInfo") {
        easy.proxy_cainfo(proxy_cainfo)
            .map_err(|e| format!("Could not configure proxy CA info: {e}"))?;
    }
    if let Some(proxy_capath) = plan.config.str_("proxyCaPath") {
        easy.proxy_capath(proxy_capath)
            .map_err(|e| format!("Could not configure proxy CA path: {e}"))?;
    }
    if let Some(proxy_cert) = plan.config.str_("proxyCert") {
        easy.proxy_sslcert(proxy_cert)
            .map_err(|e| format!("Could not configure proxy SSL cert: {e}"))?;
    }
    if let Some(proxy_cert_type) = plan.config.str_("proxyCertType") {
        easy.proxy_sslcert_type(proxy_cert_type)
            .map_err(|e| format!("Could not configure proxy cert type: {e}"))?;
    }
    if let Some(proxy_key) = plan.config.str_("proxyKey") {
        easy.proxy_sslkey(proxy_key)
            .map_err(|e| format!("Could not configure proxy SSL key: {e}"))?;
    }
    if let Some(proxy_key_type) = plan.config.str_("proxyKeyType") {
        easy.proxy_sslkey_type(proxy_key_type)
            .map_err(|e| format!("Could not configure proxy key type: {e}"))?;
    }
    if let Some(proxy_key_pass) = plan.config.str_("proxyKeyPassword") {
        easy.proxy_key_password(proxy_key_pass)
            .map_err(|e| format!("Could not configure proxy key password: {e}"))?;
    }
    if let Some(proxy_cipher) = plan.config.str_("proxyCiphers") {
        easy.proxy_ssl_cipher_list(proxy_cipher)
            .map_err(|e| format!("Could not configure proxy cipher list: {e}"))?;
    }
    if let Some(proxy_tls_max) = plan.config.str_("proxyTlsMax") {
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
    if let Some(proxy_tls_min) = plan.config.str_("proxyTlsMin") {
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
    if plan.config.bool_("proxyVerifyPeer") == Some(false) {
        easy.proxy_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable proxy peer verification: {e}"))?;
    }
    if plan.config.bool_("proxyVerifyHost") == Some(false) {
        easy.proxy_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable proxy host verification: {e}"))?;
    }
    if let Some(proxy_type_val) = plan.config.str_("proxyType") {
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
    if plan.config.bool_("proxyTunnel") == Some(true) {
        easy.http_proxy_tunnel(true)
            .map_err(|e| format!("Could not enable proxy tunnel: {e}"))?;
    }
    if plan.config.bool_("unrestrictedAuth") == Some(true) {
        easy.unrestricted_auth(true)
            .map_err(|e| format!("Could not enable unrestricted auth: {e}"))?;
    }
    if plan.config.bool_("transferEncoding") == Some(true) {
        easy.transfer_encoding(true)
            .map_err(|e| format!("Could not enable transfer encoding: {e}"))?;
    }
    if plan.config.bool_("http09Allowed") == Some(true) {
        easy.http_09_allowed(true)
            .map_err(|e| format!("Could not enable HTTP/0.9: {e}"))?;
    }
    if let Some(timeout) = plan.config.u64_("expect100TimeoutMs") {
        easy.expect_100_timeout(Duration::from_millis(timeout))
            .map_err(|e| format!("Could not configure expect-100 timeout: {e}"))?;
    }
    if plan.config.bool_("freshConnect") == Some(true) {
        easy.fresh_connect(true)
            .map_err(|e| format!("Could not force fresh connection: {e}"))?;
    }
    if plan.config.bool_("forbidReuse") == Some(true) {
        easy.forbid_reuse(true)
            .map_err(|e| format!("Could not forbid connection reuse: {e}"))?;
    }
    if let Some(age) = plan.config.u64_("maxAgeConn") {
        easy.maxage_conn(Duration::from_secs(age))
            .map_err(|e| format!("Could not configure max connection age: {e}"))?;
    }
    if let Some(range) = plan.config.str_("localPortRange") {
        if let Some((start, _end)) = range.split_once('-') {
            if let Ok(s) = start.trim().parse::<u16>() {
                easy.local_port_range(s)
                    .map_err(|err| format!("Could not configure local port range: {err}"))?;
            }
        }
    }
    if plan.config.bool_("dohSslVerifyPeer") == Some(false) {
        easy.doh_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable DoH peer verification: {e}"))?;
    }
    if plan.config.bool_("dohSslVerifyHost") == Some(false) {
        easy.doh_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable DoH host verification: {e}"))?;
    }
    let mut header_list: List = if let Some(headers) = direct_headers(&plan.config)? {
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
        if let Some(bearer) = plan.config.str_("oauth2Bearer") {
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
    if let Some(etag_file) = plan.config.str_("etagCompare") {
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
        let current = file.metadata().map(|m| m.len()).unwrap_or(0);
        if current == 0 && size > 0 {
            file.set_len(size).map_err(|e| {
                format!("Could not preallocate segment file (disk may be full): {e}")
            })?;
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
