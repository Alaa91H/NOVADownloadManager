use super::types::{ErrorCategory, ErrorPhase, ResolutionError};
use std::time::Duration;

pub fn classify_reqwest_error(error: &reqwest::Error, phase: ErrorPhase) -> ResolutionError {
    let message = error.to_string();

    if error.is_timeout() {
        return ResolutionError {
            category: ErrorCategory::Timeout,
            phase,
            message,
            http_status: None,
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: true,
            retry_after: Some(Duration::from_secs(5)),
            user_action_required: false,
        };
    }

    if error.is_connect() {
        let category = classify_connection_error(&message);
        let retryable = !matches!(
            category,
            ErrorCategory::AccessDenied | ErrorCategory::AuthenticationRequired
        );
        return ResolutionError {
            category,
            phase,
            message,
            http_status: None,
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable,
            retry_after: None,
            user_action_required: false,
        };
    }

    if error.is_redirect() {
        return ResolutionError {
            category: ErrorCategory::RedirectFailure,
            phase,
            message,
            http_status: None,
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: false,
            retry_after: None,
            user_action_required: false,
        };
    }

    if let Some(status) = error.status() {
        return classify_http_status(status.as_u16(), phase);
    }

    ResolutionError {
        category: ErrorCategory::Unknown,
        phase,
        message,
        http_status: None,
        curl_code: None,
        curl_message: None,
        os_error: None,
        retryable: true,
        retry_after: None,
        user_action_required: false,
    }
}

pub fn classify_http_status(status: u16, phase: ErrorPhase) -> ResolutionError {
    match status {
        401 | 403 => ResolutionError {
            category: if status == 401 {
                ErrorCategory::AuthenticationRequired
            } else {
                ErrorCategory::AccessDenied
            },
            phase,
            message: format!("HTTP {status}"),
            http_status: Some(status),
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: false,
            retry_after: None,
            user_action_required: true,
        },
        404 => ResolutionError {
            category: ErrorCategory::NotFound,
            phase,
            message: format!("HTTP {status} Not Found"),
            http_status: Some(status),
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: false,
            retry_after: None,
            user_action_required: true,
        },
        429 => {
            let retry_after_secs = estimate_rate_limit_backoff(status);
            ResolutionError {
                category: ErrorCategory::RateLimited,
                phase,
                message: format!("HTTP {status} Too Many Requests"),
                http_status: Some(status),
                curl_code: None,
                curl_message: None,
                os_error: None,
                retryable: true,
                retry_after: Some(Duration::from_secs(retry_after_secs)),
                user_action_required: false,
            }
        }
        500..=599 => ResolutionError {
            category: ErrorCategory::HttpFailure,
            phase,
            message: format!("HTTP {status} Server Error"),
            http_status: Some(status),
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: status != 501,
            retry_after: Some(Duration::from_secs(server_error_backoff(status))),
            user_action_required: false,
        },
        _ => ResolutionError {
            category: ErrorCategory::HttpFailure,
            phase,
            message: format!("HTTP {status}"),
            http_status: Some(status),
            curl_code: None,
            curl_message: None,
            os_error: None,
            retryable: false,
            retry_after: None,
            user_action_required: false,
        },
    }
}

pub fn classify_curl_error(
    curl_code: i32,
    curl_message: &str,
    phase: ErrorPhase,
) -> ResolutionError {
    let (category, retryable) = match curl_code {
        6 => (ErrorCategory::DnsFailure, true),
        7 => (ErrorCategory::ConnectionFailure, true),
        28 => (ErrorCategory::Timeout, true),
        35 => (ErrorCategory::TlsFailure, false),
        51 | 58 | 60 => (ErrorCategory::TlsFailure, false),
        47 => (ErrorCategory::RedirectFailure, true),
        92 => (ErrorCategory::HttpFailure, true),
        22 => (ErrorCategory::HttpFailure, false),
        _ => (ErrorCategory::Unknown, true),
    };

    ResolutionError {
        category,
        phase,
        message: curl_message.to_string(),
        http_status: None,
        curl_code: Some(curl_code),
        curl_message: Some(curl_message.to_string()),
        os_error: None,
        retryable,
        retry_after: if retryable {
            Some(Duration::from_secs(3))
        } else {
            None
        },
        user_action_required: false,
    }
}

fn classify_connection_error(message: &str) -> ErrorCategory {
    let lower = message.to_lowercase();
    if lower.contains("dns") || lower.contains("resolve") || lower.contains("name") {
        ErrorCategory::DnsFailure
    } else if lower.contains("refused") {
        ErrorCategory::ConnectionFailure
    } else if lower.contains("proxy") {
        ErrorCategory::ProxyFailure
    } else if lower.contains("tls") || lower.contains("ssl") || lower.contains("certificate") {
        ErrorCategory::TlsFailure
    } else {
        ErrorCategory::ConnectionFailure
    }
}

fn estimate_rate_limit_backoff(_status: u16) -> u64 {
    30
}

fn server_error_backoff(status: u16) -> u64 {
    match status {
        503 => 10,
        502 => 5,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_404() {
        let err = classify_http_status(404, ErrorPhase::HttpRequest);
        assert_eq!(err.category, ErrorCategory::NotFound);
        assert!(!err.retryable);
        assert!(err.user_action_required);
    }

    #[test]
    fn classify_429() {
        let err = classify_http_status(429, ErrorPhase::HttpRequest);
        assert_eq!(err.category, ErrorCategory::RateLimited);
        assert!(err.retryable);
    }

    #[test]
    fn classify_503() {
        let err = classify_http_status(503, ErrorPhase::HttpRequest);
        assert_eq!(err.category, ErrorCategory::HttpFailure);
        assert!(err.retryable);
    }

    #[test]
    fn classify_curl_dns_failure() {
        let err = classify_curl_error(6, "Could not resolve host", ErrorPhase::DnsResolution);
        assert_eq!(err.category, ErrorCategory::DnsFailure);
        assert!(err.retryable);
    }

    #[test]
    fn classify_curl_tls_error() {
        let err = classify_curl_error(35, "SSL connect error", ErrorPhase::TlsHandshake);
        assert_eq!(err.category, ErrorCategory::TlsFailure);
        assert!(!err.retryable);
    }
}
