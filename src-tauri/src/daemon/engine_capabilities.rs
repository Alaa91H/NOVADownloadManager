use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use crate::daemon::types::MediaDownloadOptions;
use crate::daemon::utils::hide_command_window;

/// High-level direct-option keys the UI can set. Several overlap semantically
/// with the raw CLI flags in `CANDIDATE_CURL_RAW_OPTIONS` (L18) — e.g.
/// `rateLimitKbs`/`rate`/`speedLimitBytes` ↔ `--limit-rate`,
/// `lowSpeedLimitBytes`/`speedTimeSec` ↔ `--speed-limit`/`--speed-time`,
/// `maxRedirs` ↔ `--max-redirs`. The raw table is the source of truth for
/// what libcurl itself supports; this table gates the friendly keys.
const CURL_DIRECT_OPTION_KEYS: &[&str] = &[
    "proxy",
    "preProxy",
    "noproxy",
    "proxyUser",
    "proxyPassword",
    "proxyAnyAuth",
    "proxyType",
    "proxyTunnel",
    "proxyCaInfo",
    "proxyCaPath",
    "proxyCert",
    "proxyCertType",
    "proxyKey",
    "proxyKeyType",
    "proxyKeyPassword",
    "proxyCiphers",
    "proxyTlsMax",
    "proxyTlsMin",
    "proxyVerifyPeer",
    "proxyVerifyHost",
    "sourceAddress",
    "interface",
    "userAgent",
    "referer",
    "headers",
    "cookies",
    "cookieJar",
    "username",
    "password",
    "authType",
    "oauth2Bearer",
    "netrc",
    "netrcOptional",
    "netrcFile",
    "unrestrictedAuth",
    "speedLimitKbs",
    "speedLimitBytes",
    "lowSpeedLimitBytes",
    "speedTimeSec",
    "rate",
    "retryCount",
    "retryDelaySec",
    "retryMaxTimeSec",
    "retryAllErrors",
    "retryConnRefused",
    "backoffMultiplier",
    "retryMaxDelaySec",
    "retryJitter",
    "timeoutSec",
    "connectTimeoutSec",
    "maxRedirs",
    "maxFilesize",
    "range",
    "etagSave",
    "etagCompare",
    "timeCond",
    "timeValue",
    "remoteTime",
    "skipExisting",
    "removeOnError",
    "allowOverwrite",
    "location",
    "failWithBody",
    "httpVersion",
    "requestMethod",
    "data",
    "form",
    "compressed",
    "transferEncoding",
    "http09Allowed",
    "expect100TimeoutMs",
    "insecure",
    "caCert",
    "caPath",
    "cert",
    "certType",
    "key",
    "keyType",
    "pass",
    "pinnedPubKey",
    "tlsMin",
    "tlsMax",
    "ciphers",
    "tls13Ciphers",
    "sslReqd",
    "sslOptions",
    "sslSessionIdCache",
    "crlFile",
    "issuerCert",
    "ipResolve",
    "ftpCreateDirs",
    "proto",
    "protoRedir",
    "dohUrl",
    "dohSslVerifyPeer",
    "dohSslVerifyHost",
    "dnsServers",
    "dnsInterface",
    "dnsCacheTimeoutSec",
    "resolve",
    "connectTo",
    "localPortRange",
    "tcpNoDelay",
    "keepaliveTimeSec",
    "pathAsIs",
    "globoff",
    "segmented",
    "forceSingleConnection",
    "maxConnectionCache",
    "maxConnects",
    "maxHostConnections",
    "maxTotalConnections",
    "eventLoop",
    "freshConnect",
    "forbidReuse",
    "maxAgeConn",
    "bufferSize",
];

const MEDIA_BRIDGE_MEDIA_OPTION_KEYS: &[&str] = &[
    "mode",
    "quality",
    "formatSelector",
    "formatSort",
    "audioFormat",
    "bitrate",
    "outputTemplate",
    "playlist",
    "playlistItems",
    "subtitles",
    "subtitleLanguages",
    "autoSubtitles",
    "embedSubtitles",
    "writeThumbnail",
    "embedThumbnail",
    "writeInfoJson",
    "writeDescription",
    "splitChapters",
    "sponsorBlock",
    "proxy",
    "sourceAddress",
    "cookies",
    "cookiesFromBrowser",
    "userAgent",
    "referer",
    "headers",
    "rateLimitKbs",
    "retries",
    "fragmentRetries",
    "fileAccessRetries",
    "retrySleep",
    "concurrentFragments",
    "sleepIntervalSec",
    "maxSleepIntervalSec",
    "sleepRequestsSec",
    "sleepSubtitlesSec",
    "downloadSections",
    "matchFilter",
    "remuxFormat",
    "ffmpegEnabled",
    "ffmpegLocation",
    "externalDownloader",
    "externalDownloaderArgs",
    "throttledRateKbs",
    "bufferSizeKbs",
    "httpChunkSize",
    "downloadArchive",
    "breakOnExisting",
    "forceOverwrites",
    "noOverwrites",
    "restrictFilenames",
    "windowsFilenames",
    "trimFilenames",
    "writeComments",
    "embedMetadata",
    "embedChapters",
    "convertThumbnails",
    "postprocessorArgs",
    "extractorArgs",
    "compatOptions",
    "liveFromStart",
    "waitForVideo",
    "socketTimeoutSec",
    "minFilesize",
    "maxFilesize",
    "maxDownloads",
    "username",
    "password",
    "twoFactor",
    "netrc",
    "geoBypassCountry",
    "extraArgs",
];

/// Raw libcurl options that the engine can pass through. This list mirrors the
/// CLI flags surfaced by `linked_libcurl_flags` — the engine exposes them as
/// `rawOptions` only when libcurl actually supports them. `rawOptions` as a
/// top-level direct option key remains unsupported by design (no per-key
/// passthrough exists yet), so `curl_key_supported("rawOptions")` stays false;
/// this constant powers the honest `supportedRawOptions` advertisement.
const CANDIDATE_CURL_RAW_OPTIONS: &[&str] = &[
    "--proxy",
    "--noproxy",
    "--interface",
    "--proxy-user",
    "--proxy-anyauth",
    "--proxy-cacert",
    "--proxy-capath",
    "--proxy-cert",
    "--proxy-cert-type",
    "--proxy-key",
    "--proxy-key-type",
    "--proxy-pass",
    "--proxy-ciphers",
    "--proxy-tls-max",
    "--proxy-insecure",
    "--preproxy",
    "--user",
    "--user-agent",
    "--referer",
    "--basic",
    "--digest",
    "--ntlm",
    "--negotiate",
    "--cacert",
    "--capath",
    "--cert",
    "--cert-type",
    "--key",
    "--key-type",
    "--pass",
    "--ciphers",
    "--tls-max",
    "--tlsv1",
    "--tlsv1.2",
    "--tlsv1.3",
    "--insecure",
    "--resolve",
    "--connect-timeout",
    "--max-time",
    "--speed-limit",
    "--speed-time",
    "--max-filesize",
    "--http1.0",
    "--http1.1",
    "--http2",
    "--http3",
    "--compressed",
    "--etag-save",
    "--etag-compare",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--retry-connrefused",
    "--location",
    "--max-redirs",
    "--cookie",
    "--cookie-jar",
    "--header",
    "--user-agent",
    "--range",
    "--output",
    "--remote-name",
    "--ssl",
    "--ssl-reqd",
    "--ftp-pasv",
    "--crlf",
    "--ipv4",
    "--ipv6",
    "--dns-servers",
    "--dns-interface",
    "--dns-ipv4-addr",
    "--dns-ipv6-addr",
    "--no-keepalive",
    "--limit-rate",
    "--low-speed-limit",
    "--low-speed-time",
    "--keepalive-time",
    "--xattr",
    "--create-dirs",
];

fn hidden_output(command: &str, args: &[&str]) -> Option<String> {
    if command.trim().is_empty() {
        return None;
    }
    let mut cmd = Command::new(command);
    hide_command_window(&mut cmd);
    let output = cmd
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stderr).to_string();
    }
    Some(text)
}

