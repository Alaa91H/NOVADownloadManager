use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use crate::daemon::types::MediaDownloadOptions;
use crate::daemon::utils::hide_command_window;

const CURL_DIRECT_OPTION_KEYS: &[&str] = &[
    "proxy", "preProxy", "noproxy", "proxyUser", "proxyAnyAuth", "sourceAddress", "interface",
    "userAgent", "referer", "headers", "cookies", "cookieJar", "username", "password", "authType",
    "oauth2Bearer", "netrc", "netrcOptional", "netrcFile", "speedLimitKbs", "speedLimitBytes",
    "lowSpeedLimitBytes", "speedTimeSec", "rate", "retryCount", "retryDelaySec", "retryMaxTimeSec",
    "retryAllErrors", "retryConnRefused", "timeoutSec", "connectTimeoutSec", "maxRedirs", "maxFilesize",
    "range", "etagSave", "etagCompare", "timeCond", "remoteTime", "skipExisting", "removeOnError",
    "allowOverwrite", "location", "failWithBody", "httpVersion", "requestMethod", "data", "form",
    "compressed", "insecure", "caCert", "caPath", "cert", "certType", "key", "keyType", "pass",
    "pinnedPubKey", "tlsMax", "ciphers", "tls13Ciphers", "sslReqd", "ftpCreateDirs", "proto",
    "protoRedir", "dohUrl", "dnsServers", "dnsInterface", "resolve", "connectTo", "localPort",
    "tcpNoDelay", "tcpFastOpen", "keepaliveTimeSec", "happyEyeballsTimeoutMs", "pathAsIs", "globoff",
    "segmented", "forceSingleConnection"
];

const YTDLP_MEDIA_OPTION_KEYS: &[&str] = &[
    "mode", "quality", "formatSelector", "formatSort", "audioFormat", "bitrate", "outputTemplate",
    "playlist", "playlistItems", "subtitles", "subtitleLanguages", "autoSubtitles", "embedSubtitles",
    "writeThumbnail", "embedThumbnail", "writeInfoJson", "writeDescription", "splitChapters",
    "sponsorBlock", "proxy", "sourceAddress", "cookies", "cookiesFromBrowser", "userAgent",
    "referer", "headers", "rateLimitKbs", "retries", "fragmentRetries", "fileAccessRetries",
    "retrySleep", "concurrentFragments", "sleepIntervalSec", "maxSleepIntervalSec", "sleepRequestsSec",
    "sleepSubtitlesSec", "downloadSections", "matchFilter", "remuxFormat", "ffmpegEnabled",
    "ffmpegLocation", "externalDownloader", "externalDownloaderArgs", "throttledRateKbs", "bufferSizeKbs",
    "httpChunkSize", "downloadArchive", "breakOnExisting", "forceOverwrites", "noOverwrites",
    "restrictFilenames", "windowsFilenames", "trimFilenames", "writeComments", "embedMetadata",
    "embedChapters", "convertThumbnails", "postprocessorArgs", "extractorArgs", "compatOptions",
    "liveFromStart", "waitForVideo", "socketTimeoutSec", "minFilesize", "maxFilesize", "maxDownloads",
    "username", "password", "twoFactor", "netrc", "geoBypassCountry", "extraArgs",
];

const CANDIDATE_CURL_RAW_OPTIONS: &[&str] = &[];

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
    text.lines().next().unwrap_or("unknown").trim().to_string()
}

fn second_token(line: &str) -> String {
    line.split_whitespace().nth(1).unwrap_or("unknown").to_string()
}

fn split_after_label(text: &str, label: &str) -> Vec<String> {
    text.lines()
        .find_map(|line| line.trim().strip_prefix(label).map(str::trim))
        .map(|line| line.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
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
            let cleaned = part
                .trim()
                .trim_matches(|c: char| matches!(c, ',' | ';' | ':' | ')' | '(' | '[' | ']' | '{' | '}' | '<' | '>' | '='));
            if cleaned.starts_with("--") && cleaned.len() > 2 {
                let flag = cleaned
                    .split(|c: char| matches!(c, '=' | '[' | '<' | '|' | ','))
                    .next()
                    .unwrap_or(cleaned)
                    .trim()
                    .to_string();
                if flag.starts_with("--") {
                    flags.insert(flag);
                }
            }
        }
    }
    flags
}

fn collect_curl_help(command: &str) -> String {
    hidden_output_any(command, &["--help", "all"])
        .or_else(|| hidden_output_any(command, &["--help"])).unwrap_or_default()
}

fn linked_libcurl_features(version: &::curl::Version) -> Vec<String> {
    let mut features = Vec::new();
    if version.feature_ssl() { features.push("SSL".to_string()); }
    if version.feature_libz() { features.push("libz".to_string()); }
    if version.feature_brotli() { features.push("brotli".to_string()); }
    if version.feature_zstd() { features.push("zstd".to_string()); }
    if version.feature_http2() { features.push("HTTP2".to_string()); }
    if version.feature_http3() { features.push("HTTP3".to_string()); }
    if version.feature_ipv6() { features.push("IPv6".to_string()); }
    if version.feature_async_dns() { features.push("AsynchDNS".to_string()); }
    if version.feature_https_proxy() { features.push("HTTPS-proxy".to_string()); }
    if version.feature_largefile() { features.push("Largefile".to_string()); }
    if version.feature_ntlm() { features.push("NTLM".to_string()); }
    features
}

