#![allow(dead_code)]
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::daemon::direct::{ConnectionLimits, EventLoopMode, RetryPolicy};

fn opt_str(map: &HashMap<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn opt_bool(map: &HashMap<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(|v| v.as_bool())
}

fn opt_u64(map: &HashMap<String, Value>, key: &str) -> Option<u64> {
    map.get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n.max(0.0) as u64)))
}

fn opt_f64(map: &HashMap<String, Value>, key: &str) -> Option<f64> {
    map.get(key).and_then(|v| v.as_f64())
}

fn opt_str_vec(map: &HashMap<String, Value>, key: &str) -> Vec<String> {
    map.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CurlTransferConfig {
    pub proxy: Option<String>,
    pub pre_proxy: Option<String>,
    pub noproxy: Option<String>,
    pub source_address: Option<String>,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub headers: Option<String>,
    pub cookies: Option<String>,
    pub cookie_jar: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub auth_type: Option<String>,
    pub oauth2_bearer: Option<String>,
    pub netrc: Option<String>,
    pub netrc_file: Option<String>,
    pub netrc_optional: bool,
    pub unrestricted_auth: bool,
    pub speed_limit_kbs: Option<u64>,
    pub speed_limit_bytes: Option<u64>,
    pub rate: Option<String>,
    pub low_speed_limit_bytes: Option<u64>,
    pub speed_time_sec: Option<u64>,
    pub timeout_sec: Option<u64>,
    pub connect_timeout_sec: Option<u64>,
    pub max_redirs: Option<u64>,
    pub max_filesize: Option<u64>,
    pub buffer_size: Option<u64>,
    pub range: Option<String>,
    pub remote_time: bool,
    pub allow_overwrite: bool,
    pub location: bool,
    pub fail_with_body: bool,
    pub http_version: Option<String>,
    pub request_method: Option<String>,
    pub data: Option<String>,
    pub form: Vec<String>,
    pub compressed: bool,
    pub transfer_encoding: bool,
    pub http_09_allowed: bool,
    pub expect_100_timeout_ms: Option<u64>,
    pub insecure: bool,
    pub ca_cert: Option<String>,
    pub ca_path: Option<String>,
    pub cert: Option<String>,
    pub cert_type: Option<String>,
    pub key: Option<String>,
    pub key_type: Option<String>,
    pub pass: Option<String>,
    pub pinned_pub_key: Option<String>,
    pub ciphers: Option<String>,
    pub tls13_ciphers: Option<String>,
    pub tls_min: Option<String>,
    pub tls_max: Option<String>,
    pub ssl_reqd: bool,
    pub ssl_options: Option<String>,
    pub ssl_session_id_cache: Option<bool>,
    pub crl_file: Option<String>,
    pub issuer_cert: Option<String>,
    pub proxy_user: Option<String>,
    pub proxy_password: Option<String>,
    pub proxy_any_auth: Option<String>,
    pub proxy_type: Option<String>,
    pub proxy_tunnel: bool,
    pub proxy_ca_info: Option<String>,
    pub proxy_ca_path: Option<String>,
    pub proxy_cert: Option<String>,
    pub proxy_cert_type: Option<String>,
    pub proxy_key: Option<String>,
    pub proxy_key_type: Option<String>,
    pub proxy_key_password: Option<String>,
    pub proxy_ciphers: Option<String>,
    pub proxy_tls_max: Option<String>,
    pub proxy_tls_min: Option<String>,
    pub proxy_verify_peer: Option<bool>,
    pub proxy_verify_host: Option<bool>,
    pub ip_resolve: Option<String>,
    pub doh_url: Option<String>,
    pub doh_ssl_verify_peer: Option<bool>,
    pub doh_ssl_verify_host: Option<bool>,
    pub dns_servers: Option<String>,
    pub dns_interface: Option<String>,
    pub dns_cache_timeout_sec: Option<u64>,
    pub proto: Option<String>,
    pub proto_redir: Option<String>,
    pub resolve: Vec<String>,
    pub connect_to: Vec<String>,
    pub local_port_range: Option<String>,
    pub tcp_no_delay: bool,
    pub keepalive_time_sec: Option<u64>,
    pub path_as_is: bool,
    pub globoff: bool,
    pub ftp_create_dirs: bool,
    pub fresh_connect: bool,
    pub forbid_reuse: bool,
    pub max_age_conn: Option<u64>,
    pub max_connects: Option<u64>,
    pub time_cond: Option<String>,
    pub time_value: Option<u64>,
    pub etag_save: Option<String>,
    pub etag_compare: Option<String>,
    pub skip_existing: bool,
    pub remove_on_error: bool,
    pub raw_options: Option<String>,

    pub segmented: bool,
    pub force_single_connection: bool,
    pub max_total_connections: Option<u64>,
    pub max_host_connections: Option<u64>,
    pub max_connection_cache: Option<u64>,
    pub event_loop: Option<String>,
    pub retry_count: Option<u64>,
    pub retry_delay_sec: Option<u64>,
    pub retry_max_time_sec: Option<u64>,
    pub retry_all_errors: Option<bool>,
    pub retry_conn_refused: bool,
    pub retry_max_delay_sec: Option<u64>,
    pub retry_jitter: Option<bool>,
    pub backoff_multiplier: Option<f64>,

    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub digest_sha256: Option<String>,
    pub link_mirrors: Vec<String>,
    pub mirror_priorities: Vec<u32>,
    pub rie_strategy: Option<String>,
    pub rie_connections: Option<u32>,
}

impl CurlTransferConfig {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn str_(&self, key: &str) -> Option<&str> {
        match key {
            "proxy" => self.proxy.as_deref(),
            "preProxy" => self.pre_proxy.as_deref(),
            "noproxy" => self.noproxy.as_deref(),
            "sourceAddress" => self.source_address.as_deref(),
            "interface" => self.source_address.as_deref(),
            "userAgent" => self.user_agent.as_deref(),
            "referer" => self.referer.as_deref(),
            "headers" => self.headers.as_deref(),
            "cookies" => self.cookies.as_deref(),
            "cookieJar" => self.cookie_jar.as_deref(),
            "username" => self.username.as_deref(),
            "password" => self.password.as_deref(),
            "authType" => self.auth_type.as_deref(),
            "oauth2Bearer" => self.oauth2_bearer.as_deref(),
            "netrc" => self.netrc.as_deref(),
            "netrcFile" => self.netrc_file.as_deref(),
            "httpVersion" => self.http_version.as_deref(),
            "requestMethod" => self.request_method.as_deref(),
            "data" => self.data.as_deref(),
            "range" => self.range.as_deref(),
            "rate" => self.rate.as_deref(),
            "caCert" => self.ca_cert.as_deref(),
            "caPath" => self.ca_path.as_deref(),
            "cert" => self.cert.as_deref(),
            "certType" => self.cert_type.as_deref(),
            "key" => self.key.as_deref(),
            "keyType" => self.key_type.as_deref(),
            "pass" => self.pass.as_deref(),
            "pinnedPubKey" => self.pinned_pub_key.as_deref(),
            "ciphers" => self.ciphers.as_deref(),
            "tls13Ciphers" => self.tls13_ciphers.as_deref(),
            "tlsMin" => self.tls_min.as_deref(),
            "tlsMax" => self.tls_max.as_deref(),
            "sslOptions" => self.ssl_options.as_deref(),
            "crlFile" => self.crl_file.as_deref(),
            "issuerCert" => self.issuer_cert.as_deref(),
            "proxyUser" => self.proxy_user.as_deref(),
            "proxyPassword" => self.proxy_password.as_deref(),
            "proxyAnyAuth" => self.proxy_any_auth.as_deref(),
            "proxyType" => self.proxy_type.as_deref(),
            "proxyCaInfo" => self.proxy_ca_info.as_deref(),
            "proxyCaPath" => self.proxy_ca_path.as_deref(),
            "proxyCert" => self.proxy_cert.as_deref(),
            "proxyCertType" => self.proxy_cert_type.as_deref(),
            "proxyKey" => self.proxy_key.as_deref(),
            "proxyKeyType" => self.proxy_key_type.as_deref(),
            "proxyKeyPassword" => self.proxy_key_password.as_deref(),
            "proxyCiphers" => self.proxy_ciphers.as_deref(),
            "proxyTlsMax" => self.proxy_tls_max.as_deref(),
            "proxyTlsMin" => self.proxy_tls_min.as_deref(),
            "ipResolve" => self.ip_resolve.as_deref(),
            "dohUrl" => self.doh_url.as_deref(),
            "dnsServers" => self.dns_servers.as_deref(),
            "dnsInterface" => self.dns_interface.as_deref(),
            "localPortRange" => self.local_port_range.as_deref(),
            "proto" => self.proto.as_deref(),
            "protoRedir" => self.proto_redir.as_deref(),
            "timeCond" => self.time_cond.as_deref(),
            "etagSave" => self.etag_save.as_deref(),
            "etagCompare" => self.etag_compare.as_deref(),
            "rawOptions" => self.raw_options.as_deref(),
            "eventLoop" => self.event_loop.as_deref(),
            "etag" => self.etag.as_deref(),
            "lastModified" => self.last_modified.as_deref(),
            "digestSha256" => self.digest_sha256.as_deref(),
            _ => None,
        }
    }

    pub fn bool_(&self, key: &str) -> Option<bool> {
        match key {
            "netrcOptional" => Some(self.netrc_optional),
            "unrestrictedAuth" => Some(self.unrestricted_auth),
            "remoteTime" => Some(self.remote_time),
            "allowOverwrite" => Some(self.allow_overwrite),
            "location" => Some(self.location),
            "failWithBody" => Some(self.fail_with_body),
            "compressed" => Some(self.compressed),
            "transferEncoding" => Some(self.transfer_encoding),
            "http09Allowed" => Some(self.http_09_allowed),
            "insecure" => Some(self.insecure),
            "sslReqd" => Some(self.ssl_reqd),
            "proxyTunnel" => Some(self.proxy_tunnel),
            "tcpNoDelay" => Some(self.tcp_no_delay),
            "pathAsIs" => Some(self.path_as_is),
            "globoff" => Some(self.globoff),
            "ftpCreateDirs" => Some(self.ftp_create_dirs),
            "freshConnect" => Some(self.fresh_connect),
            "forbidReuse" => Some(self.forbid_reuse),
            "skipExisting" => Some(self.skip_existing),
            "removeOnError" => Some(self.remove_on_error),
            "retryConnRefused" => Some(self.retry_conn_refused),
            "segmented" => Some(self.segmented),
            "forceSingleConnection" => Some(self.force_single_connection),
            "sslSessionIdCache" => self.ssl_session_id_cache,
            "proxyVerifyPeer" => self.proxy_verify_peer,
            "proxyVerifyHost" => self.proxy_verify_host,
            "dohSslVerifyPeer" => self.doh_ssl_verify_peer,
            "dohSslVerifyHost" => self.doh_ssl_verify_host,
            _ => None,
        }
    }

    pub fn u64_(&self, key: &str) -> Option<u64> {
        match key {
            "speedLimitKbs" => self.speed_limit_kbs,
            "speedLimitBytes" => self.speed_limit_bytes,
            "lowSpeedLimitBytes" => self.low_speed_limit_bytes,
            "speedTimeSec" => self.speed_time_sec,
            "timeoutSec" => self.timeout_sec,
            "connectTimeoutSec" => self.connect_timeout_sec,
            "maxRedirs" => self.max_redirs,
            "maxFilesize" => self.max_filesize,
            "bufferSize" => self.buffer_size,
            "expect100TimeoutMs" => self.expect_100_timeout_ms,
            "dnsCacheTimeoutSec" => self.dns_cache_timeout_sec,
            "keepaliveTimeSec" => self.keepalive_time_sec,
            "maxAgeConn" => self.max_age_conn,
            "maxConnects" => self.max_connects,
            "timeValue" => self.time_value,
            "maxTotalConnections" => self.max_total_connections,
            "maxHostConnections" => self.max_host_connections,
            "maxConnectionCache" => self.max_connection_cache,
            "retryCount" => self.retry_count,
            "retryDelaySec" => self.retry_delay_sec,
            "retryMaxTimeSec" => self.retry_max_time_sec,
            "retryMaxDelaySec" => self.retry_max_delay_sec,
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn f64_(&self, key: &str) -> Option<f64> {
        match key {
            "backoffMultiplier" => self.backoff_multiplier,
            _ => None,
        }
    }

    pub fn array_(&self, key: &str) -> Vec<String> {
        match key {
            "form" => self.form.clone(),
            "resolve" => self.resolve.clone(),
            "connectTo" => self.connect_to.clone(),
            "linkMirrors" => self.link_mirrors.clone(),
            _ => Vec::new(),
        }
    }

    pub fn array_u32_(&self, key: &str) -> Option<Vec<u32>> {
        match key {
            "mirrorPriorities" => {
                if self.mirror_priorities.is_empty() {
                    None
                } else {
                    Some(self.mirror_priorities.clone())
                }
            }
            _ => None,
        }
    }

    pub fn event_loop_mode(&self) -> EventLoopMode {
        match self
            .event_loop
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "wait_perform" | "waitperform" | "wait" | "perform" => EventLoopMode::WaitPerform,
            _ => EventLoopMode::MultiSocket,
        }
    }

    pub fn retry_policy(&self) -> RetryPolicy {
        RetryPolicy {
            attempts: self.retry_count.unwrap_or(0).saturating_add(1).min(50),
            delay: std::time::Duration::from_secs(self.retry_delay_sec.unwrap_or(2).min(3600)),
            max_total_time: self
                .retry_max_time_sec
                .filter(|v| *v > 0)
                .map(std::time::Duration::from_secs),
            retry_all_errors: self.retry_all_errors.unwrap_or(true),
            backoff_multiplier: self.backoff_multiplier.unwrap_or(2.0).clamp(1.0, 10.0),
            max_delay: std::time::Duration::from_secs(
                self.retry_max_delay_sec.unwrap_or(120).min(3600),
            ),
            jitter: self.retry_jitter.unwrap_or(true),
        }
    }

    pub fn connection_limits(&self, requested: u32, max_connections: u32) -> ConnectionLimits {
        let requested = requested.max(1).min(max_connections) as usize;
        let max_connections = max_connections.max(1) as usize;
        let total = self
            .max_total_connections
            .map(|v| v as usize)
            .unwrap_or(requested)
            .clamp(1, max_connections);
        let per_host = self
            .max_host_connections
            .map(|v| v as usize)
            .unwrap_or(requested)
            .clamp(1, total);
        let cache = self
            .max_connection_cache
            .or(self.max_connects)
            .map(|v| v as usize)
            .unwrap_or_else(|| total.saturating_mul(2).max(total))
            .clamp(1, max_connections.saturating_mul(4).max(1));
        ConnectionLimits {
            total,
            per_host,
            cache,
        }
    }

    pub fn connection_limits_for_url(
        &self,
        requested: u32,
        max_connections: u32,
        url: &str,
    ) -> ConnectionLimits {
        let mut limits = self.connection_limits(requested, max_connections);
        if self.max_host_connections.is_none() {
            if let Some(learned) = crate::daemon::direct::learned_host_ceiling(url) {
                limits.per_host = learned.min(limits.total).max(1);
            }
        }
        limits
    }

    pub fn bandwidth_aware_connections(
        requested: u32,
        max_connections: u32,
        bandwidth_kbps: u64,
    ) -> u32 {
        if bandwidth_kbps == 0 {
            return requested;
        }
        let max_useful = (bandwidth_kbps / 50).max(1) as u32;
        requested.min(max_useful).max(1).min(max_connections)
    }

    #[allow(dead_code)]
    pub fn to_hashmap(&self) -> HashMap<String, Value> {
        let mut map = HashMap::new();
        macro_rules! insert_str {
            ($key:expr, $val:expr) => {
                if let Some(v) = $val {
                    map.insert($key.to_string(), Value::String(v.to_string()));
                }
            };
        }
        macro_rules! insert_bool {
            ($key:expr, $val:expr) => {
                if $val {
                    map.insert($key.to_string(), Value::Bool(true));
                }
            };
        }
        macro_rules! insert_opt_bool {
            ($key:expr, $val:expr) => {
                if let Some(v) = $val {
                    map.insert($key.to_string(), Value::Bool(v));
                }
            };
        }
        macro_rules! insert_u64 {
            ($key:expr, $val:expr) => {
                if let Some(v) = $val {
                    map.insert($key.to_string(), Value::Number(v.into()));
                }
            };
        }
        macro_rules! insert_f64 {
            ($key:expr, $val:expr) => {
                if let Some(v) = $val {
                    if let Some(n) = serde_json::Number::from_f64(v) {
                        map.insert($key.to_string(), Value::Number(n));
                    }
                }
            };
        }
        macro_rules! insert_array {
            ($key:expr, $val:expr) => {
                if !$val.is_empty() {
                    map.insert(
                        $key.to_string(),
                        Value::Array($val.iter().map(|s| Value::String(s.clone())).collect()),
                    );
                }
            };
        }
        insert_str!("proxy", self.proxy.as_ref());
        insert_str!("preProxy", self.pre_proxy.as_ref());
        insert_str!("noproxy", self.noproxy.as_ref());
        insert_str!("sourceAddress", self.source_address.as_ref());
        insert_str!("userAgent", self.user_agent.as_ref());
        insert_str!("referer", self.referer.as_ref());
        insert_str!("headers", self.headers.as_ref());
        insert_str!("cookies", self.cookies.as_ref());
        insert_str!("cookieJar", self.cookie_jar.as_ref());
        insert_str!("username", self.username.as_ref());
        insert_str!("password", self.password.as_ref());
        insert_str!("authType", self.auth_type.as_ref());
        insert_str!("oauth2Bearer", self.oauth2_bearer.as_ref());
        insert_str!("netrc", self.netrc.as_ref());
        insert_str!("netrcFile", self.netrc_file.as_ref());
        insert_bool!("netrcOptional", self.netrc_optional);
        insert_bool!("unrestrictedAuth", self.unrestricted_auth);
        insert_u64!("speedLimitKbs", self.speed_limit_kbs);
        insert_u64!("speedLimitBytes", self.speed_limit_bytes);
        insert_str!("rate", self.rate.as_ref());
        insert_u64!("lowSpeedLimitBytes", self.low_speed_limit_bytes);
        insert_u64!("speedTimeSec", self.speed_time_sec);
        insert_u64!("timeoutSec", self.timeout_sec);
        insert_u64!("connectTimeoutSec", self.connect_timeout_sec);
        insert_u64!("maxRedirs", self.max_redirs);
        insert_u64!("maxFilesize", self.max_filesize);
        insert_u64!("bufferSize", self.buffer_size);
        insert_str!("range", self.range.as_ref());
        insert_bool!("remoteTime", self.remote_time);
        insert_bool!("allowOverwrite", self.allow_overwrite);
        insert_bool!("location", self.location);
        insert_bool!("failWithBody", self.fail_with_body);
        insert_str!("httpVersion", self.http_version.as_ref());
        insert_str!("requestMethod", self.request_method.as_ref());
        insert_str!("data", self.data.as_ref());
        insert_array!("form", self.form);
        insert_bool!("compressed", self.compressed);
        insert_bool!("transferEncoding", self.transfer_encoding);
        insert_bool!("http09Allowed", self.http_09_allowed);
        insert_u64!("expect100TimeoutMs", self.expect_100_timeout_ms);
        insert_bool!("insecure", self.insecure);
        insert_str!("caCert", self.ca_cert.as_ref());
        insert_str!("caPath", self.ca_path.as_ref());
        insert_str!("cert", self.cert.as_ref());
        insert_str!("certType", self.cert_type.as_ref());
        insert_str!("key", self.key.as_ref());
        insert_str!("keyType", self.key_type.as_ref());
        insert_str!("pass", self.pass.as_ref());
        insert_str!("pinnedPubKey", self.pinned_pub_key.as_ref());
        insert_str!("ciphers", self.ciphers.as_ref());
        insert_str!("tls13Ciphers", self.tls13_ciphers.as_ref());
        insert_str!("tlsMin", self.tls_min.as_ref());
        insert_str!("tlsMax", self.tls_max.as_ref());
        insert_bool!("sslReqd", self.ssl_reqd);
        insert_str!("sslOptions", self.ssl_options.as_ref());
        insert_opt_bool!("sslSessionIdCache", self.ssl_session_id_cache);
        insert_str!("crlFile", self.crl_file.as_ref());
        insert_str!("issuerCert", self.issuer_cert.as_ref());
        insert_str!("proxyUser", self.proxy_user.as_ref());
        insert_str!("proxyPassword", self.proxy_password.as_ref());
        insert_str!("proxyAnyAuth", self.proxy_any_auth.as_ref());
        insert_str!("proxyType", self.proxy_type.as_ref());
        insert_bool!("proxyTunnel", self.proxy_tunnel);
        insert_str!("proxyCaInfo", self.proxy_ca_info.as_ref());
        insert_str!("proxyCaPath", self.proxy_ca_path.as_ref());
        insert_str!("proxyCert", self.proxy_cert.as_ref());
        insert_str!("proxyCertType", self.proxy_cert_type.as_ref());
        insert_str!("proxyKey", self.proxy_key.as_ref());
        insert_str!("proxyKeyType", self.proxy_key_type.as_ref());
        insert_str!("proxyKeyPassword", self.proxy_key_password.as_ref());
        insert_str!("proxyCiphers", self.proxy_ciphers.as_ref());
        insert_str!("proxyTlsMax", self.proxy_tls_max.as_ref());
        insert_str!("proxyTlsMin", self.proxy_tls_min.as_ref());
        insert_opt_bool!("proxyVerifyPeer", self.proxy_verify_peer);
        insert_opt_bool!("proxyVerifyHost", self.proxy_verify_host);
        insert_str!("ipResolve", self.ip_resolve.as_ref());
        insert_str!("dohUrl", self.doh_url.as_ref());
        insert_opt_bool!("dohSslVerifyPeer", self.doh_ssl_verify_peer);
        insert_opt_bool!("dohSslVerifyHost", self.doh_ssl_verify_host);
        insert_str!("dnsServers", self.dns_servers.as_ref());
        insert_str!("dnsInterface", self.dns_interface.as_ref());
        insert_u64!("dnsCacheTimeoutSec", self.dns_cache_timeout_sec);
        insert_str!("proto", self.proto.as_ref());
        insert_str!("protoRedir", self.proto_redir.as_ref());
        insert_array!("resolve", self.resolve);
        insert_array!("connectTo", self.connect_to);
        insert_str!("localPortRange", self.local_port_range.as_ref());
        insert_bool!("tcpNoDelay", self.tcp_no_delay);
        insert_u64!("keepaliveTimeSec", self.keepalive_time_sec);
        insert_bool!("pathAsIs", self.path_as_is);
        insert_bool!("globoff", self.globoff);
        insert_bool!("ftpCreateDirs", self.ftp_create_dirs);
        insert_bool!("freshConnect", self.fresh_connect);
        insert_bool!("forbidReuse", self.forbid_reuse);
        insert_u64!("maxAgeConn", self.max_age_conn);
        insert_u64!("maxConnects", self.max_connects);
        insert_str!("timeCond", self.time_cond.as_ref());
        insert_u64!("timeValue", self.time_value);
        insert_str!("etagSave", self.etag_save.as_ref());
        insert_str!("etagCompare", self.etag_compare.as_ref());
        insert_bool!("skipExisting", self.skip_existing);
        insert_bool!("removeOnError", self.remove_on_error);
        insert_str!("rawOptions", self.raw_options.as_ref());
        insert_bool!("segmented", self.segmented);
        insert_bool!("forceSingleConnection", self.force_single_connection);
        insert_u64!("maxTotalConnections", self.max_total_connections);
        insert_u64!("maxHostConnections", self.max_host_connections);
        insert_u64!("maxConnectionCache", self.max_connection_cache);
        insert_str!("eventLoop", self.event_loop.as_ref());
        insert_u64!("retryCount", self.retry_count);
        insert_u64!("retryDelaySec", self.retry_delay_sec);
        insert_u64!("retryMaxTimeSec", self.retry_max_time_sec);
        insert_opt_bool!("retryAllErrors", self.retry_all_errors);
        insert_bool!("retryConnRefused", self.retry_conn_refused);
        insert_u64!("retryMaxDelaySec", self.retry_max_delay_sec);
        insert_opt_bool!("retryJitter", self.retry_jitter);
        insert_f64!("backoffMultiplier", self.backoff_multiplier);
        insert_str!("etag", self.etag.as_ref());
        insert_str!("lastModified", self.last_modified.as_ref());
        insert_str!("digestSha256", self.digest_sha256.as_ref());
        insert_array!("linkMirrors", self.link_mirrors);
        if !self.mirror_priorities.is_empty() {
            map.insert(
                "mirrorPriorities".to_string(),
                Value::Array(
                    self.mirror_priorities
                        .iter()
                        .map(|p| Value::Number((*p).into()))
                        .collect(),
                ),
            );
        }
        map
    }
}

impl From<&HashMap<String, Value>> for CurlTransferConfig {
    fn from(map: &HashMap<String, Value>) -> Self {
        Self {
            proxy: opt_str(map, "proxy"),
            pre_proxy: opt_str(map, "preProxy"),
            noproxy: opt_str(map, "noproxy"),
            source_address: opt_str(map, "sourceAddress").or_else(|| opt_str(map, "interface")),
            user_agent: opt_str(map, "userAgent"),
            referer: opt_str(map, "referer"),
            headers: opt_str(map, "headers"),
            cookies: opt_str(map, "cookies"),
            cookie_jar: opt_str(map, "cookieJar"),
            username: opt_str(map, "username"),
            password: opt_str(map, "password"),
            auth_type: opt_str(map, "authType"),
            oauth2_bearer: opt_str(map, "oauth2Bearer"),
            netrc: opt_str(map, "netrc"),
            netrc_file: opt_str(map, "netrcFile"),
            netrc_optional: opt_bool(map, "netrcOptional").unwrap_or(false),
            unrestricted_auth: opt_bool(map, "unrestrictedAuth").unwrap_or(false),
            speed_limit_kbs: opt_u64(map, "speedLimitKbs"),
            speed_limit_bytes: opt_u64(map, "speedLimitBytes"),
            rate: opt_str(map, "rate"),
            low_speed_limit_bytes: opt_u64(map, "lowSpeedLimitBytes"),
            speed_time_sec: opt_u64(map, "speedTimeSec"),
            timeout_sec: opt_u64(map, "timeoutSec"),
            connect_timeout_sec: opt_u64(map, "connectTimeoutSec"),
            max_redirs: opt_u64(map, "maxRedirs"),
            max_filesize: opt_u64(map, "maxFilesize"),
            buffer_size: opt_u64(map, "bufferSize"),
            range: opt_str(map, "range"),
            remote_time: opt_bool(map, "remoteTime").unwrap_or(false),
            allow_overwrite: opt_bool(map, "allowOverwrite").unwrap_or(false),
            location: opt_bool(map, "location").unwrap_or(true),
            fail_with_body: opt_bool(map, "failWithBody").unwrap_or(true),
            http_version: opt_str(map, "httpVersion"),
            request_method: opt_str(map, "requestMethod"),
            data: opt_str(map, "data"),
            form: opt_str_vec(map, "form"),
            compressed: opt_bool(map, "compressed").unwrap_or(true),
            transfer_encoding: opt_bool(map, "transferEncoding").unwrap_or(false),
            http_09_allowed: opt_bool(map, "http09Allowed").unwrap_or(false),
            expect_100_timeout_ms: opt_u64(map, "expect100TimeoutMs"),
            insecure: opt_bool(map, "insecure").unwrap_or(false),
            ca_cert: opt_str(map, "caCert"),
            ca_path: opt_str(map, "caPath"),
            cert: opt_str(map, "cert"),
            cert_type: opt_str(map, "certType"),
            key: opt_str(map, "key"),
            key_type: opt_str(map, "keyType"),
            pass: opt_str(map, "pass"),
            pinned_pub_key: opt_str(map, "pinnedPubKey"),
            ciphers: opt_str(map, "ciphers"),
            tls13_ciphers: opt_str(map, "tls13Ciphers"),
            tls_min: opt_str(map, "tlsMin"),
            tls_max: opt_str(map, "tlsMax"),
            ssl_reqd: opt_bool(map, "sslReqd").unwrap_or(false),
            ssl_options: opt_str(map, "sslOptions"),
            ssl_session_id_cache: opt_bool(map, "sslSessionIdCache"),
            crl_file: opt_str(map, "crlFile"),
            issuer_cert: opt_str(map, "issuerCert"),
            proxy_user: opt_str(map, "proxyUser"),
            proxy_password: opt_str(map, "proxyPassword"),
            proxy_any_auth: opt_str(map, "proxyAnyAuth"),
            proxy_type: opt_str(map, "proxyType"),
            proxy_tunnel: opt_bool(map, "proxyTunnel").unwrap_or(false),
            proxy_ca_info: opt_str(map, "proxyCaInfo"),
            proxy_ca_path: opt_str(map, "proxyCaPath"),
            proxy_cert: opt_str(map, "proxyCert"),
            proxy_cert_type: opt_str(map, "proxyCertType"),
            proxy_key: opt_str(map, "proxyKey"),
            proxy_key_type: opt_str(map, "proxyKeyType"),
            proxy_key_password: opt_str(map, "proxyKeyPassword"),
            proxy_ciphers: opt_str(map, "proxyCiphers"),
            proxy_tls_max: opt_str(map, "proxyTlsMax"),
            proxy_tls_min: opt_str(map, "proxyTlsMin"),
            proxy_verify_peer: opt_bool(map, "proxyVerifyPeer"),
            proxy_verify_host: opt_bool(map, "proxyVerifyHost"),
            ip_resolve: opt_str(map, "ipResolve"),
            doh_url: opt_str(map, "dohUrl"),
            doh_ssl_verify_peer: opt_bool(map, "dohSslVerifyPeer"),
            doh_ssl_verify_host: opt_bool(map, "dohSslVerifyHost"),
            dns_servers: opt_str(map, "dnsServers"),
            dns_interface: opt_str(map, "dnsInterface"),
            dns_cache_timeout_sec: opt_u64(map, "dnsCacheTimeoutSec"),
            proto: opt_str(map, "proto"),
            proto_redir: opt_str(map, "protoRedir"),
            resolve: opt_str_vec(map, "resolve"),
            connect_to: opt_str_vec(map, "connectTo"),
            local_port_range: opt_str(map, "localPortRange"),
            tcp_no_delay: opt_bool(map, "tcpNoDelay").unwrap_or(false),
            keepalive_time_sec: opt_u64(map, "keepaliveTimeSec"),
            path_as_is: opt_bool(map, "pathAsIs").unwrap_or(false),
            globoff: opt_bool(map, "globoff").unwrap_or(false),
            ftp_create_dirs: opt_bool(map, "ftpCreateDirs").unwrap_or(false),
            fresh_connect: opt_bool(map, "freshConnect").unwrap_or(false),
            forbid_reuse: opt_bool(map, "forbidReuse").unwrap_or(false),
            max_age_conn: opt_u64(map, "maxAgeConn"),
            max_connects: opt_u64(map, "maxConnects"),
            time_cond: opt_str(map, "timeCond"),
            time_value: opt_u64(map, "timeValue"),
            etag_save: opt_str(map, "etagSave"),
            etag_compare: opt_str(map, "etagCompare"),
            skip_existing: opt_bool(map, "skipExisting").unwrap_or(false),
            remove_on_error: opt_bool(map, "removeOnError").unwrap_or(false),
            raw_options: opt_str(map, "rawOptions"),
            segmented: opt_bool(map, "segmented").unwrap_or(true),
            force_single_connection: opt_bool(map, "forceSingleConnection").unwrap_or(false),
            max_total_connections: opt_u64(map, "maxTotalConnections"),
            max_host_connections: opt_u64(map, "maxHostConnections"),
            max_connection_cache: opt_u64(map, "maxConnectionCache"),
            event_loop: opt_str(map, "eventLoop"),
            retry_count: opt_u64(map, "retryCount"),
            retry_delay_sec: opt_u64(map, "retryDelaySec"),
            retry_max_time_sec: opt_u64(map, "retryMaxTimeSec"),
            retry_all_errors: opt_bool(map, "retryAllErrors"),
            retry_conn_refused: opt_bool(map, "retryConnRefused").unwrap_or(false),
            retry_max_delay_sec: opt_u64(map, "retryMaxDelaySec"),
            retry_jitter: opt_bool(map, "retryJitter"),
            backoff_multiplier: opt_f64(map, "backoffMultiplier"),
            etag: opt_str(map, "etag"),
            last_modified: opt_str(map, "lastModified"),
            digest_sha256: opt_str(map, "digestSha256"),
            link_mirrors: opt_str_vec(map, "linkMirrors"),
            mirror_priorities: {
                map.get("mirrorPriorities")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_u64().map(|p| p.max(1) as u32))
                            .collect()
                    })
                    .unwrap_or_default()
            },
            rie_strategy: opt_str(map, "rieStrategy"),
            rie_connections: map
                .get("rieConnections")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_default_is_empty() {
        let config = CurlTransferConfig::new();
        assert!(config.proxy.is_none());
        assert!(!config.insecure);
        assert!(!config.compressed);
        assert_eq!(config.form.len(), 0);
    }

    #[test]
    fn config_from_hashmap_roundtrip() {
        let mut map = HashMap::new();
        map.insert(
            "proxy".to_string(),
            Value::String("http://p:8080".to_string()),
        );
        map.insert("insecure".to_string(), Value::Bool(true));
        map.insert("timeoutSec".to_string(), Value::Number(30.into()));
        map.insert("compressed".to_string(), Value::Bool(true));

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.proxy.as_deref(), Some("http://p:8080"));
        assert!(config.insecure);
        assert_eq!(config.timeout_sec, Some(30));
        assert!(config.compressed);

        let back = config.to_hashmap();
        assert_eq!(
            back.get("proxy").and_then(|v| v.as_str()),
            Some("http://p:8080")
        );
        assert_eq!(back.get("insecure").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(back.get("timeoutSec").and_then(|v| v.as_u64()), Some(30));
    }

    #[test]
    fn config_accessor_str_matches_hashmap() {
        let mut map = HashMap::new();
        map.insert(
            "userAgent".to_string(),
            Value::String("Nova/1.0".to_string()),
        );
        map.insert("httpVersion".to_string(), Value::String("2".to_string()));

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.str_("userAgent"), Some("Nova/1.0"));
        assert_eq!(config.str_("httpVersion"), Some("2"));
        assert_eq!(config.str_("nonexistent"), None);
    }

    #[test]
    fn config_accessor_bool_matches_hashmap() {
        let mut map = HashMap::new();
        map.insert("tcpNoDelay".to_string(), Value::Bool(true));
        map.insert("insecure".to_string(), Value::Bool(false));

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.bool_("tcpNoDelay"), Some(true));
        assert_eq!(config.bool_("insecure"), Some(false));
    }

    #[test]
    fn config_accessor_u64_matches_hashmap() {
        let mut map = HashMap::new();
        map.insert("timeoutSec".to_string(), Value::Number(42.into()));
        map.insert("maxRedirs".to_string(), Value::Number(10.into()));

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.u64_("timeoutSec"), Some(42));
        assert_eq!(config.u64_("maxRedirs"), Some(10));
        assert_eq!(config.u64_("nonexistent"), None);
    }

    #[test]
    fn config_event_loop_mode() {
        let mut config = CurlTransferConfig::new();
        assert_eq!(config.event_loop_mode(), EventLoopMode::MultiSocket);
        config.event_loop = Some("waitPerform".to_string());
        assert_eq!(config.event_loop_mode(), EventLoopMode::WaitPerform);
    }

    #[test]
    fn config_retry_policy_defaults() {
        let config = CurlTransferConfig::new();
        let policy = config.retry_policy();
        assert_eq!(policy.attempts, 1);
        assert_eq!(policy.delay.as_secs(), 2);
        assert!(policy.retry_all_errors);
        assert_eq!(policy.backoff_multiplier, 2.0);
        assert_eq!(policy.max_delay.as_secs(), 120);
        assert!(policy.jitter);
    }

    #[test]
    fn config_retry_policy_custom() {
        let mut config = CurlTransferConfig::new();
        config.retry_count = Some(5);
        config.retry_delay_sec = Some(10);
        config.retry_all_errors = Some(false);
        config.backoff_multiplier = Some(3.0);
        config.retry_jitter = Some(false);

        let policy = config.retry_policy();
        assert_eq!(policy.attempts, 6);
        assert_eq!(policy.delay.as_secs(), 10);
        assert!(!policy.retry_all_errors);
        assert_eq!(policy.backoff_multiplier, 3.0);
        assert!(!policy.jitter);
    }

    #[test]
    fn config_array_accessor() {
        let mut map = HashMap::new();
        map.insert(
            "resolve".to_string(),
            Value::Array(vec![
                Value::String("example.com:443:1.2.3.4".to_string()),
                Value::String("cdn.example.com:443:5.6.7.8".to_string()),
            ]),
        );

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.array_("resolve").len(), 2);
        assert_eq!(config.array_("nonexistent").len(), 0);
    }

    #[test]
    fn config_optional_bool_field() {
        let mut config = CurlTransferConfig::new();
        assert_eq!(config.bool_("sslSessionIdCache"), None);
        config.ssl_session_id_cache = Some(false);
        assert_eq!(config.bool_("sslSessionIdCache"), Some(false));
    }

    #[test]
    fn config_empty_values_filtered() {
        let mut map = HashMap::new();
        map.insert("proxy".to_string(), Value::String("  ".to_string()));
        map.insert("userAgent".to_string(), Value::String("".to_string()));

        let config = CurlTransferConfig::from(&map);
        assert!(config.proxy.is_none());
        assert!(config.user_agent.is_none());
    }

    #[test]
    fn config_f64_backoff_multiplier() {
        let mut map = HashMap::new();
        map.insert("backoffMultiplier".to_string(), serde_json::json!(2.5));

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.f64_("backoffMultiplier"), Some(2.5));
        assert_eq!(config.backoff_multiplier, Some(2.5));
    }

    #[test]
    fn config_connection_limits_direct() {
        let mut map = HashMap::new();
        map.insert("maxTotalConnections".to_string(), serde_json::json!(16));
        map.insert("maxHostConnections".to_string(), serde_json::json!(4));
        map.insert("maxConnectionCache".to_string(), serde_json::json!(32));

        let config = CurlTransferConfig::from(&map);
        let limits = config.connection_limits(8, 32);
        assert_eq!(limits.total, 16);
        assert_eq!(limits.per_host, 4);
        assert_eq!(limits.cache, 32);
    }

    #[test]
    fn config_connection_limits_clamps_to_max() {
        let mut map = HashMap::new();
        map.insert("maxTotalConnections".to_string(), serde_json::json!(999));

        let config = CurlTransferConfig::from(&map);
        let limits = config.connection_limits(4, 16);
        assert_eq!(limits.total, 16);
    }

    #[test]
    fn config_connection_limits_defaults_from_requested() {
        let config = CurlTransferConfig::new();
        let limits = config.connection_limits(8, 32);
        assert_eq!(limits.total, 8);
        assert_eq!(limits.per_host, 8);
        assert_eq!(limits.cache, 16);
    }

    #[test]
    fn config_array_u32_accessor() {
        let mut map = HashMap::new();
        map.insert(
            "mirrorPriorities".to_string(),
            Value::Array(vec![
                Value::Number(3.into()),
                Value::Number(1.into()),
                Value::Number(2.into()),
            ]),
        );

        let config = CurlTransferConfig::from(&map);
        let priorities = config.array_u32_("mirrorPriorities");
        assert_eq!(priorities, Some(vec![3, 1, 2]));
        assert_eq!(config.array_u32_("nonexistent"), None);
    }

    #[test]
    fn config_array_u32_empty_returns_none() {
        let config = CurlTransferConfig::new();
        assert_eq!(config.array_u32_("mirrorPriorities"), None);
    }

    #[test]
    fn config_rie_fields_from_hashmap() {
        let mut map = HashMap::new();
        map.insert(
            "rieStrategy".to_string(),
            Value::String("AdaptiveSegmented".to_string()),
        );
        map.insert("rieConnections".to_string(), Value::Number(8.into()));

        let config = CurlTransferConfig::from(&map);
        assert_eq!(config.rie_strategy.as_deref(), Some("AdaptiveSegmented"));
        assert_eq!(config.rie_connections, Some(8));
    }

    #[test]
    fn config_rie_fields_absent_when_not_set() {
        let config = CurlTransferConfig::new();
        assert_eq!(config.rie_strategy, None);
        assert_eq!(config.rie_connections, None);
    }
}