fn hidden_output_any(command: &str, args: &[&str]) -> Option<String> {
    if command.trim().is_empty() {
        return None;
    }
    let mut cmd = Command::new(command);
    hide_command_window(&mut cmd);
    let output = cmd
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.trim().is_empty() {
        text = String::from_utf8_lossy(&output.stderr).to_string();
    }
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn executable_available(command: &str) -> bool {
    if command.trim().is_empty() {
        return false;
    }
    if Path::new(command).exists() {
        return true;
    }
    hidden_output(command, &["--version"]).is_some()
        || hidden_output(command, &["-version"]).is_some()
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("unknown").trim().to_owned()
}

fn second_token(line: &str) -> String {
    line.split_whitespace()
        .nth(1)
        .unwrap_or("unknown")
        .to_owned()
}

fn lower_set(values: &[String]) -> HashSet<String> {
    values.iter().map(|v| v.to_ascii_lowercase()).collect()
}

fn sorted_vec(set: HashSet<String>) -> Vec<String> {
    let mut values: Vec<String> = set.into_iter().collect();
    values.sort();
    values
}

fn parse_long_flags(help: &str) -> HashSet<String> {
    let mut flags = HashSet::new();
    for token in help.split_whitespace() {
        for part in token.split(',') {
            let cleaned = part.trim().trim_matches(|c: char| {
                matches!(
                    c,
                    ',' | ';' | ':' | ')' | '(' | '[' | ']' | '{' | '}' | '<' | '>' | '='
                )
            });
            if cleaned.starts_with("--") && cleaned.len() > 2 {
                let flag = cleaned
                    .split(['=', '[', '<', '|', ','])
                    .next()
                    .unwrap_or(cleaned)
                    .trim()
                    .to_owned();
                if flag.starts_with("--") {
                    flags.insert(flag);
                }
            }
        }
    }
    flags
}

fn linked_libcurl_features(version: &::curl::Version) -> Vec<String> {
    let mut features = Vec::new();
    if version.feature_ssl() {
        features.push("SSL".to_owned());
    }
    if version.feature_libz() {
        features.push("libz".to_owned());
    }
    if version.feature_brotli() {
        features.push("brotli".to_owned());
    }
    if version.feature_zstd() {
        features.push("zstd".to_owned());
    }
    if version.feature_http2() {
        features.push("HTTP2".to_owned());
    }
    if version.feature_http3() {
        features.push("HTTP3".to_owned());
    }
    if version.feature_ipv6() {
        features.push("IPv6".to_owned());
    }
    if version.feature_async_dns() {
        features.push("AsynchDNS".to_owned());
    }
    if version.feature_https_proxy() {
        features.push("HTTPS-proxy".to_owned());
    }
    if version.feature_largefile() {
        features.push("Largefile".to_owned());
    }
    if version.feature_ntlm() {
        features.push("NTLM".to_owned());
    }
    if version.feature_gss_negotiate() {
        features.push("GSS".to_owned());
    }
    if version.feature_spnego() {
        features.push("SPNEGO".to_owned());
    }
    if version.feature_sspi() {
        features.push("SSPI".to_owned());
    }
    if version.feature_unix_domain_socket() {
        features.push("UnixSockets".to_owned());
    }
    if version.feature_debug() {
        features.push("Debug".to_owned());
    }
    if version.feature_unicode() {
        features.push("Unicode".to_owned());
    }
    if version.feature_idn() {
        features.push("IDN".to_owned());
    }
    if version.feature_tlsauth_srp() {
        features.push("TLS-SRP".to_owned());
    }
    if version.feature_ntlm_wb() {
        features.push("NTLM-WB".to_owned());
    }
    if version.feature_conv() {
        features.push("Conv".to_owned());
    }
    if version.feature_hsts() {
        features.push("HSTS".to_owned());
    }
    if version.feature_altsvc() {
        features.push("Alt-Svc".to_owned());
    }
    if version.feature_gsasl() {
        features.push("GSASL".to_owned());
    }
    features
}

fn linked_libcurl_flags(version: &::curl::Version) -> HashSet<String> {
    let mut flags = HashSet::new();
    for flag in [
        // Network / proxy
        "--proxy",
        "--noproxy",
        "--interface",
        "--proxy-user",
        "--proxy-anyauth",
        "--proxy-cacert",
        "--proxy-capath",
        "--proxy-cert",
        "--proxy-cert-type",
        "--proxy-key",
        "--proxy-key-type",
        "--proxy-pass",
        "--proxy-ciphers",
        "--proxy-tls-max",
        "--proxy-insecure",
        "--preproxy",
        // Auth
        "--user",
        "--user-agent",
        "--referer",
        "--basic",
        "--digest",
        "--ntlm",
        "--anyauth",
        "--negotiate",
        "--oauth2-bearer",
        "--netrc",
        "--netrc-optional",
        "--netrc-file",
        // Headers / cookies
        "--header",
        "--cookie",
        "--cookie-jar",
        // Speed / retry
        "--limit-rate",
        "--speed-limit",
        "--speed-time",
        "--rate",
        "--retry",
        "--retry-delay",
        "--retry-max-time",
        "--retry-all-errors",
        "--retry-connrefused",
        // Timeouts / limits
        "--max-time",
        "--connect-timeout",
        "--max-redirs",
        "--max-filesize",
        // Range / conditional
        "--range",
        "--time-cond",
        "--remote-time",
        "--skip-existing",
        // File handling
        "--remove-on-error",
        "--no-clobber",
        "--location",
        "--fail-with-body",
        "--continue-at",
        // HTTP method / data
        "--request",
        "--data-raw",
        "--data",
        "--form-string",
        "--form",
        // HTTP version
        "--http1.0",
        "--http1.1",
        // Compression / encoding
        "--compressed",
        // TLS / SSL
        "--insecure",
        "--cacert",
        "--capath",
        "--cert",
        "--cert-type",
        "--key",
        "--key-type",
        "--pass",
        "--tls-max",
        "--ciphers",
        "--tls13-ciphers",
        "--ssl-reqd",
        "--pinnedpubkey",
        "--crlfile",
        "--issuercert",
        // IP / DNS
        "--ipv4",
        "--ipv6",
        "--resolve",
        "--connect-to",
        "--proto",
        "--proto-redir",
        "--dns-servers",
        "--dns-interface",
        "--doh-url",
        // TCP
        "--local-port",
        "--tcp-nodelay",
        "--keepalive-time",
        "--path-as-is",
        "--globoff",
        "--ftp-create-dirs",
        "--etag-save",
        "--etag-compare",
    ] {
        flags.insert(flag.to_owned());
    }
    if version.feature_http2() {
        flags.insert("--http2".to_owned());
        flags.insert("--http2-prior-knowledge".to_owned());
    }
    if version.feature_http3() {
        flags.insert("--http3".to_owned());
        flags.insert("--http3-only".to_owned());
    }
    flags
}

fn expected_libcurl_version() -> String {
    option_env!("NOVA_BUILD_LIBCURL_VERSION")
        .unwrap_or("unmanaged")
        .to_owned()
}

fn expected_libcurl_tag() -> String {
    option_env!("NOVA_BUILD_LIBCURL_TAG")
        .unwrap_or("unmanaged")
        .to_owned()
}

fn expected_libcurl_sha256() -> String {
    option_env!("NOVA_BUILD_LIBCURL_SHA256")
        .unwrap_or("unmanaged")
        .to_owned()
}

fn expected_csv_set(value: &str) -> HashSet<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "unmanaged")
        .map(str::to_ascii_lowercase)
        .collect()
}

fn expected_libcurl_protocols() -> HashSet<String> {
    expected_csv_set(option_env!("NOVA_BUILD_LIBCURL_PROTOCOLS").unwrap_or("unmanaged"))
}

fn expected_libcurl_features() -> HashSet<String> {
    expected_csv_set(option_env!("NOVA_BUILD_LIBCURL_FEATURES").unwrap_or("unmanaged"))
}