fn linked_libcurl_flags(version: &::curl::Version) -> HashSet<String> {
    let mut flags = HashSet::new();
    for flag in [
        "--proxy", "--noproxy", "--interface", "--user-agent", "--referer", "--header",
        "--cookie", "--limit-rate", "--speed-limit", "--speed-time", "--retry", "--retry-delay",
        "--max-time", "--connect-timeout", "--max-redirs", "--range", "--remove-on-error",
        "--no-clobber", "--location", "--fail-with-body", "--continue-at", "--http1.0",
        "--http1.1", "--compressed", "--insecure", "--cacert",
    ] {
        flags.insert(flag.to_string());
    }
    if version.feature_http2() {
        flags.insert("--http2".to_string());
        flags.insert("--http2-prior-knowledge".to_string());
    }
    if version.feature_http3() {
        flags.insert("--http3".to_string());
        flags.insert("--http3-only".to_string());
    }
    flags
}


fn expected_libcurl_version() -> String {
    option_env!("NOVA_BUILD_LIBCURL_VERSION").unwrap_or("unmanaged").to_string()
}

fn expected_libcurl_tag() -> String {
    option_env!("NOVA_BUILD_LIBCURL_TAG").unwrap_or("unmanaged").to_string()
}

fn expected_libcurl_sha256() -> String {
    option_env!("NOVA_BUILD_LIBCURL_SHA256").unwrap_or("unmanaged").to_string()
}

fn expected_csv_set(value: &str) -> HashSet<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "unmanaged")
        .map(|v| v.to_ascii_lowercase())
        .collect()
}

fn expected_libcurl_protocols() -> HashSet<String> {
    expected_csv_set(option_env!("NOVA_BUILD_LIBCURL_PROTOCOLS").unwrap_or("unmanaged"))
}

fn expected_libcurl_features() -> HashSet<String> {
    expected_csv_set(option_env!("NOVA_BUILD_LIBCURL_FEATURES").unwrap_or("unmanaged"))
}

fn expected_libcurl_feature_profile() -> String {
    option_env!("NOVA_BUILD_LIBCURL_FEATURE_PROFILE").unwrap_or("unmanaged").to_string()
}

fn expected_libcurl_prefix() -> String {
    option_env!("NOVA_BUILD_LIBCURL_PREFIX").unwrap_or("unmanaged").to_string()
}

fn libcurl_link_mode() -> String {
    option_env!("NOVA_BUILD_LIBCURL_LINK_MODE").unwrap_or("system-or-vendored-fallback").to_string()
}

fn normalize_libcurl_version(value: &str) -> String {
    value
        .trim()
        .split(|c| c == '-' || c == '+')
        .next()
        .unwrap_or("")
        .to_string()
}

fn linked_libcurl_version() -> String {
    ::curl::Version::get().version().to_string()
}

fn libcurl_version_matches_expected() -> bool {
    let expected = expected_libcurl_version();
    expected == "unmanaged"
        || normalize_libcurl_version(&expected) == normalize_libcurl_version(&linked_libcurl_version())
}

fn linked_libcurl_model() -> (bool, String, String, Vec<String>, Vec<String>, HashSet<String>) {
    let linked = ::curl::Version::get();
    let protocols: Vec<String> = linked.protocols().map(|p| p.to_string()).collect();
    let features = linked_libcurl_features(&linked);
    let version_line = format!("libcurl {}", linked.version());
    let text = format!(
        "{}\nProtocols: {}\nFeatures: {}",
        version_line,
        protocols.join(" "),
        features.join(" ")
    );
    (true, text, version_line, protocols, features, linked_libcurl_flags(&linked))
}

