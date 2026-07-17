#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurlCapabilities {
    pub version: String,
    pub version_number: u32,
    pub host: String,
    pub vendored: bool,
    pub tls: TlsCapabilities,
    pub protocols: ProtocolCapabilities,
    pub features: FeatureCapabilities,
    pub compression: CompressionCapabilities,
    pub http: HttpCapabilities,
    pub dns: DnsCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsCapabilities {
    pub backend: TlsBackend,
    pub backend_string: String,
    pub available: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TlsBackend {
    OpenSSL,
    Schannel,
    SecureTransport,
    LibreSSL,
    BoringSSL,
    WolfSSL,
    MbedTLS,
    Rustls,
    GnuTLS,
    #[allow(clippy::upper_case_acronyms)]
    NSS,
    BearSSL,
    AmiSSL,
    Unknown,
}

impl TlsBackend {
    pub fn from_ssl_version_string(s: &str) -> Self {
        let lower = s.to_ascii_lowercase();
        if lower.contains("openssl") || lower.contains("boringssl") || lower.contains("aws-lc") {
            if lower.contains("boringssl") {
                TlsBackend::BoringSSL
            } else {
                TlsBackend::OpenSSL
            }
        } else if lower.contains("schannel") {
            TlsBackend::Schannel
        } else if lower.contains("secure transport") || lower.contains("darwinssl") {
            TlsBackend::SecureTransport
        } else if lower.contains("libressl") {
            TlsBackend::LibreSSL
        } else if lower.contains("wolfssl") {
            TlsBackend::WolfSSL
        } else if lower.contains("mbedtls") || lower.contains("polarssl") {
            TlsBackend::MbedTLS
        } else if lower.contains("rustls") {
            TlsBackend::Rustls
        } else if lower.contains("gnutls") {
            TlsBackend::GnuTLS
        } else if lower.contains("nss") {
            TlsBackend::NSS
        } else if lower.contains("bearssl") {
            TlsBackend::BearSSL
        } else if lower.contains("amissl") {
            TlsBackend::AmiSSL
        } else {
            TlsBackend::Unknown
        }
    }
}

impl std::fmt::Display for TlsBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TlsBackend::OpenSSL => write!(f, "OpenSSL"),
            TlsBackend::Schannel => write!(f, "Schannel"),
            TlsBackend::SecureTransport => write!(f, "SecureTransport"),
            TlsBackend::LibreSSL => write!(f, "LibreSSL"),
            TlsBackend::BoringSSL => write!(f, "BoringSSL"),
            TlsBackend::WolfSSL => write!(f, "WolfSSL"),
            TlsBackend::MbedTLS => write!(f, "MbedTLS"),
            TlsBackend::Rustls => write!(f, "Rustls"),
            TlsBackend::GnuTLS => write!(f, "GnuTLS"),
            TlsBackend::NSS => write!(f, "NSS"),
            TlsBackend::BearSSL => write!(f, "BearSSL"),
            TlsBackend::AmiSSL => write!(f, "AmiSSL"),
            TlsBackend::Unknown => write!(f, "Unknown"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolCapabilities {
    pub http: bool,
    pub https: bool,
    pub ftp: bool,
    pub ftps: bool,
    pub sftp: bool,
    pub scp: bool,
    pub smb: bool,
    pub smbs: bool,
    pub imap: bool,
    pub imaps: bool,
    pub pop3: bool,
    pub pop3s: bool,
    pub smtp: bool,
    pub smtps: bool,
    pub rtsp: bool,
    pub mqtt: bool,
    pub ws: bool,
    pub wss: bool,
    pub dict: bool,
    pub gopher: bool,
    pub ldap: bool,
    pub ldaps: bool,
    pub telnet: bool,
    pub tftp: bool,
    pub all: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureCapabilities {
    pub ipv4: bool,
    pub ipv6: bool,
    pub ssl: bool,
    pub libz: bool,
    pub brotli: bool,
    pub zstd: bool,
    pub http2: bool,
    pub http3: bool,
    pub ntlm: bool,
    pub gss_api: bool,
    pub spnego: bool,
    pub kerberos: bool,
    pub unix_sockets: bool,
    pub async_dns: bool,
    pub doh: bool,
    pub hsts: bool,
    pub alt_svc: bool,
    pub large_file: bool,
    pub debug: bool,
    pub unicode: bool,
    pub gsasl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressionCapabilities {
    pub gzip: bool,
    pub brotli: bool,
    pub zstd: bool,
    pub deflate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpCapabilities {
    pub http1_0: bool,
    pub http1_1: bool,
    pub http2: bool,
    pub http2_prior_knowledge: bool,
    pub http3: bool,
    pub http3_only: bool,
    pub supported_versions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsCapabilities {
    pub async_dns: bool,
    pub doh: bool,
    pub c_ares: Option<String>,
}

pub fn probe_capabilities() -> CurlCapabilities {
    let version = ::curl::Version::get();
    let ssl_version_str = version.ssl_version().unwrap_or("").to_string();
    let tls_backend = TlsBackend::from_ssl_version_string(&ssl_version_str);

    let protocols: Vec<String> = version.protocols().map(|p| p.to_string()).collect();
    let protocol_lower: std::collections::HashSet<String> =
        protocols.iter().map(|p| p.to_ascii_lowercase()).collect();

    CurlCapabilities {
        version: version.version().to_string(),
        version_number: version.version_num(),
        host: version.host().to_string(),
        vendored: version.vendored(),
        tls: TlsCapabilities {
            backend: tls_backend,
            backend_string: ssl_version_str,
            available: version.feature_ssl(),
        },
        protocols: ProtocolCapabilities {
            http: protocol_lower.contains("http"),
            https: protocol_lower.contains("https"),
            ftp: protocol_lower.contains("ftp"),
            ftps: protocol_lower.contains("ftps"),
            sftp: protocol_lower.contains("sftp"),
            scp: protocol_lower.contains("scp"),
            smb: protocol_lower.contains("smb"),
            smbs: protocol_lower.contains("smbs"),
            imap: protocol_lower.contains("imap"),
            imaps: protocol_lower.contains("imaps"),
            pop3: protocol_lower.contains("pop3"),
            pop3s: protocol_lower.contains("pop3s"),
            smtp: protocol_lower.contains("smtp"),
            smtps: protocol_lower.contains("smtps"),
            rtsp: protocol_lower.contains("rtsp"),
            mqtt: protocol_lower.contains("mqtt"),
            ws: protocol_lower.contains("ws"),
            wss: protocol_lower.contains("wss"),
            dict: protocol_lower.contains("dict"),
            gopher: protocol_lower.contains("gopher"),
            ldap: protocol_lower.contains("ldap"),
            ldaps: protocol_lower.contains("ldaps"),
            telnet: protocol_lower.contains("telnet"),
            tftp: protocol_lower.contains("tftp"),
            all: protocols,
        },
        features: FeatureCapabilities {
            ipv4: true,
            ipv6: version.feature_ipv6(),
            ssl: version.feature_ssl(),
            libz: version.feature_libz(),
            brotli: version.feature_brotli(),
            zstd: version.feature_zstd(),
            http2: version.feature_http2(),
            http3: version.feature_http3(),
            ntlm: version.feature_ntlm(),
            gss_api: version.feature_gss_negotiate(),
            spnego: version.feature_spnego(),
            kerberos: version.feature_sspi(),
            unix_sockets: version.feature_unix_domain_socket(),
            async_dns: version.feature_async_dns(),
            doh: version.feature_https_proxy(),
            hsts: version.feature_hsts(),
            alt_svc: version.feature_altsvc(),
            large_file: version.feature_largefile(),
            debug: version.feature_debug(),
            unicode: version.feature_unicode(),
            gsasl: version.feature_gsasl(),
        },
        compression: CompressionCapabilities {
            gzip: version.feature_libz(),
            brotli: version.feature_brotli(),
            zstd: version.feature_zstd(),
            deflate: version.feature_libz(),
        },
        http: HttpCapabilities {
            http1_0: true,
            http1_1: true,
            http2: version.feature_http2(),
            http2_prior_knowledge: version.feature_http2(),
            http3: version.feature_http3(),
            http3_only: version.feature_http3(),
            supported_versions: build_http_versions(&version),
        },
        dns: DnsCapabilities {
            async_dns: version.feature_async_dns(),
            doh: version.feature_https_proxy(),
            c_ares: version.ares_version().map(|s| s.to_string()),
        },
    }
}

fn build_http_versions(version: &::curl::Version) -> Vec<String> {
    let mut versions = vec!["1.0".to_string(), "1.1".to_string()];
    if version.feature_http2() {
        versions.push("2".to_string());
        versions.push("2-prior-knowledge".to_string());
    }
    if version.feature_http3() {
        versions.push("3".to_string());
        versions.push("3-only".to_string());
    }
    versions
}

pub fn validate_tls_backend(expected: &str) -> Result<(), String> {
    let caps = probe_capabilities();
    if !caps.tls.available {
        return Err("TLS is not available in this libcurl build".to_string());
    }
    let expected_lower = expected.to_ascii_lowercase();
    let actual_lower = caps.tls.backend_string.to_ascii_lowercase();
    if !actual_lower.contains(&expected_lower) {
        return Err(format!(
            "TLS backend mismatch: expected '{}', got '{}'",
            expected, caps.tls.backend_string
        ));
    }
    Ok(())
}

pub fn validate_protocols(required: &[&str]) -> Result<(), String> {
    let caps = probe_capabilities();
    let missing: Vec<&str> = required
        .iter()
        .filter(|proto| {
            let lower = proto.to_ascii_lowercase();
            !caps
                .protocols
                .all
                .iter()
                .any(|p| p.to_ascii_lowercase() == lower)
        })
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Missing required protocols: {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

pub fn validate_features(required: &[&str]) -> Result<(), String> {
    let caps = probe_capabilities();
    let missing: Vec<&str> = required
        .iter()
        .filter(|feat| {
            let lower = feat.to_ascii_lowercase();
            match lower.as_str() {
                "ssl" => !caps.features.ssl,
                "ipv6" => !caps.features.ipv6,
                "http2" => !caps.features.http2,
                "http3" => !caps.features.http3,
                "libz" | "zlib" => !caps.features.libz,
                "brotli" => !caps.features.brotli,
                "zstd" => !caps.features.zstd,
                "ntlm" => !caps.features.ntlm,
                "largefile" => !caps.features.large_file,
                "asynchdns" => !caps.features.async_dns,
                "https-proxy" => !caps.features.doh,
                _ => false,
            }
        })
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!("Missing required features: {}", missing.join(", ")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_valid_capabilities() {
        let caps = probe_capabilities();
        assert!(!caps.version.is_empty());
        assert!(caps.version_number > 0);
        assert!(caps.protocols.http || caps.protocols.https);
        assert!(caps.tls.available || !caps.features.ssl);
    }

    #[test]
    fn tls_backend_detection_openssl() {
        assert_eq!(
            TlsBackend::from_ssl_version_string("OpenSSL/3.2.1"),
            TlsBackend::OpenSSL
        );
    }

    #[test]
    fn tls_backend_detection_schannel() {
        assert_eq!(
            TlsBackend::from_ssl_version_string("Schannel"),
            TlsBackend::Schannel
        );
    }

    #[test]
    fn tls_backend_detection_secure_transport() {
        assert_eq!(
            TlsBackend::from_ssl_version_string("Secure Transport"),
            TlsBackend::SecureTransport
        );
    }

    #[test]
    fn tls_backend_detection_boringssl() {
        assert_eq!(
            TlsBackend::from_ssl_version_string("BoringSSL/1.1.1"),
            TlsBackend::BoringSSL
        );
    }

    #[test]
    fn tls_backend_detection_empty() {
        assert_eq!(TlsBackend::from_ssl_version_string(""), TlsBackend::Unknown);
    }

    #[test]
    fn tls_backend_detection_case_insensitive() {
        assert_eq!(
            TlsBackend::from_ssl_version_string("openssl/3.0.0"),
            TlsBackend::OpenSSL
        );
    }

    #[test]
    fn http_versions_include_base() {
        let caps = probe_capabilities();
        assert!(caps.http.http1_0);
        assert!(caps.http.http1_1);
    }

    #[test]
    fn validate_protocols_ok() {
        let result = validate_protocols(&["http", "https"]);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_features_ok() {
        let caps = probe_capabilities();
        let mut required = vec!["ssl"];
        if caps.features.http2 {
            required.push("http2");
        }
        assert!(validate_features(&required).is_ok());
    }
}