fn checkable_features() -> HashSet<String> {
    // Only check features that are reliably verifiable via curl-rust's Version::get()
    // and are considered mandatory for the core download engine (not optional compression).
    // brotli, zstd, http3 are intentionally excluded as they are optional build-time
    // compression/protocol features that may not be present in all environments.
    [
        "ssl",
        "libz",
        "http2",
        "ipv6",
        "asynchdns",
        "https-proxy",
        "largefile",
        "ntlm",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect()
}

fn expected_libcurl_feature_profile() -> String {
    option_env!("NOVA_BUILD_LIBCURL_FEATURE_PROFILE")
        .unwrap_or("unmanaged")
        .to_owned()
}

fn expected_libcurl_prefix() -> String {
    option_env!("NOVA_BUILD_LIBCURL_PREFIX")
        .unwrap_or("unmanaged")
        .to_owned()
}

fn libcurl_link_mode() -> String {
    option_env!("NOVA_BUILD_LIBCURL_LINK_MODE")
        .unwrap_or("system-or-vendored-fallback")
        .to_owned()
}

fn normalize_libcurl_version(value: &str) -> String {
    value
        .trim()
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .to_owned()
}

fn linked_libcurl_version() -> String {
    ::curl::Version::get().version().to_owned()
}

fn libcurl_version_matches_expected() -> bool {
    let expected = expected_libcurl_version();
    expected == "unmanaged"
        || normalize_libcurl_version(&expected)
            == normalize_libcurl_version(&linked_libcurl_version())
}

fn linked_libcurl_tls_backend() -> String {
    let linked = ::curl::Version::get();
    linked.ssl_version().unwrap_or("none").to_owned()
}

fn linked_libcurl_model() -> (
    bool,
    String,
    String,
    Vec<String>,
    Vec<String>,
    HashSet<String>,
) {
    let linked = ::curl::Version::get();
    let protocols: Vec<String> = linked
        .protocols()
        .map(std::borrow::ToOwned::to_owned)
        .collect();
    let features = linked_libcurl_features(&linked);
    let version_line = format!("libcurl {}", linked.version());
    let tls = linked_libcurl_tls_backend();
    let text = format!(
        "{}\nProtocols: {}\nFeatures: {}\nTLS: {}",
        version_line,
        protocols.join(" "),
        features.join(" "),
        tls
    );
    (
        true,
        text,
        version_line,
        protocols,
        features,
        linked_libcurl_flags(&linked),
    )
}

fn has_protocol(protocols: &HashSet<String>, protocol: &str) -> bool {
    protocols.contains(&protocol.to_ascii_lowercase())
}

fn has_feature(features: &HashSet<String>, feature: &str) -> bool {
    features.contains(&feature.to_ascii_lowercase())
}

fn has_flag(flags: &HashSet<String>, flag: &str) -> bool {
    flags.contains(flag)
}

fn curl_key_supported(
    key: &str,
    available: bool,
    _protocols: &HashSet<String>,
    features: &HashSet<String>,
    flags: &HashSet<String>,
) -> bool {
    if !available {
        return false;
    }
    let implemented_by_libcurl_multi = matches!(
        key,
        // Network / proxy
        "proxy" | "preProxy" | "noproxy" | "sourceAddress" | "interface"
        | "proxyUser" | "proxyAnyAuth" | "proxyType" | "proxyTunnel"
        | "proxyCaInfo" | "proxyCaPath" | "proxyCert" | "proxyCertType"
        | "proxyKey" | "proxyKeyType" | "proxyKeyPassword"
        | "proxyCiphers" | "proxyTlsMax" | "proxyTlsMin"
        | "proxyVerifyPeer" | "proxyVerifyHost"
        | "proxyPassword"
        // Auth
        | "userAgent" | "referer" | "headers" | "cookies" | "cookieJar"
        | "username" | "password" | "authType" | "oauth2Bearer"
        | "netrc" | "netrcOptional" | "netrcFile" | "unrestrictedAuth"
        // Speed / retry (consumed by Rust RetryPolicy)
        | "speedLimitKbs" | "speedLimitBytes" | "rate" | "lowSpeedLimitBytes" | "speedTimeSec"
        | "retryCount" | "retryDelaySec" | "retryMaxTimeSec"
        | "retryAllErrors" | "retryConnRefused" | "backoffMultiplier"
        | "retryMaxDelaySec" | "retryJitter"
        // Timeouts / limits
        | "timeoutSec" | "connectTimeoutSec" | "maxRedirs" | "maxFilesize"
        // Range / conditional
        | "range" | "timeCond" | "timeValue" | "remoteTime" | "skipExisting" | "etagSave" | "etagCompare"
        // File handling
        | "removeOnError" | "allowOverwrite" | "location" | "failWithBody"
        // HTTP method / body
        | "httpVersion" | "requestMethod" | "data" | "form"
        | "transferEncoding" | "http09Allowed" | "expect100TimeoutMs"
        // Compression
        | "compressed"
        // TLS / SSL
        | "insecure" | "caCert" | "caPath"
        | "cert" | "certType" | "key" | "keyType" | "pass"
        | "tlsMin" | "tlsMax" | "ciphers" | "tls13Ciphers"
        | "sslReqd" | "sslOptions" | "sslSessionIdCache" | "crlFile" | "issuerCert"
        | "pinnedPubKey"
        // IP / DNS
        | "ipResolve"
        | "dohUrl" | "dohSslVerifyPeer" | "dohSslVerifyHost"
        | "dnsServers" | "dnsInterface" | "dnsCacheTimeoutSec"
        | "proto" | "protoRedir"
        | "resolve" | "connectTo"
        // FTP
        | "ftpCreateDirs"
        // TCP / connection
        | "localPortRange" | "tcpNoDelay" | "keepaliveTimeSec"
        | "pathAsIs" | "globoff"
        | "freshConnect" | "forbidReuse" | "maxAgeConn" | "bufferSize"
        // Connection limits / download control
        | "segmented" | "forceSingleConnection"
        | "maxConnectionCache" | "maxConnects" | "maxHostConnections" | "maxTotalConnections"
        | "eventLoop"
    );
    if !implemented_by_libcurl_multi {
        return false;
    }
    match key {
        "segmented"
        | "forceSingleConnection"
        | "maxConnectionCache"
        | "maxConnects"
        | "maxHostConnections"
        | "maxTotalConnections"
        | "eventLoop" => true,
        "proxy" => has_flag(flags, "--proxy"),
        "preProxy" => has_flag(flags, "--preproxy"),
        "noproxy" => has_flag(flags, "--noproxy"),
        "proxyUser" => has_flag(flags, "--proxy-user"),
        "proxyAnyAuth" => has_flag(flags, "--proxy-anyauth"),
        "sourceAddress" | "interface" => has_flag(flags, "--interface"),
        "userAgent" => has_flag(flags, "--user-agent"),
        "referer" => has_flag(flags, "--referer"),
        "headers" => has_flag(flags, "--header"),
        "cookies" => has_flag(flags, "--cookie"),
        "cookieJar" => has_flag(flags, "--cookie-jar"),
        "username" | "password" => has_flag(flags, "--user"),
        "authType" => {
            has_flag(flags, "--basic")
                || has_flag(flags, "--digest")
                || has_flag(flags, "--ntlm")
                || has_flag(flags, "--anyauth")
        }
        "oauth2Bearer" => has_flag(flags, "--oauth2-bearer"),
        "netrc" => has_flag(flags, "--netrc"),
        "netrcOptional" => has_flag(flags, "--netrc-optional"),
        "netrcFile" => has_flag(flags, "--netrc-file"),
        "speedLimitKbs" | "speedLimitBytes" => has_flag(flags, "--limit-rate"),
        "rate" => has_flag(flags, "--rate") || has_flag(flags, "--limit-rate"),
        "lowSpeedLimitBytes" => has_flag(flags, "--speed-limit"),
        "speedTimeSec" => has_flag(flags, "--speed-time"),
        "timeoutSec" => has_flag(flags, "--max-time"),
        "connectTimeoutSec" => has_flag(flags, "--connect-timeout"),
        "maxRedirs" => has_flag(flags, "--max-redirs"),
        "maxFilesize" => has_flag(flags, "--max-filesize"),
        "range" => has_flag(flags, "--range"),
        "timeCond" => has_flag(flags, "--time-cond"),
        "timeValue" => true,
        "remoteTime" => has_flag(flags, "--remote-time"),
        "skipExisting" => true,
        "removeOnError" => has_flag(flags, "--remove-on-error"),
        "allowOverwrite" => has_flag(flags, "--no-clobber"),
        "location" => has_flag(flags, "--location"),
        "failWithBody" => has_flag(flags, "--fail-with-body"),
        "httpVersion" => {
            has_flag(flags, "--http1.0")
                || has_flag(flags, "--http1.1")
                || has_flag(flags, "--http2")
                || has_flag(flags, "--http3")
        }
        "requestMethod" => has_flag(flags, "--request"),
        "data" => has_flag(flags, "--data-raw") || has_flag(flags, "--data"),
        "compressed" => {
            has_flag(flags, "--compressed")
                && (has_feature(features, "libz")
                    || has_feature(features, "brotli")
                    || has_feature(features, "zstd"))
        }
        "insecure" => has_flag(flags, "--insecure") && has_feature(features, "ssl"),
        "caCert" => has_flag(flags, "--cacert") && has_feature(features, "ssl"),
        "caPath" => has_flag(flags, "--capath") && has_feature(features, "ssl"),
        "cert" => has_flag(flags, "--cert") && has_feature(features, "ssl"),
        "certType" => has_flag(flags, "--cert-type") && has_feature(features, "ssl"),
        "key" => has_flag(flags, "--key") && has_feature(features, "ssl"),
        "keyType" => has_flag(flags, "--key-type") && has_feature(features, "ssl"),
        "pass" => has_flag(flags, "--pass") && has_feature(features, "ssl"),
        "pinnedPubKey" => has_flag(flags, "--pinnedpubkey") && has_feature(features, "ssl"),
        "tls13Ciphers" => has_flag(flags, "--tls13-ciphers") && has_feature(features, "ssl"),
        "tlsMax" => has_flag(flags, "--tls-max") && has_feature(features, "ssl"),
        "ciphers" => has_flag(flags, "--ciphers") && has_feature(features, "ssl"),
        "sslReqd" => has_feature(features, "ssl"),
        "dohUrl" => has_flag(flags, "--doh-url") && has_feature(features, "https-proxy"),
        "dnsServers" => has_flag(flags, "--dns-servers"),
        "dnsInterface" => has_flag(flags, "--dns-interface"),
        "resolve" => has_flag(flags, "--resolve"),
        "connectTo" => has_flag(flags, "--connect-to"),
        "proto" => has_flag(flags, "--proto"),
        "protoRedir" => has_flag(flags, "--proto-redir"),
        "localPortRange" => has_flag(flags, "--local-port"),
        "tcpNoDelay" => has_flag(flags, "--tcp-nodelay"),
        "tcpFastOpen" => has_flag(flags, "--tcp-fastopen") && has_feature(features, "tcp-fastopen"),
        "keepaliveTimeSec" => has_flag(flags, "--keepalive-time"),
        "happyEyeballsTimeoutMs" => {
            has_flag(flags, "--happy-eyeballs-timeout-ms") && has_feature(features, "asynchdns")
        }
        "pathAsIs" => has_flag(flags, "--path-as-is"),
        "globoff" => has_flag(flags, "--globoff"),
        "ftpCreateDirs" => has_flag(flags, "--ftp-create-dirs"),
        // Proxy TLS / auth (always available when SSL is built in)
        "proxyType" | "proxyTunnel" => true,
        "proxyCaInfo" | "proxyCaPath" => has_feature(features, "ssl"),
        "proxyCert" | "proxyCertType" | "proxyKey" | "proxyKeyType" | "proxyKeyPassword" => {
            has_feature(features, "ssl")
        }
        "proxyCiphers" | "proxyTlsMax" | "proxyTlsMin" => has_feature(features, "ssl"),
        "proxyVerifyPeer" | "proxyVerifyHost" => has_feature(features, "ssl"),
        // Proxy password (sent with --proxy-user user:pass)
        "proxyPassword" => has_flag(flags, "--proxy-user"),
        // Unrestricted auth
        "unrestrictedAuth" => true,
        // HTTP transfer / encoding (always available)
        "transferEncoding" | "http09Allowed" | "expect100TimeoutMs" => true,
        // TLS min version (same gate as tlsMax)
        "tlsMin" => has_flag(flags, "--tls-max") && has_feature(features, "ssl"),
        // ETag conditional download support
        "etagSave" => has_flag(flags, "--etag-save"),
        "etagCompare" => has_flag(flags, "--etag-compare"),
        // SSL behavior flags
        "sslOptions" | "sslSessionIdCache" => has_feature(features, "ssl"),
        "crlFile" => has_flag(flags, "--crlfile") && has_feature(features, "ssl"),
        "issuerCert" => has_flag(flags, "--issuercert") && has_feature(features, "ssl"),
        // IP resolve
        "ipResolve" => has_flag(flags, "--ipv4") || has_flag(flags, "--ipv6"),
        // DoH TLS
        "dohSslVerifyPeer" | "dohSslVerifyHost" => has_feature(features, "ssl"),
        // TCP / connection pool
        "freshConnect" | "forbidReuse" | "maxAgeConn" => true,
        "retryConnRefused" => true,
        // Retry options consumed by Rust RetryPolicy (no curl CLI flag needed)
        "retryCount" | "retryDelaySec" | "retryMaxTimeSec" | "retryAllErrors"
        | "backoffMultiplier" | "retryMaxDelaySec" | "retryJitter" => true,
        // Multipart form data (core libcurl feature)
        "form" => true,
        "dnsCacheTimeoutSec" => true,
        "bufferSize" => true,
        "rawOptions" => false,
        _ => false,
    }
}

fn curl_supported_http_versions(
    features: &HashSet<String>,
    flags: &HashSet<String>,
) -> Vec<String> {
    let mut versions = Vec::new();
    if has_flag(flags, "--http1.0") {
        versions.push("1.0".to_owned());
    }
    if has_flag(flags, "--http1.1") {
        versions.push("1.1".to_owned());
    }
    if has_flag(flags, "--http2") && has_feature(features, "http2") {
        versions.push("2".to_owned());
    }
    if has_flag(flags, "--http2-prior-knowledge") && has_feature(features, "http2") {
        versions.push("2-prior-knowledge".to_owned());
    }
    if has_flag(flags, "--http3") && has_feature(features, "http3") {
        versions.push("3".to_owned());
    }
    if has_flag(flags, "--http3-only") && has_feature(features, "http3") {
        versions.push("3-only".to_owned());
    }
    versions
}

pub fn curl_status() -> Value {
    let (available, text, version_line, protocols, features, flags) = linked_libcurl_model();
    let protocol_set = lower_set(&protocols);
    let feature_set = lower_set(&features);
    let supported_keys: HashSet<String> = CURL_DIRECT_OPTION_KEYS
        .iter()
        .filter(|key| curl_key_supported(key, available, &protocol_set, &feature_set, &flags))
        .map(|key| (*key).to_owned())
        .collect();
    let all_keys: HashSet<String> = CURL_DIRECT_OPTION_KEYS
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    let unsupported_keys: HashSet<String> = all_keys.difference(&supported_keys).cloned().collect();
    let supported_raw: HashSet<String> = CANDIDATE_CURL_RAW_OPTIONS
        .iter()
        .filter(|flag| flags.contains(**flag))
        .map(|flag| (*flag).to_owned())
        .collect();
    let http_versions = curl_supported_http_versions(&feature_set, &flags);
    let tls_backend = linked_libcurl_tls_backend();

    json!({
        "id": "libcurl-multi",
        "name": "libcurl multi",
        "role": "direct-download-engine",
        "runtimeCore": "in-process-libcurl-multi",
        "available": available,
        "binary": "linked-libcurl",
        "version": if available { second_token(&version_line) } else { "unknown".to_owned() },
        "versionText": if available { version_line } else { "unknown".to_owned() },
        "source": "https://github.com/curl/curl",
        "verifiedBy": ["linked libcurl Version::get() only; curl CLI is diagnostic-only"],
        "tls": {
            "backend": tls_backend,
            "available": has_feature(&feature_set, "ssl"),
            "detection": "runtime ssl_version() string"
        },
        "buildIntegrity": {
            "expectedVersion": expected_libcurl_version(),
            "normalizedExpectedVersion": normalize_libcurl_version(&expected_libcurl_version()),
            "expectedTag": expected_libcurl_tag(),
            "expectedSourceSha256": expected_libcurl_sha256(),
            "expectedPrefix": expected_libcurl_prefix(),
            "expectedFeatureProfile": expected_libcurl_feature_profile(),
            "expectedProtocols": sorted_vec(expected_libcurl_protocols()),
            "expectedFeatures": sorted_vec(expected_libcurl_features()),
            "linkMode": libcurl_link_mode(),
            "runtimeVersion": linked_libcurl_version(),
            "normalizedRuntimeVersion": normalize_libcurl_version(&linked_libcurl_version()),
            "runtimeProtocols": protocols,
            "runtimeFeatures": features,
            "runtimeTlsBackend": tls_backend,
            "versionMatchesExpected": libcurl_version_matches_expected(),
            "protocolsMatchExpected": expected_libcurl_protocols().is_empty() || ["http", "https"].iter().all(|p| protocol_set.contains(*p)),
            "featuresMatchExpected": expected_libcurl_features().is_empty() || expected_libcurl_features().intersection(&checkable_features()).all(|f| feature_set.contains(f)),
            "productionPinned": expected_libcurl_version() != "unmanaged"
        },
        "libcurlMulti": {
            "available": true,
            "binding": "curl-rust",
            "urlParser": "libcurl URL API",
            "multiInterface": true,
            "eventLoop": "multi_socket",
            "fallbackEventLoop": "wait_perform",
            "segmentedDownloads": true,
            "maxConnectionsPerTask": 32,
            "connectionLimitSemantics": {
                "activeTotalConnections": "CURLMOPT_MAX_TOTAL_CONNECTIONS",
                "activeConnectionsPerHost": "CURLMOPT_MAX_HOST_CONNECTIONS",
                "connectionCacheSize": "CURLMOPT_MAXCONNECTS"
            },
            "httpMultiplexing": "CURLMOPT_PIPELINING with CURLPIPE_MULTIPLEX",
            "pauseResumeByCancellationAndRangeResume": true
        },
        "protocols": protocols,
        "compiledFeatures": features,
        "availableFlags": sorted_vec(flags.clone()),
        "capabilities": {
            "directDownloads": available && (has_protocol(&protocol_set, "http") || has_protocol(&protocol_set, "https") || has_protocol(&protocol_set, "ftp") || has_protocol(&protocol_set, "ftps")),
            "http": available && has_protocol(&protocol_set, "http"),
            "https": available && has_protocol(&protocol_set, "https"),
            "ftp": available && has_protocol(&protocol_set, "ftp"),
            "ftps": available && has_protocol(&protocol_set, "ftps"),
            "sftp": available && has_protocol(&protocol_set, "sftp"),
            "scp": available && has_protocol(&protocol_set, "scp"),
            "resume": available && has_flag(&flags, "--continue-at"),
            "rangeRequests": available && curl_key_supported("range", available, &protocol_set, &feature_set, &flags),
            "headers": supported_keys.contains("headers"),
            "cookies": supported_keys.contains("cookies"),
            "cookieJar": supported_keys.contains("cookieJar"),
            "proxy": supported_keys.contains("proxy"),
            "socksProxy": available && (has_protocol(&protocol_set, "socks") || has_protocol(&protocol_set, "socks4") || has_protocol(&protocol_set, "socks5") || supported_keys.contains("preProxy")),
            "sourceInterface": supported_keys.contains("interface"),
            "rateLimit": supported_keys.contains("speedLimitKbs") || supported_keys.contains("rate"),
            "lowSpeedAbort": supported_keys.contains("lowSpeedLimitBytes") && supported_keys.contains("speedTimeSec"),
            "retry": supported_keys.contains("retryCount"),
            "retryAllErrors": supported_keys.contains("retryAllErrors"),
            "retryConnRefused": supported_keys.contains("retryConnRefused"),
            "etag": supported_keys.contains("etagSave") && supported_keys.contains("etagCompare"),
            "remoteTime": supported_keys.contains("remoteTime"),
            "tlsOptions": has_feature(&feature_set, "ssl"),
            "tlsBackend": tls_backend,
            "clientCertificates": supported_keys.contains("cert") && supported_keys.contains("key"),
            "http2": http_versions.iter().any(|v| v == "2"),
            "http3": http_versions.iter().any(|v| v == "3"),
            "httpVersions": http_versions,
            "parallelTransfers": supported_raw.contains("--parallel"),
            "singleFileMultiConnection": true,
            "torrent": false,
            "magnet": false,
            "compression": {
                "gzipDeflate": has_feature(&feature_set, "libz"),
                "brotli": has_feature(&feature_set, "brotli"),
                "zstd": has_feature(&feature_set, "zstd")
            }
        },
        "supportedDirectOptionKeys": sorted_vec(supported_keys),
        "unsupportedDirectOptionKeys": sorted_vec(unsupported_keys),
        "supportedRawOptions": sorted_vec(supported_raw),
        "rawVersionOutput": text
    })
}

fn non_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(v) => !v.trim().is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|value| value > 0.0),
    }
}