fn curl_cli_status(curl_bin: &str) -> Value {
    if let Some(text) = hidden_output(curl_bin, &["--version"]) {
        let flags = parse_long_flags(&collect_curl_help(curl_bin));
        json!({
            "available": true,
            "binary": curl_bin,
            "versionText": first_line(&text),
            "protocols": split_after_label(&text, "Protocols:"),
            "compiledFeatures": split_after_label(&text, "Features:"),
            "availableFlags": sorted_vec(flags),
            "role": "diagnostic-cli-and-yt-dlp-external-downloader",
            "sourceOfTruthForDirectEngine": false
        })
    } else {
        json!({
            "available": false,
            "binary": curl_bin,
            "role": "diagnostic-cli-and-yt-dlp-external-downloader",
            "sourceOfTruthForDirectEngine": false
        })
    }
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
    protocols: &HashSet<String>,
    features: &HashSet<String>,
    flags: &HashSet<String>,
) -> bool {
    if !available {
        return false;
    }
    let implemented_by_libcurl_multi = matches!(
        key,
        "proxy"
            | "noproxy"
            | "sourceAddress"
            | "interface"
            | "userAgent"
            | "referer"
            | "headers"
            | "cookies"
            | "speedLimitKbs"
            | "speedLimitBytes"
            | "lowSpeedLimitBytes"
            | "speedTimeSec"
            | "retryCount"
            | "retryDelaySec"
            | "timeoutSec"
            | "connectTimeoutSec"
            | "maxRedirs"
            | "range"
            | "removeOnError"
            | "allowOverwrite"
            | "location"
            | "failWithBody"
            | "httpVersion"
            | "compressed"
            | "insecure"
            | "caCert"
            | "segmented"
            | "forceSingleConnection"
    );
    if !implemented_by_libcurl_multi {
        return false;
    }
    match key {
        "segmented" | "forceSingleConnection" => true,
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
        "authType" => has_flag(flags, "--basic") || has_flag(flags, "--digest") || has_flag(flags, "--ntlm") || has_flag(flags, "--anyauth"),
        "oauth2Bearer" => has_flag(flags, "--oauth2-bearer"),
        "netrc" => has_flag(flags, "--netrc"),
        "netrcOptional" => has_flag(flags, "--netrc-optional"),
        "netrcFile" => has_flag(flags, "--netrc-file"),
        "speedLimitKbs" | "speedLimitBytes" => has_flag(flags, "--limit-rate"),
        "lowSpeedLimitBytes" => has_flag(flags, "--speed-limit"),
        "speedTimeSec" => has_flag(flags, "--speed-time"),
        "rate" => has_flag(flags, "--rate"),
        "retryCount" => has_flag(flags, "--retry"),
        "retryDelaySec" => has_flag(flags, "--retry-delay"),
        "retryMaxTimeSec" => has_flag(flags, "--retry-max-time"),
        "retryAllErrors" => has_flag(flags, "--retry-all-errors"),
        "retryConnRefused" => has_flag(flags, "--retry-connrefused"),
        "timeoutSec" => has_flag(flags, "--max-time"),
        "connectTimeoutSec" => has_flag(flags, "--connect-timeout"),
        "maxRedirs" => has_flag(flags, "--max-redirs"),
        "maxFilesize" => has_flag(flags, "--max-filesize"),
        "range" => has_flag(flags, "--range"),
        "etagSave" => has_flag(flags, "--etag-save"),
        "etagCompare" => has_flag(flags, "--etag-compare"),
        "timeCond" => has_flag(flags, "--time-cond"),
        "remoteTime" => has_flag(flags, "--remote-time"),
        "skipExisting" => has_flag(flags, "--skip-existing"),
        "removeOnError" => has_flag(flags, "--remove-on-error"),
        "allowOverwrite" => has_flag(flags, "--no-clobber"),
        "location" => has_flag(flags, "--location"),
        "failWithBody" => has_flag(flags, "--fail-with-body"),
        "httpVersion" => has_flag(flags, "--http1.0") || has_flag(flags, "--http1.1") || has_flag(flags, "--http2") || has_flag(flags, "--http3"),
        "requestMethod" => has_flag(flags, "--request"),
        "data" => has_flag(flags, "--data-raw") || has_flag(flags, "--data"),
        "form" => has_flag(flags, "--form-string") || has_flag(flags, "--form"),
        "compressed" => has_flag(flags, "--compressed") && (has_feature(features, "libz") || has_feature(features, "brotli") || has_feature(features, "zstd")),
        "insecure" => has_flag(flags, "--insecure") && has_feature(features, "ssl"),
        "caCert" => has_flag(flags, "--cacert") && has_feature(features, "ssl"),
        "caPath" => has_flag(flags, "--capath") && has_feature(features, "ssl"),
        "cert" => has_flag(flags, "--cert") && has_feature(features, "ssl"),
        "certType" => has_flag(flags, "--cert-type") && has_feature(features, "ssl"),
        "key" => has_flag(flags, "--key") && has_feature(features, "ssl"),
        "keyType" => has_flag(flags, "--key-type") && has_feature(features, "ssl"),
        "pass" => has_flag(flags, "--pass") && has_feature(features, "ssl"),
        "pinnedPubKey" => has_flag(flags, "--pinnedpubkey") && has_feature(features, "ssl"),
        "tlsMax" => has_flag(flags, "--tls-max") && has_feature(features, "ssl"),
        "ciphers" => has_flag(flags, "--ciphers") && has_feature(features, "ssl"),
        "tls13Ciphers" => has_flag(flags, "--tls13-ciphers") && has_feature(features, "ssl"),
        "sslReqd" => has_flag(flags, "--ssl-reqd") && (has_protocol(protocols, "ftp") || has_protocol(protocols, "ftps")),
        "ftpCreateDirs" => has_flag(flags, "--ftp-create-dirs") && (has_protocol(protocols, "ftp") || has_protocol(protocols, "ftps")),
        "proto" => has_flag(flags, "--proto"),
        "protoRedir" => has_flag(flags, "--proto-redir"),
        "dohUrl" => has_flag(flags, "--doh-url") && has_feature(features, "https-proxy"),
        "dnsServers" => has_flag(flags, "--dns-servers"),
        "dnsInterface" => has_flag(flags, "--dns-interface"),
        "resolve" => has_flag(flags, "--resolve"),
        "connectTo" => has_flag(flags, "--connect-to"),
        "localPort" => has_flag(flags, "--local-port"),
        "tcpNoDelay" => has_flag(flags, "--tcp-nodelay"),
        "tcpFastOpen" => has_flag(flags, "--tcp-fastopen") && has_feature(features, "tcp-fastopen"),
        "keepaliveTimeSec" => has_flag(flags, "--keepalive-time"),
        "happyEyeballsTimeoutMs" => has_flag(flags, "--happy-eyeballs-timeout-ms") && has_feature(features, "asynchdns"),
        "pathAsIs" => has_flag(flags, "--path-as-is"),
        "globoff" => has_flag(flags, "--globoff"),
        "rawOptions" => false,
        _ => false,
    }
}

