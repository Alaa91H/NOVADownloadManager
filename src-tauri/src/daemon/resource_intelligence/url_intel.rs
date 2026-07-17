use super::types::{ResourceType, UrlEncoding, UrlIntelligence};

const DEFAULT_HTTPS_PORT: u16 = 443;
const DEFAULT_HTTP_PORT: u16 = 80;
const DEFAULT_FTP_PORT: u16 = 21;

pub fn analyze_url(url: &str) -> UrlIntelligence {
    let trimmed = url.trim();
    let normalized = normalize_url(trimmed);
    let resource_type = detect_resource_type(trimmed);
    let encoding = detect_encoding(trimmed);

    let parsed = reqwest::Url::parse(&normalized).ok();
    let scheme = parsed
        .as_ref()
        .map(|u| u.scheme().to_string())
        .unwrap_or_default();
    let host = parsed
        .as_ref()
        .and_then(|u| u.host_str())
        .unwrap_or("")
        .to_string();
    let port = parsed
        .as_ref()
        .and_then(|u| u.port())
        .unwrap_or_else(|| default_port(&scheme));
    let path = parsed
        .as_ref()
        .map(|u| u.path().to_string())
        .unwrap_or_default();
    let query = parsed
        .as_ref()
        .and_then(|u| {
            let q = u.query().unwrap_or("");
            if q.is_empty() {
                None
            } else {
                Some(q.to_string())
            }
        })
        .unwrap_or_default();
    let fragment = parsed
        .as_ref()
        .and_then(|u| {
            let f = u.fragment().unwrap_or("");
            if f.is_empty() {
                None
            } else {
                Some(f.to_string())
            }
        })
        .unwrap_or_default();

    UrlIntelligence {
        original_url: trimmed.to_string(),
        normalized_url: normalized,
        scheme,
        host,
        port,
        path,
        query,
        fragment,
        resource_type,
        encoding,
    }
}

fn normalize_url(url: &str) -> String {
    if url.starts_with("magnet:") || url.starts_with("sftp://") || url.starts_with("scp://") {
        return url.to_string();
    }

    let mut result = url.to_string();

    // Ensure scheme exists.
    if !result.contains("://") && !result.starts_with("ftp.") {
        result = format!("https://{}", result);
    }

    // Remove default port.
    if let Ok(mut parsed) = reqwest::Url::parse(&result) {
        let scheme = parsed.scheme().to_string();
        let default = default_port(&scheme);
        if parsed.port() == Some(default) {
            let _ = parsed.set_port(None);
        }
        // Remove fragment.
        parsed.set_fragment(None);
        // Normalize trailing slash on path-only URLs.
        if parsed.path() == "/" && parsed.query().is_none() {
            parsed.set_path("");
        }
        result = parsed.to_string();
    }

    result
}

fn detect_resource_type(url: &str) -> ResourceType {
    if url.starts_with("magnet:") {
        return ResourceType::Magnet;
    }
    if url.to_lowercase().ends_with(".torrent") || url.contains(".torrent?") {
        return ResourceType::Torrent;
    }
    if url.starts_with("ftp://") || url.starts_with("ftps://") {
        return ResourceType::Ftp;
    }
    if url.starts_with("sftp://") || url.starts_with("scp://") {
        return ResourceType::PluginResolvable;
    }
    if url.starts_with("https://") {
        return ResourceType::DirectHttps;
    }
    if url.starts_with("http://") {
        return ResourceType::DirectHttp;
    }
    ResourceType::Unknown
}

fn detect_encoding(url: &str) -> UrlEncoding {
    let parsed = reqwest::Url::parse(url).ok();
    let is_idn = parsed
        .as_ref()
        .and_then(|u| u.host_str())
        .map(|h| h.starts_with("xn--") || h.contains(".xn--"))
        .unwrap_or(false);

    let punycode = if is_idn {
        parsed.as_ref().and_then(|u| u.host_str()).map(String::from)
    } else {
        None
    };

    let has_query_encoding = parsed
        .as_ref()
        .and_then(|u| u.query())
        .map(|q| q.contains('%'))
        .unwrap_or(false);

    UrlEncoding {
        is_idn,
        punycode,
        has_query_encoding,
    }
}

fn default_port(scheme: &str) -> u16 {
    match scheme {
        "https" => DEFAULT_HTTPS_PORT,
        "http" => DEFAULT_HTTP_PORT,
        "ftp" | "ftps" => DEFAULT_FTP_PORT,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_removes_default_port() {
        let result = analyze_url("https://example.com:443/file.bin");
        assert_eq!(result.normalized_url, "https://example.com/file.bin");
    }

    #[test]
    fn detect_magnet() {
        let result = analyze_url("magnet:?xt=urn:btih:abc123");
        assert_eq!(result.resource_type, ResourceType::Magnet);
    }

    #[test]
    fn detect_ftp() {
        let result = analyze_url("ftp://files.example.com/pub/file.bin");
        assert_eq!(result.resource_type, ResourceType::Ftp);
    }

    #[test]
    fn normalize_adds_scheme() {
        let result = analyze_url("example.com/file.bin");
        assert!(result.normalized_url.starts_with("https://"));
    }

    #[test]
    fn detect_torrent() {
        let result = analyze_url("https://example.com/file.torrent");
        assert_eq!(result.resource_type, ResourceType::Torrent);
    }
}