fn curl_direct_supported_set() -> (
    bool,
    HashSet<String>,
    HashSet<String>,
    HashSet<String>,
    Vec<String>,
) {
    let (available, _, _, protocols, features, flags) = linked_libcurl_model();
    let protocol_set = lower_set(&protocols);
    let feature_set = lower_set(&features);
    let keys = CURL_DIRECT_OPTION_KEYS
        .iter()
        .filter(|key| curl_key_supported(key, available, &protocol_set, &feature_set, &flags))
        .map(|key| (*key).to_owned())
        .collect();
    let raw = CANDIDATE_CURL_RAW_OPTIONS
        .iter()
        .filter(|flag| flags.contains(**flag))
        .map(|flag| (*flag).to_owned())
        .collect();
    let http_versions = curl_supported_http_versions(&feature_set, &flags);
    (available, keys, raw, flags, http_versions)
}

pub fn curl_supports_flag(flag: &str) -> bool {
    let (_, _, _, _, _, flags) = linked_libcurl_model();
    flags.contains(flag)
}

pub fn validate_linked_libcurl_integrity() -> Result<(), String> {
    let expected = expected_libcurl_version();
    let linked_version = linked_libcurl_version();
    let (_, _, _, protocols, features, _) = linked_libcurl_model();
    let protocol_set = lower_set(&protocols);
    let feature_set = lower_set(&features);
    let tls_backend = linked_libcurl_tls_backend();
    if expected != "unmanaged"
        && normalize_libcurl_version(&expected) != normalize_libcurl_version(&linked_version)
    {
        return Err(format!(
            "Linked libcurl mismatch: build expected {expected}, but runtime reports {linked_version}. Rebuild with pnpm run native-curl:build and ensure PKG_CONFIG_PATH points to bin/native-curl-manifest.json pkgConfigPath before Cargo/Tauri build."
        ));
    }
    let expected_protocols = expected_libcurl_protocols();
    if !expected_protocols.is_empty() {
        let missing: Vec<String> = ["http", "https"]
            .iter()
            .filter(|p| !protocol_set.contains(**p))
            .map(|s| (*s).to_owned())
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "Linked libcurl protocol mismatch. Missing runtime protocol(s): {}",
                missing.join(", ")
            ));
        }
    }
    let expected_features = expected_libcurl_features();
    if !expected_features.is_empty() {
        let checkable = checkable_features();
        let mut missing: Vec<String> = expected_features
            .intersection(&checkable)
            .filter(|f| !feature_set.contains(*f))
            .cloned()
            .collect();
        missing.sort();
        if !missing.is_empty() {
            return Err(format!(
                "Linked libcurl feature mismatch. Missing runtime feature(s): {}",
                missing.join(", ")
            ));
        }
    }
    if tls_backend == "none" && feature_set.contains("ssl") {
        log::warn!(
            "libcurl reports SSL feature but no TLS backend string detected. TLS may not be operational."
        );
    }
    Ok(())
}