fn curl_supported_http_versions(features: &HashSet<String>, flags: &HashSet<String>) -> Vec<String> {
    let mut versions = Vec::new();
    if has_flag(flags, "--http1.0") {
        versions.push("1.0".to_string());
    }
    if has_flag(flags, "--http1.1") {
        versions.push("1.1".to_string());
    }
    if has_flag(flags, "--http2") && has_feature(features, "http2") {
        versions.push("2".to_string());
    }
    if has_flag(flags, "--http2-prior-knowledge") && has_feature(features, "http2") {
        versions.push("2-prior-knowledge".to_string());
    }
    if has_flag(flags, "--http3") && has_feature(features, "http3") {
        versions.push("3".to_string());
    }
    if has_flag(flags, "--http3-only") && has_feature(features, "http3") {
        versions.push("3-only".to_string());
    }
    versions
}

pub fn curl_status(curl_bin: &str) -> Value {
    let (available, text, version_line, protocols, features, flags) = linked_libcurl_model();
    let protocol_set = lower_set(&protocols);
    let feature_set = lower_set(&features);
    let supported_keys: HashSet<String> = CURL_DIRECT_OPTION_KEYS
        .iter()
        .filter(|key| curl_key_supported(key, available, &protocol_set, &feature_set, &flags))
        .map(|key| (*key).to_string())
        .collect();
    let all_keys: HashSet<String> = CURL_DIRECT_OPTION_KEYS.iter().map(|key| (*key).to_string()).collect();
    let unsupported_keys: HashSet<String> = all_keys.difference(&supported_keys).cloned().collect();
    let supported_raw: HashSet<String> = CANDIDATE_CURL_RAW_OPTIONS
        .iter()
        .filter(|flag| flags.contains(**flag))
        .map(|flag| (*flag).to_string())
        .collect();
    let http_versions = curl_supported_http_versions(&feature_set, &flags);

    json!({
        "id": "libcurl-multi",
        "name": "libcurl multi",
        "role": "direct-download-engine",
        "runtimeCore": "in-process-libcurl-multi",
        "available": available,
        "binary": "linked-libcurl",
        "externalCurlBinary": executable_available(curl_bin),
        "diagnosticCli": curl_cli_status(curl_bin),
        "version": if available { second_token(&version_line) } else { "unknown".to_string() },
        "versionText": if available { version_line } else { "unknown".to_string() },
        "source": "https://github.com/curl/curl",
        "verifiedBy": ["linked libcurl Version::get() only; curl CLI is diagnostic-only"],
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
            "runtimeProtocols": protocols.clone(),
            "runtimeFeatures": features.clone(),
            "versionMatchesExpected": libcurl_version_matches_expected(),
            "protocolsMatchExpected": expected_libcurl_protocols().is_empty() || expected_libcurl_protocols().is_subset(&protocol_set),
            "featuresMatchExpected": expected_libcurl_features().is_empty() || expected_libcurl_features().is_subset(&feature_set),
            "productionPinned": expected_libcurl_version() != "unmanaged"
        },
        "libcurlMulti": {
            "available": true,
            "binding": "curl-rust",
            "multiInterface": true,
            "segmentedDownloads": true,
            "maxConnectionsPerTask": 32,
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

fn curl_direct_supported_set(_curl_bin: &str) -> (bool, HashSet<String>, HashSet<String>, HashSet<String>, Vec<String>) {
    let (available, _, _, protocols, features, flags) = linked_libcurl_model();
    let protocol_set = lower_set(&protocols);
    let feature_set = lower_set(&features);
    let keys = CURL_DIRECT_OPTION_KEYS
        .iter()
        .filter(|key| curl_key_supported(key, available, &protocol_set, &feature_set, &flags))
        .map(|key| (*key).to_string())
        .collect();
    let raw = CANDIDATE_CURL_RAW_OPTIONS
        .iter()
        .filter(|flag| flags.contains(**flag))
        .map(|flag| (*flag).to_string())
        .collect();
    let http_versions = curl_supported_http_versions(&feature_set, &flags);
    (available, keys, raw, flags, http_versions)
}

pub fn curl_supports_flag(_curl_bin: &str, flag: &str) -> bool {
    let (_, _, _, _, _, flags) = linked_libcurl_model();
    flags.contains(flag)
}

pub fn validate_linked_libcurl_integrity() -> Result<(), String> {
    let expected = expected_libcurl_version();
    let linked_version = linked_libcurl_version();
    let (_, _, _, protocols, features, _) = linked_libcurl_model();
    let protocol_set = lower_set(&protocols);
    let feature_set = lower_set(&features);
    if expected != "unmanaged"
        && normalize_libcurl_version(&expected) != normalize_libcurl_version(&linked_version)
    {
        return Err(format!(
            "Linked libcurl mismatch: build expected {}, but runtime reports {}. Rebuild with pnpm run native-curl:build and ensure PKG_CONFIG_PATH points to bin/native-curl-manifest.json pkgConfigPath before Cargo/Tauri build.",
            expected,
            linked_version
        ));
    }
    let expected_protocols = expected_libcurl_protocols();
    if !expected_protocols.is_empty() && !expected_protocols.is_subset(&protocol_set) {
        let mut missing: Vec<String> = expected_protocols.difference(&protocol_set).cloned().collect();
        missing.sort();
        return Err(format!("Linked libcurl protocol mismatch. Missing runtime protocol(s): {}", missing.join(", ")));
    }
    let expected_features = expected_libcurl_features();
    if !expected_features.is_empty() && !expected_features.is_subset(&feature_set) {
        let mut missing: Vec<String> = expected_features.difference(&feature_set).cloned().collect();
        missing.sort();
        return Err(format!("Linked libcurl feature mismatch. Missing runtime feature(s): {}", missing.join(", ")));
    }
    Ok(())
}

pub fn validate_curl_direct_options(
    curl_bin: &str,
    direct_options: &HashMap<String, Value>,
    resumable: bool,
) -> Result<(), String> {
    let (available, supported_keys, supported_raw, flags, http_versions) = curl_direct_supported_set(curl_bin);
    if !available {
        return Err("curl is not available. The direct-download engine cannot start.".to_string());
    }
    if resumable && !flags.contains("--continue-at") {
        return Err("This curl build does not expose --continue-at, so resumable direct downloads are not supported.".to_string());
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
        return Err("curl option removeOnError is incompatible with resumable downloads because curl cannot combine --remove-on-error with --continue-at -. Disable resumable or remove removeOnError.".to_string());
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
        .to_string();
        if !http_versions.iter().any(|item| item == &normalized) {
            return Err(format!(
                "Requested HTTP version '{}' is not supported by this curl build. Supported versions: {}",
                version,
                if http_versions.is_empty() { "none".to_string() } else { http_versions.join(", ") }
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
                rejected.push(flag.to_string());
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

fn collect_ytdlp_help(command: &str) -> String {
    hidden_output_any(command, &["--help"]).unwrap_or_default()
}

fn ytdlp_model(ytdlp_bin: &str) -> (bool, String, HashSet<String>) {
    let version = hidden_output(ytdlp_bin, &["--version"])
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let available = version != "unknown" || executable_available(ytdlp_bin);
    let flags = if available { parse_long_flags(&collect_ytdlp_help(ytdlp_bin)) } else { HashSet::new() };
    (available, version, flags)
}

fn ytdlp_key_supported(key: &str, available: bool, flags: &HashSet<String>, ffmpeg_available: bool) -> bool {
    if !available {
        return false;
    }
    match key {
        "mode" => true,
        "quality" | "formatSelector" => flags.contains("--format") || flags.contains("-f"),
        "formatSort" => flags.contains("--format-sort"),
        "audioFormat" | "bitrate" => ffmpeg_available && (flags.contains("--audio-format") || flags.contains("--audio-quality")),
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
        "externalDownloader" => flags.contains("--downloader") || flags.contains("--external-downloader"),
        "externalDownloaderArgs" => flags.contains("--downloader-args") || flags.contains("--external-downloader-args"),
        "throttledRateKbs" => flags.contains("--throttled-rate"),
        "bufferSizeKbs" => flags.contains("--buffer-size"),
        "httpChunkSize" => flags.contains("--http-chunk-size"),
        "downloadArchive" => flags.contains("--download-archive"),
        "breakOnExisting" => flags.contains("--break-on-existing"),
        "forceOverwrites" => flags.contains("--force-overwrites") || flags.contains("--no-force-overwrites"),
        "noOverwrites" => flags.contains("--no-overwrites"),
        "restrictFilenames" => flags.contains("--restrict-filenames") || flags.contains("--no-restrict-filenames"),
        "windowsFilenames" => flags.contains("--windows-filenames") || flags.contains("--no-windows-filenames"),
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

pub fn ytdlp_status_with_context(ytdlp_bin: &str, curl_available: bool, ffmpeg_available: bool) -> Value {
    let (available, version, flags) = ytdlp_model(ytdlp_bin);
    let supported_keys: HashSet<String> = YTDLP_MEDIA_OPTION_KEYS
        .iter()
        .filter(|key| ytdlp_key_supported(key, available, &flags, ffmpeg_available))
        .map(|key| (*key).to_string())
        .collect();
    let all_keys: HashSet<String> = YTDLP_MEDIA_OPTION_KEYS.iter().map(|key| (*key).to_string()).collect();
    let unsupported_keys: HashSet<String> = all_keys.difference(&supported_keys).cloned().collect();
    let mut external_downloaders = vec!["native".to_string()];
    if curl_available {
        external_downloaders.push("curl".to_string());
    }
    if ffmpeg_available {
        external_downloaders.push("ffmpeg".to_string());
    }
    if available && flags.contains("--downloader") {
        if executable_available("http") || executable_available("httpie") {
            external_downloaders.push("httpie".to_string());
        }
        if executable_available("wget") {
            external_downloaders.push("wget".to_string());
        }
        if executable_available("axel") {
            external_downloaders.push("axel".to_string());
        }
    }
    external_downloaders.sort();
    external_downloaders.dedup();

    json!({
        "id": "yt-dlp",
        "name": "yt-dlp",
        "role": "media-extraction-engine",
        "available": available,
        "binary": ytdlp_bin,
        "version": version,
        "source": "https://github.com/yt-dlp/yt-dlp",
        "verifiedBy": ["yt-dlp --version", "yt-dlp --help"],
        "availableFlags": sorted_vec(flags.clone()),
        "capabilities": {
            "siteExtraction": available,
            "playlists": ytdlp_key_supported("playlist", available, &flags, ffmpeg_available),
            "formatSelection": ytdlp_key_supported("formatSelector", available, &flags, ffmpeg_available),
            "formatSorting": ytdlp_key_supported("formatSort", available, &flags, ffmpeg_available),
            "audioExtraction": ffmpeg_available && ytdlp_key_supported("audioFormat", available, &flags, ffmpeg_available),
            "subtitles": ytdlp_key_supported("subtitles", available, &flags, ffmpeg_available),
            "autoSubtitles": ytdlp_key_supported("autoSubtitles", available, &flags, ffmpeg_available),
            "thumbnailWriteEmbed": ytdlp_key_supported("writeThumbnail", available, &flags, ffmpeg_available) || ytdlp_key_supported("embedThumbnail", available, &flags, ffmpeg_available),
            "metadataWriteEmbed": ytdlp_key_supported("embedMetadata", available, &flags, ffmpeg_available),
            "chapterSplit": ytdlp_key_supported("splitChapters", available, &flags, ffmpeg_available),
            "sponsorBlock": ytdlp_key_supported("sponsorBlock", available, &flags, ffmpeg_available),
            "partialSections": ytdlp_key_supported("downloadSections", available, &flags, ffmpeg_available),
            "concurrentFragments": ytdlp_key_supported("concurrentFragments", available, &flags, ffmpeg_available),
            "externalDownloader": ytdlp_key_supported("externalDownloader", available, &flags, ffmpeg_available),
            "cookies": ytdlp_key_supported("cookies", available, &flags, ffmpeg_available),
            "cookiesFromBrowser": ytdlp_key_supported("cookiesFromBrowser", available, &flags, ffmpeg_available),
            "proxy": ytdlp_key_supported("proxy", available, &flags, ffmpeg_available),
            "sourceAddress": ytdlp_key_supported("sourceAddress", available, &flags, ffmpeg_available),
            "retry": ytdlp_key_supported("retries", available, &flags, ffmpeg_available),
            "retrySleep": ytdlp_key_supported("retrySleep", available, &flags, ffmpeg_available),
            "downloadArchive": ytdlp_key_supported("downloadArchive", available, &flags, ffmpeg_available),
            "liveFromStart": ytdlp_key_supported("liveFromStart", available, &flags, ffmpeg_available),
            "postProcessing": ffmpeg_available,
            "plugins": false
        },
        "supportedExternalDownloaders": external_downloaders,
        "blockedExternalDownloaders": ["aria2", "aria2c"],
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
        if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.starts_with("File formats") || trimmed.starts_with("Codecs") || trimmed.starts_with("Filters") || trimmed.starts_with("DEV") || trimmed.starts_with("D..") || trimmed.starts_with("Input:") || trimmed.starts_with("Output:") {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let first = parts.next().unwrap_or("");
        if first.chars().any(|c| c == 'D' || c == 'E' || c == 'A' || c == 'V' || c == 'S' || c == '.') {
            if let Some(name) = parts.next() {
                for item in name.split(',') {
                    let item = item.trim();
                    if !item.is_empty() && item.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                        values.insert(item.to_string());
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
                if item.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
                    if target_name == "input" {
                        input.insert(item.to_string());
                    } else {
                        output_set.insert(item.to_string());
                    }
                }
            }
        }
    }
    (input, output_set)
}

pub fn ffmpeg_status(ffmpeg_bin: &str) -> Value {
    let output = hidden_output(ffmpeg_bin, &["-version"]);
    let available = output.is_some() || executable_available(ffmpeg_bin);
    let version_text = output.as_deref().map(first_line).unwrap_or_else(|| "unknown".to_string());
    let formats = if available { parse_ffmpeg_list(&hidden_output_any(ffmpeg_bin, &["-formats"]).unwrap_or_default()) } else { HashSet::new() };
    let codecs = if available { parse_ffmpeg_list(&hidden_output_any(ffmpeg_bin, &["-codecs"]).unwrap_or_default()) } else { HashSet::new() };
    let filters = if available { parse_ffmpeg_list(&hidden_output_any(ffmpeg_bin, &["-filters"]).unwrap_or_default()) } else { HashSet::new() };
    let (input_protocols, output_protocols) = if available {
        parse_ffmpeg_protocols(&hidden_output_any(ffmpeg_bin, &["-protocols"]).unwrap_or_default())
    } else {
        (HashSet::new(), HashSet::new())
    };
    let remux_formats = ["mp4", "matroska", "webm", "mov", "m4a", "mp3", "flac", "ogg"];
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
        "outputProtocols": sorted_vec(output_protocols.clone()),
        "filters": sorted_vec(filters.clone()),
        "capabilities": {
            "mergeVideoAudio": available && remux,
            "remux": available && remux,
            "recode": available && !codecs.is_empty(),
            "audioExtraction": available && (codecs.contains("mp3") || codecs.contains("aac") || codecs.contains("flac") || codecs.contains("opus")),
            "embedSubtitles": available && subtitle_support,
            "embedThumbnail": available && remux,
            "embedMetadata": available && remux,
            "splitChapters": available && remux,
            "hlsDashDownload": available && input_protocols.contains("http") && (formats.contains("hls") || formats.contains("dash") || formats.contains("mov,mp4,m4a,3gp,3g2,mj2"))
        }
    })
}

fn media_option_requested(media: &MediaDownloadOptions, key: &str) -> bool {
    match key {
        "mode" => media.mode.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "quality" => media.quality.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "formatSelector" => media.format_selector.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "formatSort" => media.format_sort.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "audioFormat" => media.audio_format.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "bitrate" => media.bitrate.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "outputTemplate" => media.output_template.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "playlist" => media.playlist.is_some(),
        "playlistItems" => media.playlist_items.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "subtitles" => media.subtitles == Some(true),
        "subtitleLanguages" => media.subtitle_languages.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "autoSubtitles" => media.auto_subtitles == Some(true),
        "embedSubtitles" => media.embed_subtitles == Some(true),
        "writeThumbnail" => media.write_thumbnail == Some(true),
        "embedThumbnail" => media.embed_thumbnail == Some(true),
        "writeInfoJson" => media.write_info_json == Some(true),
        "writeDescription" => media.write_description == Some(true),
        "splitChapters" => media.split_chapters == Some(true),
        "sponsorBlock" => media.sponsor_block.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "proxy" => media.proxy.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "sourceAddress" => media.source_address.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "cookies" => media.cookies.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "cookiesFromBrowser" => media.cookies_from_browser.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "userAgent" => media.user_agent.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "referer" => media.referer.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "headers" => media.headers.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "rateLimitKbs" => media.rate_limit_kbs.is_some_and(|v| v > 0),
        "retries" => media.retries.is_some_and(|v| v > 0),
        "fragmentRetries" => media.fragment_retries.is_some_and(|v| v > 0),
        "fileAccessRetries" => media.file_access_retries.is_some_and(|v| v > 0),
        "retrySleep" => media.retry_sleep.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "concurrentFragments" => media.concurrent_fragments.is_some_and(|v| v > 0),
        "sleepIntervalSec" => media.sleep_interval_sec.is_some_and(|v| v > 0),
        "maxSleepIntervalSec" => media.max_sleep_interval_sec.is_some_and(|v| v > 0),
        "sleepRequestsSec" => media.sleep_requests_sec.is_some_and(|v| v > 0),
        "sleepSubtitlesSec" => media.sleep_subtitles_sec.is_some_and(|v| v > 0),
        "downloadSections" => media.download_sections.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "matchFilter" => media.match_filter.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "remuxFormat" => media.remux_format.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "ffmpegEnabled" => media.ffmpeg_enabled.is_some(),
        "ffmpegLocation" => media.ffmpeg_location.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "externalDownloader" => media.external_downloader.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "externalDownloaderArgs" => media.external_downloader_args.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "throttledRateKbs" => media.throttled_rate_kbs.is_some_and(|v| v > 0),
        "bufferSizeKbs" => media.buffer_size_kbs.is_some_and(|v| v > 0),
        "httpChunkSize" => media.http_chunk_size.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "downloadArchive" => media.download_archive.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "breakOnExisting" => media.break_on_existing == Some(true),
        "forceOverwrites" => media.force_overwrites.is_some(),
        "noOverwrites" => media.no_overwrites == Some(true),
        "restrictFilenames" => media.restrict_filenames.is_some(),
        "windowsFilenames" => media.windows_filenames.is_some(),
        "trimFilenames" => media.trim_filenames.is_some_and(|v| v > 0),
        "writeComments" => media.write_comments == Some(true),
        "embedMetadata" => media.embed_metadata.is_some(),
        "embedChapters" => media.embed_chapters.is_some(),
        "convertThumbnails" => media.convert_thumbnails.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "postprocessorArgs" => media.postprocessor_args.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "extractorArgs" => media.extractor_args.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "compatOptions" => media.compat_options.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "liveFromStart" => media.live_from_start == Some(true),
        "waitForVideo" => media.wait_for_video.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "socketTimeoutSec" => media.socket_timeout_sec.is_some_and(|v| v > 0),
        "minFilesize" => media.min_filesize.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "maxFilesize" => media.max_filesize.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "maxDownloads" => media.max_downloads.is_some_and(|v| v > 0),
        "username" => media.username.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "password" => media.password.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "twoFactor" => media.two_factor.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "netrc" => media.netrc == Some(true),
        "geoBypassCountry" => media.geo_bypass_country.as_deref().is_some_and(|v| !v.trim().is_empty()),
        "extraArgs" => media.extra_args.as_deref().is_some_and(|v| !v.trim().is_empty()),
        _ => false,
    }
}

pub fn validate_ytdlp_media_options(
    ytdlp_bin: &str,
    ffmpeg_bin: &str,
    curl_bin: &str,
    media: &MediaDownloadOptions,
) -> Result<(), String> {
    let (available, _, flags) = ytdlp_model(ytdlp_bin);
    if !available {
        return Err("yt-dlp is not available. The media extraction engine cannot start.".to_string());
    }
    let ffmpeg_ok = media
        .ffmpeg_location
        .as_deref()
        .is_some_and(|path| Path::new(path).exists())
        || ffmpeg_available(ffmpeg_bin);
    let curl_ok = executable_available(curl_bin) || hidden_output(curl_bin, &["--version"]).is_some();
    let mut unsupported = Vec::new();
    for key in YTDLP_MEDIA_OPTION_KEYS {
        if media_option_requested(media, key) && !ytdlp_key_supported(key, available, &flags, ffmpeg_ok) {
            unsupported.push((*key).to_string());
        }
    }
    if let Some(mode) = media.mode.as_deref().map(str::trim) {
        if mode.eq_ignore_ascii_case("audio") && !ffmpeg_ok {
            unsupported.push("mode=audio requires ffmpeg".to_string());
        }
    }
    if let Some(downloader) = media.external_downloader.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        match downloader {
            "auto" | "native" => {}
            "curl" if curl_ok => {}
            "curl" => unsupported.push("externalDownloader=curl requires an available curl binary".to_string()),
            "ffmpeg" if ffmpeg_ok => {}
            "ffmpeg" => unsupported.push("externalDownloader=ffmpeg requires an available ffmpeg binary".to_string()),
            "aria2" | "aria2c" => unsupported.push("aria2/aria2c is intentionally blocked because the legacy engine was removed".to_string()),
            "httpie" => {
                if !(flags.contains("--downloader") || flags.contains("--external-downloader")) {
                    unsupported.push("externalDownloader=httpie is not supported by this yt-dlp build".to_string());
                } else if !(executable_available("http") || executable_available("httpie")) {
                    unsupported.push("externalDownloader=httpie requires the httpie executable".to_string());
                }
            }
            "wget" => {
                if !(flags.contains("--downloader") || flags.contains("--external-downloader")) {
                    unsupported.push("externalDownloader=wget is not supported by this yt-dlp build".to_string());
                } else if !executable_available("wget") {
                    unsupported.push("externalDownloader=wget requires the wget executable".to_string());
                }
            }
            "axel" => {
                if !(flags.contains("--downloader") || flags.contains("--external-downloader")) {
                    unsupported.push("externalDownloader=axel is not supported by this yt-dlp build".to_string());
                } else if !executable_available("axel") {
                    unsupported.push("externalDownloader=axel requires the axel executable".to_string());
                }
            }
            other => unsupported.push(format!("externalDownloader={} is not allowed", other)),
        }
    }
    if !unsupported.is_empty() {
        unsupported.sort();
        unsupported.dedup();
        return Err(format!(
            "Unsupported media option(s) for this installed yt-dlp/ffmpeg/curl combination: {}",
            unsupported.join(", ")
        ));
    }
    Ok(())
}

pub fn all_engine_status(curl_bin: &str, ytdlp_bin: &str, ffmpeg_bin: &str) -> Value {
    let curl = curl_status(curl_bin);
    let external_curl_available = curl.get("externalCurlBinary").and_then(Value::as_bool).unwrap_or(false);
    let ffmpeg = ffmpeg_status(ffmpeg_bin);
    let ffmpeg_available = ffmpeg.get("available").and_then(Value::as_bool).unwrap_or(false);
    let ytdlp = ytdlp_status_with_context(ytdlp_bin, external_curl_available, ffmpeg_available);
    let ytdlp_available = ytdlp.get("available").and_then(Value::as_bool).unwrap_or(false);
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
        "status": if direct_ready { "connected" } else { "degraded" },
        "allReady": direct_ready && ytdlp_available && post_processing_ready,
        "directReady": direct_ready,
        "mediaReady": ytdlp_available,
        "postProcessingReady": post_processing_ready,
        "directProtocols": direct_protocols,
        "compatibilityMode": "runtime-verified-capabilities",
        "routing": {
            "directHttpHttpsFtp": if direct_ready { json!("libcurl-multi") } else { Value::Null },
            "webMediaAndPlaylists": if ytdlp_available { json!("yt-dlp") } else { Value::Null },
            "mergeRemuxExtractSubtitles": if post_processing_ready { json!("ffmpeg via yt-dlp") } else { Value::Null },
            "torrentMagnet": Value::Null
        },
        "engines": {
            "curl": curl.clone(),
            "libcurlMulti": curl,
            "ytdlp": ytdlp,
            "ffmpeg": ffmpeg
        }
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_libcurl_version;

    #[test]
    fn normalizes_libcurl_build_suffixes() {
        assert_eq!(normalize_libcurl_version("8.21.0"), "8.21.0");
        assert_eq!(normalize_libcurl_version("8.21.0-DEV"), "8.21.0");
        assert_eq!(normalize_libcurl_version("8.21.0+local"), "8.21.0");
    }
}