pub fn validate_curl_direct_options(
    direct_options: &HashMap<String, Value>,
    resumable: bool,
) -> Result<(), String> {
    let (available, supported_keys, supported_raw, flags, http_versions) =
        curl_direct_supported_set();
    if !available {
        return Err("curl is not available. The direct-download engine cannot start.".to_owned());
    }
    if resumable && !flags.contains("--continue-at") {
        return Err("This curl build does not expose --continue-at, so resumable direct downloads are not supported.".to_owned());
    }
    let mut unsupported = Vec::new();
    for (key, value) in direct_options {
        if !non_empty_value(value) {
            continue;
        }
        if key == "allowOverwrite" && value.as_bool() == Some(true) {
            continue;
        }
        if !supported_keys.contains(key) {
            unsupported.push(key.clone());
        }
    }
    if !unsupported.is_empty() {
        unsupported.sort();
        return Err(format!(
            "Unsupported curl direct option(s) for this installed curl build: {}",
            unsupported.join(", ")
        ));
    }
    if resumable && direct_options.get("removeOnError").and_then(Value::as_bool) == Some(true) {
        return Err("curl option removeOnError is incompatible with resumable downloads because curl cannot combine --remove-on-error with --continue-at -. Disable resumable or remove removeOnError.".to_owned());
    }
    if let Some(version) = direct_options
        .get("httpVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let lowered = version.to_ascii_lowercase();
        let normalized = match lowered.as_str() {
            "1.0" | "http1.0" => "1.0",
            "1.1" | "http1.1" => "1.1",
            "2" | "http2" => "2",
            "2-prior-knowledge" | "http2-prior-knowledge" => "2-prior-knowledge",
            "3" | "http3" => "3",
            "3-only" | "http3-only" => "3-only",
            other => other,
        }
        .to_owned();
        if !http_versions.iter().any(|item| item == &normalized) {
            return Err(format!(
                "Requested HTTP version '{}' is not supported by this curl build. Supported versions: {}",
                version,
                if http_versions.is_empty() { "none".to_owned() } else { http_versions.join(", ") }
            ));
        }
    }
    if let Some(raw) = direct_options
        .get("rawOptions")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let mut rejected = Vec::new();
        for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let flag = line.split_whitespace().next().unwrap_or("");
            if !supported_raw.contains(flag) {
                rejected.push(flag.to_owned());
            }
        }
        if !rejected.is_empty() {
            rejected.sort();
            rejected.dedup();
            return Err(format!(
                "Unsupported curl raw option(s) for this installed curl build: {}",
                rejected.join(", ")
            ));
        }
    }
    Ok(())
}

fn collect_media_bridge_help(command: &str) -> String {
    hidden_output_any(command, &["--help"]).unwrap_or_default()
}

fn media_bridge_model(media_bridge_bin: &str) -> (bool, String, HashSet<String>) {
    let version = hidden_output(media_bridge_bin, &["--version"])
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_owned());
    let available = version != "unknown" || executable_available(media_bridge_bin);
    let flags = if available {
        parse_long_flags(&collect_media_bridge_help(media_bridge_bin))
    } else {
        HashSet::new()
    };
    (available, version, flags)
}

fn media_bridge_key_supported(
    key: &str,
    available: bool,
    flags: &HashSet<String>,
    ffmpeg_available: bool,
) -> bool {
    if !available {
        return false;
    }
    match key {
        "mode" => true,
        "quality" | "formatSelector" => flags.contains("--format") || flags.contains("-f"),
        "formatSort" => flags.contains("--format-sort"),
        "audioFormat" | "bitrate" => {
            ffmpeg_available
                && (flags.contains("--audio-format") || flags.contains("--audio-quality"))
        }
        "outputTemplate" => flags.contains("--output") || flags.contains("-o"),
        "playlist" => flags.contains("--no-playlist") || flags.contains("--yes-playlist"),
        "playlistItems" => flags.contains("--playlist-items"),
        "subtitles" => flags.contains("--write-subs"),
        "subtitleLanguages" => flags.contains("--sub-langs"),
        "autoSubtitles" => flags.contains("--write-auto-subs"),
        "embedSubtitles" => ffmpeg_available && flags.contains("--embed-subs"),
        "writeThumbnail" => flags.contains("--write-thumbnail"),
        "embedThumbnail" => ffmpeg_available && flags.contains("--embed-thumbnail"),
        "writeInfoJson" => flags.contains("--write-info-json"),
        "writeDescription" => flags.contains("--write-description"),
        "splitChapters" => ffmpeg_available && flags.contains("--split-chapters"),
        "sponsorBlock" => flags.contains("--sponsorblock-remove"),
        "proxy" => flags.contains("--proxy"),
        "sourceAddress" => flags.contains("--source-address"),
        "cookies" => flags.contains("--cookies") || flags.contains("--add-header"),
        "cookiesFromBrowser" => flags.contains("--cookies-from-browser"),
        "userAgent" => flags.contains("--user-agent"),
        "referer" => flags.contains("--referer"),
        "headers" => flags.contains("--add-header"),
        "rateLimitKbs" => flags.contains("--limit-rate"),
        "retries" => flags.contains("--retries"),
        "fragmentRetries" => flags.contains("--fragment-retries"),
        "fileAccessRetries" => flags.contains("--file-access-retries"),
        "retrySleep" => flags.contains("--retry-sleep"),
        "concurrentFragments" => flags.contains("--concurrent-fragments"),
        "sleepIntervalSec" => flags.contains("--sleep-interval"),
        "maxSleepIntervalSec" => flags.contains("--max-sleep-interval"),
        "sleepRequestsSec" => flags.contains("--sleep-requests"),
        "sleepSubtitlesSec" => flags.contains("--sleep-subtitles"),
        "downloadSections" => flags.contains("--download-sections"),
        "matchFilter" => flags.contains("--match-filter"),
        "remuxFormat" => ffmpeg_available && flags.contains("--remux-video"),
        "ffmpegEnabled" => true,
        "ffmpegLocation" => flags.contains("--ffmpeg-location"),
        "externalDownloader" => {
            flags.contains("--downloader") || flags.contains("--external-downloader")
        }
        "externalDownloaderArgs" => {
            flags.contains("--downloader-args") || flags.contains("--external-downloader-args")
        }
        "throttledRateKbs" => flags.contains("--throttled-rate"),
        "bufferSizeKbs" => flags.contains("--buffer-size"),
        "httpChunkSize" => flags.contains("--http-chunk-size"),
        "downloadArchive" => flags.contains("--download-archive"),
        "breakOnExisting" => flags.contains("--break-on-existing"),
        "forceOverwrites" => {
            flags.contains("--force-overwrites") || flags.contains("--no-force-overwrites")
        }
        "noOverwrites" => flags.contains("--no-overwrites"),
        "restrictFilenames" => {
            flags.contains("--restrict-filenames") || flags.contains("--no-restrict-filenames")
        }
        "windowsFilenames" => {
            flags.contains("--windows-filenames") || flags.contains("--no-windows-filenames")
        }
        "trimFilenames" => flags.contains("--trim-filenames"),
        "writeComments" => flags.contains("--write-comments"),
        "embedMetadata" => ffmpeg_available && flags.contains("--embed-metadata"),
        "embedChapters" => ffmpeg_available && flags.contains("--embed-chapters"),
        "convertThumbnails" => ffmpeg_available && flags.contains("--convert-thumbnails"),
        "postprocessorArgs" => ffmpeg_available && flags.contains("--postprocessor-args"),
        "extractorArgs" => flags.contains("--extractor-args"),
        "compatOptions" => flags.contains("--compat-options"),
        "liveFromStart" => flags.contains("--live-from-start"),
        "waitForVideo" => flags.contains("--wait-for-video"),
        "socketTimeoutSec" => flags.contains("--socket-timeout"),
        "minFilesize" => flags.contains("--min-filesize"),
        "maxFilesize" => flags.contains("--max-filesize"),
        "maxDownloads" => flags.contains("--max-downloads"),
        "username" => flags.contains("--username"),
        "password" => flags.contains("--password"),
        "twoFactor" => flags.contains("--twofactor"),
        "netrc" => flags.contains("--netrc"),
        "geoBypassCountry" => flags.contains("--geo-bypass-country"),
        "extraArgs" => true,
        _ => false,
    }
}

pub fn native_media_status() -> Value {
    let core = nova_media_core::native_media_core_capabilities();
    let supported_keys: HashSet<String> = crate::daemon::native_media::NATIVE_MEDIA_OPTION_KEYS
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    let all_keys: HashSet<String> = MEDIA_BRIDGE_MEDIA_OPTION_KEYS
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    let unsupported_keys: HashSet<String> = all_keys.difference(&supported_keys).cloned().collect();

    json!({
        "id": "nova-media-engine",
        "name": "NOVA Media Engine",
        "role": "media-extraction-engine",
        "available": true,
        "version": env!("CARGO_PKG_VERSION"),
        "source": "in-process Rust media core",
        "runtimeCore": "nova-media-core",
        "verifiedBy": ["compiled native core", "native media unit tests"],
        "capabilities": {
            "siteExtraction": core.youtube_extraction,
            "nativeResolution": true,
            "directMediaExecution": core.generic_direct_extraction,
            "formatSelection": true,
            "requestContext": true,
            "explicitCookies": true,
            "hlsParsing": core.hls_parsing,
            "hlsStaging": core.hls_staging,
            "hlsLiveRefresh": core.hls_live_refresh,
            "hlsAes128Cbc": core.hls_aes128_cbc,
            "dashParsing": core.dash_parsing,
            "dashStaging": core.dash_staging,
            "dashLiveRefresh": core.dash_live_refresh,
            "orderedAssembly": core.ordered_assembly,
            "youtubeSignatureTransform": core.youtube_signature_transform,
            "youtubeThrottlingTransform": core.youtube_throttling_transform,
            "separateTrackStaging": core.separate_track_staging,
            "hlsTaskExecution": false,
            "dashTaskExecution": false,
            "separateTrackTaskExecution": false,
            "playlists": false,
            "formatSorting": false,
            "audioExtraction": false,
            "subtitles": false,
            "autoSubtitles": false,
            "thumbnailWriteEmbed": false,
            "metadataWriteEmbed": false,
            "chapterSplit": false,
            "sponsorBlock": false,
            "partialSections": false,
            "concurrentFragments": false,
            "externalDownloader": false,
            "cookies": true,
            "cookiesFromBrowser": false,
            "proxy": false,
            "sourceAddress": false,
            "retry": false,
            "retrySleep": false,
            "downloadArchive": false,
            "liveFromStart": false,
            "postProcessing": false,
            "plugins": false
        },
        "supportedExternalDownloaders": ["native"],
        "supportedMediaOptionKeys": sorted_vec(supported_keys),
        "unsupportedMediaOptionKeys": sorted_vec(unsupported_keys)
    })
}

pub fn media_bridge_status_with_context(media_bridge_bin: &str, ffmpeg_available: bool) -> Value {
    let (available, version, flags) = media_bridge_model(media_bridge_bin);
    let supported_keys: HashSet<String> = MEDIA_BRIDGE_MEDIA_OPTION_KEYS
        .iter()
        .filter(|key| media_bridge_key_supported(key, available, &flags, ffmpeg_available))
        .map(|key| (*key).to_owned())
        .collect();
    let all_keys: HashSet<String> = MEDIA_BRIDGE_MEDIA_OPTION_KEYS
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    let unsupported_keys: HashSet<String> = all_keys.difference(&supported_keys).cloned().collect();
    let mut external_downloaders = vec!["native".to_owned()];
    if ffmpeg_available {
        external_downloaders.push("ffmpeg".to_owned());
    }
    if available && flags.contains("--downloader") {
        if executable_available("http") || executable_available("httpie") {
            external_downloaders.push("httpie".to_owned());
        }
        if executable_available("wget") {
            external_downloaders.push("wget".to_owned());
        }
        if executable_available("axel") {
            external_downloaders.push("axel".to_owned());
        }
    }
    external_downloaders.sort();
    external_downloaders.dedup();

    json!({
        "id": "nova-media-engine",
        "name": "NOVA Media Engine",
        "role": "media-extraction-engine",
        "available": available,
        "binary": media_bridge_bin,
        "version": version,
        "source": "NOVA managed media compatibility layer",
        "verifiedBy": ["managed resolver version probe", "managed resolver capability probe"],
        "availableFlags": sorted_vec(flags.clone()),
        "capabilities": {
            "siteExtraction": available,
            "playlists": media_bridge_key_supported("playlist", available, &flags, ffmpeg_available),
            "formatSelection": media_bridge_key_supported("formatSelector", available, &flags, ffmpeg_available),
            "formatSorting": media_bridge_key_supported("formatSort", available, &flags, ffmpeg_available),
            "audioExtraction": ffmpeg_available && media_bridge_key_supported("audioFormat", available, &flags, ffmpeg_available),
            "subtitles": media_bridge_key_supported("subtitles", available, &flags, ffmpeg_available),
            "autoSubtitles": media_bridge_key_supported("autoSubtitles", available, &flags, ffmpeg_available),
            "thumbnailWriteEmbed": media_bridge_key_supported("writeThumbnail", available, &flags, ffmpeg_available) || media_bridge_key_supported("embedThumbnail", available, &flags, ffmpeg_available),
            "metadataWriteEmbed": media_bridge_key_supported("embedMetadata", available, &flags, ffmpeg_available),
            "chapterSplit": media_bridge_key_supported("splitChapters", available, &flags, ffmpeg_available),
            "sponsorBlock": media_bridge_key_supported("sponsorBlock", available, &flags, ffmpeg_available),
            "partialSections": media_bridge_key_supported("downloadSections", available, &flags, ffmpeg_available),
            "concurrentFragments": media_bridge_key_supported("concurrentFragments", available, &flags, ffmpeg_available),
            "externalDownloader": media_bridge_key_supported("externalDownloader", available, &flags, ffmpeg_available),
            "cookies": media_bridge_key_supported("cookies", available, &flags, ffmpeg_available),
            "cookiesFromBrowser": media_bridge_key_supported("cookiesFromBrowser", available, &flags, ffmpeg_available),
            "proxy": media_bridge_key_supported("proxy", available, &flags, ffmpeg_available),
            "sourceAddress": media_bridge_key_supported("sourceAddress", available, &flags, ffmpeg_available),
            "retry": media_bridge_key_supported("retries", available, &flags, ffmpeg_available),
            "retrySleep": media_bridge_key_supported("retrySleep", available, &flags, ffmpeg_available),
            "downloadArchive": media_bridge_key_supported("downloadArchive", available, &flags, ffmpeg_available),
            "liveFromStart": media_bridge_key_supported("liveFromStart", available, &flags, ffmpeg_available),
            "postProcessing": ffmpeg_available,
            "plugins": false
        },
        "supportedExternalDownloaders": external_downloaders,
        "supportedMediaOptionKeys": sorted_vec(supported_keys),
        "unsupportedMediaOptionKeys": sorted_vec(unsupported_keys)
    })
}

fn ffmpeg_available(ffmpeg_bin: &str) -> bool {
    hidden_output(ffmpeg_bin, &["-version"]).is_some() || executable_available(ffmpeg_bin)
}

fn parse_ffmpeg_list(output: &str) -> HashSet<String> {
    let mut values = HashSet::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('-')
            || trimmed.starts_with("File formats")
            || trimmed.starts_with("Codecs")
            || trimmed.starts_with("Filters")
            || trimmed.starts_with("DEV")
            || trimmed.starts_with("D..")
            || trimmed.starts_with("Input:")
            || trimmed.starts_with("Output:")
        {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let first = parts.next().unwrap_or("");
        if first
            .chars()
            .any(|c| c == 'D' || c == 'E' || c == 'A' || c == 'V' || c == 'S' || c == '.')
        {
            if let Some(name) = parts.next() {
                for item in name.split(',') {
                    let item = item.trim();
                    if !item.is_empty()
                        && item
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                    {
                        values.insert(item.to_owned());
                    }
                }
            }
        }
    }
    values
}

fn parse_ffmpeg_protocols(output: &str) -> (HashSet<String>, HashSet<String>) {
    let mut input = HashSet::new();
    let mut output_set = HashSet::new();
    let mut target: Option<&str> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        match trimmed {
            "Input:" => {
                target = Some("input");
                continue;
            }
            "Output:" => {
                target = Some("output");
                continue;
            }
            _ => {}
        }
        if trimmed.is_empty() || trimmed.starts_with("Supported") {
            continue;
        }
        if let Some(target_name) = target {
            for item in trimmed.split_whitespace() {
                if item
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                {
                    if target_name == "input" {
                        input.insert(item.to_owned());
                    } else {
                        output_set.insert(item.to_owned());
                    }
                }
            }
        }
    }
    (input, output_set)
}

/// H3: whether the ffmpeg demuxer can read HLS/DASH manifests or a common
/// container. `formats` is a set of individual tokens (from `ffmpeg -formats`),
/// so each candidate must be checked separately — never the literal
/// comma-joined string.
fn hls_dash_supported(
    formats: &std::collections::HashSet<String>,
    input_protocols: &std::collections::HashSet<String>,
) -> bool {
    input_protocols.contains("http")
        && (formats.contains("hls")
            || formats.contains("dash")
            || ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]
                .iter()
                .any(|f| formats.contains(*f)))
}

pub fn ffmpeg_status(ffmpeg_bin: &str) -> Value {
    let output = hidden_output(ffmpeg_bin, &["-version"]);
    let available = output.is_some() || executable_available(ffmpeg_bin);
    let version_text = output
        .as_deref()
        .map_or_else(|| "unknown".to_owned(), first_line);
    let formats = if available {
        parse_ffmpeg_list(&hidden_output_any(ffmpeg_bin, &["-formats"]).unwrap_or_default())
    } else {
        HashSet::new()
    };
    let codecs = if available {
        parse_ffmpeg_list(&hidden_output_any(ffmpeg_bin, &["-codecs"]).unwrap_or_default())
    } else {
        HashSet::new()
    };
    let filters = if available {
        parse_ffmpeg_list(&hidden_output_any(ffmpeg_bin, &["-filters"]).unwrap_or_default())
    } else {
        HashSet::new()
    };
    let (input_protocols, output_protocols) = if available {
        parse_ffmpeg_protocols(&hidden_output_any(ffmpeg_bin, &["-protocols"]).unwrap_or_default())
    } else {
        (HashSet::new(), HashSet::new())
    };
    let remux_formats = [
        "mp4", "matroska", "webm", "mov", "m4a", "mp3", "flac", "ogg",
    ];
    let remux = remux_formats.iter().any(|name| formats.contains(*name));
    let subtitle_codecs = ["srt", "ass", "webvtt", "mov_text"];
    let subtitle_support = subtitle_codecs.iter().any(|name| codecs.contains(*name));

    json!({
        "id": "ffmpeg",
        "name": "FFmpeg",
        "role": "media-postprocessing-engine",
        "available": available,
        "binary": ffmpeg_bin,
        "versionText": version_text,
        "source": "https://ffmpeg.org/",
        "verifiedBy": ["ffmpeg -version", "ffmpeg -formats", "ffmpeg -codecs", "ffmpeg -protocols", "ffmpeg -filters"],
        "formats": sorted_vec(formats.clone()),
        "codecs": sorted_vec(codecs.clone()),
        "inputProtocols": sorted_vec(input_protocols.clone()),
        "outputProtocols": sorted_vec(output_protocols),
        "filters": sorted_vec(filters),
        "capabilities": {
            "mergeVideoAudio": available && remux,
            "remux": available && remux,
            "recode": available && !codecs.is_empty(),
            "audioExtraction": available && (codecs.contains("mp3") || codecs.contains("aac") || codecs.contains("flac") || codecs.contains("opus")),
            "embedSubtitles": available && subtitle_support,
            "embedThumbnail": available && remux,
            "embedMetadata": available && remux,
            "splitChapters": available && remux,
            // H3: `formats` is a set of individual tokens, so check each token
            // of the container list rather than the literal comma-joined
            // string (which never appears in the set). HLS/DASH download is
            // supported whenever the demuxer can read HLS/DASH manifests or a
            // common container.
            "hlsDashDownload": available && hls_dash_supported(&formats, &input_protocols)
        }
    })
}

fn media_option_requested(media: &MediaDownloadOptions, key: &str) -> bool {
    match key {
        "mode" => media.mode.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "quality" => media
            .quality
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "formatSelector" => media
            .format_selector
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "formatSort" => media
            .format_sort
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "audioFormat" => media
            .audio_format
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "bitrate" => media
            .bitrate
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "outputTemplate" => media
            .output_template
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "playlist" => media.playlist.is_some(),
        "playlistItems" => media
            .playlist_items
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "subtitles" => media.subtitles == Some(true),
        "subtitleLanguages" => media
            .subtitle_languages
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "autoSubtitles" => media.auto_subtitles == Some(true),
        "embedSubtitles" => media.embed_subtitles == Some(true),
        "writeThumbnail" => media.write_thumbnail == Some(true),
        "embedThumbnail" => media.embed_thumbnail == Some(true),
        "writeInfoJson" => media.write_info_json == Some(true),
        "writeDescription" => media.write_description == Some(true),
        "splitChapters" => media.split_chapters == Some(true),
        "sponsorBlock" => media
            .sponsor_block
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "proxy" => media.proxy.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "sourceAddress" => media
            .source_address
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "cookies" => media
            .cookies
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "cookiesFromBrowser" => media
            .cookies_from_browser
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "userAgent" => media
            .user_agent
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "referer" => media
            .referer
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "headers" => media
            .headers
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "rateLimitKbs" => media.rate_limit_kbs.is_some_and(|v| v > 0),
        "retries" => media.retries.is_some_and(|v| v > 0),
        "fragmentRetries" => media.fragment_retries.is_some_and(|v| v > 0),
        "fileAccessRetries" => media.file_access_retries.is_some_and(|v| v > 0),
        "retrySleep" => media
            .retry_sleep
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "concurrentFragments" => media.concurrent_fragments.is_some_and(|v| v > 0),
        "sleepIntervalSec" => media.sleep_interval_sec.is_some_and(|v| v > 0),
        "maxSleepIntervalSec" => media.max_sleep_interval_sec.is_some_and(|v| v > 0),
        "sleepRequestsSec" => media.sleep_requests_sec.is_some_and(|v| v > 0),
        "sleepSubtitlesSec" => media.sleep_subtitles_sec.is_some_and(|v| v > 0),
        "downloadSections" => media
            .download_sections
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "matchFilter" => media
            .match_filter
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "remuxFormat" => media
            .remux_format
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "ffmpegEnabled" => media.ffmpeg_enabled == Some(true),
        "ffmpegLocation" => media
            .ffmpeg_location
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "externalDownloader" => media
            .external_downloader
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "externalDownloaderArgs" => media
            .external_downloader_args
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "throttledRateKbs" => media.throttled_rate_kbs.is_some_and(|v| v > 0),
        "bufferSizeKbs" => media.buffer_size_kbs.is_some_and(|v| v > 0),
        "httpChunkSize" => media
            .http_chunk_size
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "downloadArchive" => media
            .download_archive
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "breakOnExisting" => media.break_on_existing == Some(true),
        "forceOverwrites" => media.force_overwrites.is_some(),
        "noOverwrites" => media.no_overwrites == Some(true),
        "restrictFilenames" => media.restrict_filenames.is_some(),
        "windowsFilenames" => media.windows_filenames.is_some(),
        "trimFilenames" => media.trim_filenames.is_some_and(|v| v > 0),
        "writeComments" => media.write_comments == Some(true),
        "embedMetadata" => media.embed_metadata.is_some(),
        "embedChapters" => media.embed_chapters.is_some(),
        "convertThumbnails" => media
            .convert_thumbnails
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "postprocessorArgs" => media
            .postprocessor_args
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "extractorArgs" => media
            .extractor_args
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "compatOptions" => media
            .compat_options
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "liveFromStart" => media.live_from_start == Some(true),
        "waitForVideo" => media
            .wait_for_video
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "socketTimeoutSec" => media.socket_timeout_sec.is_some_and(|v| v > 0),
        "minFilesize" => media
            .min_filesize
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "maxFilesize" => media
            .max_filesize
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "maxDownloads" => media.max_downloads.is_some_and(|v| v > 0),
        "username" => media
            .username
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "password" => media
            .password
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "twoFactor" => media
            .two_factor
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "netrc" => media.netrc == Some(true),
        "geoBypassCountry" => media
            .geo_bypass_country
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        "extraArgs" => media
            .extra_args
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty()),
        _ => false,
    }
}

pub fn validate_media_bridge_media_options(
    media_bridge_bin: &str,
    ffmpeg_bin: &str,
    media: &MediaDownloadOptions,
) -> Result<(), String> {
    let (available, _, flags) = media_bridge_model(media_bridge_bin);
    if !available {
        return Err(
            "NOVA Media Engine compatibility bridge is not available.".to_owned(),
        );
    }
    let ffmpeg_ok = media
        .ffmpeg_location
        .as_deref()
        .is_some_and(|path| Path::new(path).exists())
        || ffmpeg_available(ffmpeg_bin);
    let mut unsupported = Vec::new();
    for key in MEDIA_BRIDGE_MEDIA_OPTION_KEYS {
        if media_option_requested(media, key)
            && !media_bridge_key_supported(key, available, &flags, ffmpeg_ok)
        {
            unsupported.push((*key).to_owned());
        }
    }
    if let Some(mode) = media.mode.as_deref().map(str::trim) {
        if mode.eq_ignore_ascii_case("audio") && !ffmpeg_ok {
            unsupported.push("mode=audio requires ffmpeg".to_owned());
        }
    }
    if let Some(downloader) = media
        .external_downloader
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match downloader {
            "auto" | "native" => {}
            "curl" => unsupported
                .push("The curl external downloader binary is no longer bundled. Use the NOVA native transfer engine.".to_owned()),
            "ffmpeg" if ffmpeg_ok => {}
            "ffmpeg" => unsupported
                .push("externalDownloader=ffmpeg requires an available ffmpeg binary".to_owned()),
            "httpie" => {
                if !(flags.contains("--downloader") || flags.contains("--external-downloader")) {
                    unsupported.push(
                        "externalDownloader=httpie is not supported by the current media compatibility bridge".to_owned(),
                    );
                } else if !(executable_available("http") || executable_available("httpie")) {
                    unsupported.push(
                        "externalDownloader=httpie requires the httpie executable".to_owned(),
                    );
                }
            }
            "wget" => {
                if !(flags.contains("--downloader") || flags.contains("--external-downloader")) {
                    unsupported.push(
                        "externalDownloader=wget is not supported by the current media compatibility bridge".to_owned(),
                    );
                } else if !executable_available("wget") {
                    unsupported
                        .push("externalDownloader=wget requires the wget executable".to_owned());
                }
            }
            "axel" => {
                if !(flags.contains("--downloader") || flags.contains("--external-downloader")) {
                    unsupported.push(
                        "externalDownloader=axel is not supported by the current media compatibility bridge".to_owned(),
                    );
                } else if !executable_available("axel") {
                    unsupported
                        .push("externalDownloader=axel requires the axel executable".to_owned());
                }
            }
            other => unsupported.push(format!("externalDownloader={other} is not allowed")),
        }
    }
    if !unsupported.is_empty() {
        unsupported.sort();
        unsupported.dedup();
        return Err(format!(
            "Unsupported media option(s) for this installed NOVA media compatibility stack: {}",
            unsupported.join(", ")
        ));
    }
    Ok(())
}

pub fn native_torrent_status() -> Value {
    let capabilities = nova_torrent_core::TorrentCoreCapabilities::native_foundation();
    json!({
        "id": nova_torrent_core::ENGINE_ID,
        "name": "NOVA Torrent Engine",
        "role": "torrent-download-engine",
        // Keep the engine unavailable for task routing until tracker/peer
        // orchestration and durable resume are connected end-to-end.
        "available": false,
        "foundationReady": true,
        "version": env!("CARGO_PKG_VERSION"),
        "source": "in-process Rust torrent core",
        "runtimeCore": "nova-torrent-core",
        "capabilities": {
            "metainfoV1": capabilities.metainfo_v1,
            "magnetBtih": capabilities.magnet_btih,
            "peerWireV1": capabilities.peer_wire_v1,
            "pieceScheduler": capabilities.piece_scheduler,
            "httpTrackerProtocol": capabilities.http_tracker_protocol,
            "udpTrackerProtocol": capabilities.udp_tracker_protocol,
            "pieceHashVerification": true,
            "safeMultiFileLayout": true,
            "httpTrackers": false,
            "udpTrackers": false,
            "dht": false,
            "pex": false,
            "metadataExchange": false,
            "peerTransferExecution": false,
            "durableResume": false
        }
    })
}

pub fn all_engine_status(_media_bridge_bin: &str, ffmpeg_bin: &str) -> Value {
    let curl = curl_status();
    let media = native_media_status();
    let ffmpeg = ffmpeg_status(ffmpeg_bin);
    let torrent = native_torrent_status();
    let media_ready = media
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let ffmpeg_available = ffmpeg
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let direct_ready = curl
        .pointer("/capabilities/directDownloads")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let post_processing_ready = ffmpeg_available;
    let direct_protocols = curl
        .get("protocols")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    json!({
        "status": if direct_ready && media_ready { "connected" } else { "degraded" },
        "allReady": direct_ready && media_ready,
        "directReady": direct_ready,
        "mediaReady": media_ready,
        "postProcessingReady": post_processing_ready,
        "directProtocols": direct_protocols,
        "compatibilityMode": "runtime-verified-capabilities",
        "routing": {
            "directHttpHttpsFtp": if direct_ready { json!("libcurl-multi") } else { Value::Null },
            "webMediaAndPlaylists": if media_ready { json!("nova-media-engine") } else { Value::Null },
            "mergeRemuxExtractSubtitles": if post_processing_ready { json!("nova-media-postprocess") } else { Value::Null },
            "torrentMagnet": Value::Null
        },
        "engines": {
            "curl": curl,
            "libcurlMulti": curl,
            "media": media,
            "ffmpeg": ffmpeg,
            "torrent": torrent
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_torrent_status_exposes_foundation_without_claiming_task_execution() {
        let status = native_torrent_status();
        assert_eq!(status["runtimeCore"], "nova-torrent-core");
        assert_eq!(status["foundationReady"], true);
        assert_eq!(status["available"], false);
        assert_eq!(status["capabilities"]["metainfoV1"], true);
        assert_eq!(status["capabilities"]["magnetBtih"], true);
        assert_eq!(status["capabilities"]["httpTrackerProtocol"], true);
        assert_eq!(status["capabilities"]["udpTrackerProtocol"], true);
        assert_eq!(status["capabilities"]["peerTransferExecution"], false);
    }

    #[test]
    fn native_media_status_is_in_process_and_fail_closed() {
        let status = native_media_status();
        assert_eq!(status["available"], true);
        assert_eq!(status["runtimeCore"], "nova-media-core");
        assert_eq!(status["capabilities"]["directMediaExecution"], true);
        assert_eq!(status["capabilities"]["hlsStaging"], true);
        assert_eq!(status["capabilities"]["dashStaging"], true);
        assert_eq!(status["capabilities"]["youtubeThrottlingTransform"], true);
        assert_eq!(status["capabilities"]["hlsTaskExecution"], false);
        assert_eq!(status["capabilities"]["dashTaskExecution"], false);
        let supported = status["supportedMediaOptionKeys"]
            .as_array()
            .expect("supportedMediaOptionKeys");
        assert!(supported.iter().any(|value| value == "quality"));
        assert!(!supported.iter().any(|value| value == "audioFormat"));
    }

    #[test]
    fn media_readiness_does_not_depend_on_compatibility_binary() {
        let status = all_engine_status(
            "__nova_missing_compatibility_bridge__",
            "__nova_missing_post_processor__",
        );
        assert_eq!(status["mediaReady"], true);
        assert_eq!(status["engines"]["media"]["runtimeCore"], "nova-media-core");
        assert_eq!(status["postProcessingReady"], false);
    }

    #[test]
    fn normalizes_libcurl_build_suffixes() {
        assert_eq!(normalize_libcurl_version("8.21.0"), "8.21.0");
        assert_eq!(normalize_libcurl_version("8.21.0-DEV"), "8.21.0");
        assert_eq!(normalize_libcurl_version("8.21.0+local"), "8.21.0");
    }

    #[test]
    fn curl_status_returns_valid_json() {
        let status = curl_status();
        assert!(status.is_object());
        assert_eq!(status["id"], "libcurl-multi");
        assert_eq!(status["role"], "direct-download-engine");
        assert_eq!(status["runtimeCore"], "in-process-libcurl-multi");
        assert!(status["available"].as_bool().unwrap_or(false));
        assert!(status["version"].as_str().unwrap_or("").starts_with("8."));
    }

    #[test]
    fn curl_status_includes_tls_backend() {
        let status = curl_status();
        let tls = status.get("tls");
        assert!(tls.is_some(), "curl_status must include tls field");
        let tls = tls.unwrap();
        assert!(tls.get("backend").is_some(), "tls must include backend");
        assert!(tls.get("available").is_some(), "tls must include available");
    }

    #[test]
    fn curl_status_includes_build_integrity() {
        let status = curl_status();
        let integrity = status.get("buildIntegrity");
        assert!(
            integrity.is_some(),
            "curl_status must include buildIntegrity"
        );
        let integrity = integrity.unwrap();
        assert!(
            integrity.get("runtimeVersion").is_some(),
            "buildIntegrity must include runtimeVersion"
        );
        assert!(
            integrity.get("runtimeTlsBackend").is_some(),
            "buildIntegrity must include runtimeTlsBackend"
        );
        assert!(
            integrity.get("versionMatchesExpected").is_some(),
            "buildIntegrity must include versionMatchesExpected"
        );
    }

    #[test]
    fn curl_status_includes_protocols_and_features() {
        let status = curl_status();
        assert!(status["protocols"].is_array());
        assert!(status["compiledFeatures"].is_array());
        let protocols = status["protocols"].as_array().unwrap();
        assert!(
            protocols.iter().any(|p| p == "http" || p == "https"),
            "must support http or https"
        );
    }

    #[test]
    fn validate_integrity_passes_on_correct_build() {
        let result = validate_linked_libcurl_integrity();
        assert!(
            result.is_ok(),
            "integrity validation should pass: {:?}",
            result.err()
        );
    }

    #[test]
    fn linked_libcurl_features_includes_ssl() {
        let version = ::curl::Version::get();
        let features = linked_libcurl_features(&version);
        if version.feature_ssl() {
            assert!(features.contains(&"SSL".to_string()));
        }
    }

    #[test]
    fn linked_libcurl_features_includes_compression() {
        let version = ::curl::Version::get();
        let features = linked_libcurl_features(&version);
        if version.feature_libz() {
            assert!(features.contains(&"libz".to_string()));
        }
        if version.feature_brotli() {
            assert!(features.contains(&"brotli".to_string()));
        }
        if version.feature_zstd() {
            assert!(features.contains(&"zstd".to_string()));
        }
    }

    #[test]
    fn linked_libcurl_tls_backend_not_empty() {
        let backend = linked_libcurl_tls_backend();
        if ::curl::Version::get().feature_ssl() {
            assert!(
                !backend.is_empty() && backend != "none",
                "TLS backend should be detected when SSL is available"
            );
        }
    }

    #[test]
    fn curl_status_capabilities_structure() {
        let status = curl_status();
        let caps = status.get("capabilities");
        assert!(caps.is_some(), "curl_status must include capabilities");
        let caps = caps.unwrap();
        assert!(caps.get("directDownloads").is_some());
        assert!(caps.get("http").is_some());
        assert!(caps.get("https").is_some());
        assert!(caps.get("tlsOptions").is_some());
        assert!(caps.get("tlsBackend").is_some());
        assert!(caps.get("http2").is_some());
        assert!(caps.get("compression").is_some());
    }

    #[test]
    fn hls_dash_download_declared_when_mp4_demuxer_present() {
        // H3 regression: formats is a set of individual tokens; the literal
        // comma-joined container string never appears in it, so the old check
        // could never fire. With `mp4` present the capability must be true.
        let formats: std::collections::HashSet<String> = ["mp4", "mov", "m4a", "matroska"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let input_protocols: std::collections::HashSet<String> = ["http", "https", "tcp"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let hls_dash = hls_dash_supported(&formats, &input_protocols);
        assert!(
            hls_dash,
            "hlsDashDownload must be true when mp4 is in formats"
        );

        // Without any HLS/DASH/container token it must be false.
        let formats2: std::collections::HashSet<String> = ["pcm_s16le", "flac"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(!hls_dash_supported(&formats2, &input_protocols));
    }

    #[test]
    fn supported_raw_options_are_advertised_honestly() {
        // H4 regression: the raw-option candidate list was empty, so
        // supportedRawOptions was always empty. With the real libcurl flag
        // list it must advertise the options libcurl actually supports.
        let (available, _, _, _, features, flags) = linked_libcurl_model();
        let feature_set = lower_set(&features);
        let supported_raw: HashSet<String> = CANDIDATE_CURL_RAW_OPTIONS
            .iter()
            .filter(|flag| flags.contains(**flag))
            .map(|flag| (*flag).to_owned())
            .collect();
        if available {
            assert!(
                !supported_raw.is_empty(),
                "supportedRawOptions must be non-empty when libcurl is available"
            );
            // A core option we always expect (proxy) must be advertised.
            assert!(
                supported_raw.contains("--proxy"),
                "--proxy must be advertised as a supported raw option"
            );
        }
        // rawOptions as a direct option key stays unsupported (no passthrough).
        let http_protos: HashSet<String> =
            ["http", "https"].iter().map(|s| s.to_string()).collect();
        assert!(!curl_key_supported(
            "rawOptions",
            available,
            &http_protos,
            &feature_set,
            &flags
        ));
    }

    #[test]
    fn capability_claims_for_implemented_options_are_honest() {
        // L18 regression: options that ARE implemented (skipExisting in
        // transfer.rs, retryConnRefused in transfer_config/args) must be
        // advertised; options with no implementation must not be claimed.
        let (available, _, _, protocols, features, flags) = linked_libcurl_model();
        let protocol_set = lower_set(&protocols);
        let feature_set = lower_set(&features);
        assert!(
            curl_key_supported(
                "skipExisting",
                available,
                &protocol_set,
                &feature_set,
                &flags
            ),
            "skipExisting is implemented and must be advertised"
        );
        assert!(
            curl_key_supported(
                "retryConnRefused",
                available,
                &protocol_set,
                &feature_set,
                &flags
            ),
            "retryConnRefused is implemented and must be advertised"
        );
        // These are advertised only when the underlying libcurl build has the
        // feature — never unconditionally.
        let tf = curl_key_supported(
            "tcpFastOpen",
            available,
            &protocol_set,
            &feature_set,
            &flags,
        );
        if !available {
            assert!(!tf);
        }
    }
}
