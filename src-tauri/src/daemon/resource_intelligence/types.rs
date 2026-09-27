use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

// ─────────────────────────── URL Intelligence ────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UrlIntelligence {
    pub original_url: String,
    pub normalized_url: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub query: String,
    pub fragment: String,
    pub resource_type: ResourceType,
    pub encoding: UrlEncoding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UrlEncoding {
    pub is_idn: bool,
    pub punycode: Option<String>,
    pub has_query_encoding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ResourceType {
    DirectHttp,
    DirectHttps,
    Ftp,
    Magnet,
    Torrent,
    PluginResolvable,
    Unknown,
}

// ─────────────────────────── Redirect Intelligence ───────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RedirectChain {
    pub hops: Vec<RedirectHop>,
    pub security_downgrade: bool,
    pub scheme_upgrade: bool,
    pub cross_origin: bool,
    pub host_changes: Vec<String>,
    pub final_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedirectHop {
    pub from: String,
    pub to: String,
    pub status_code: u16,
    pub method: String,
    pub host_changed: bool,
    pub scheme_changed: bool,
    pub security_downgrade: bool,
}

// ─────────────────────────── Resource Identity ───────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ResourceIdentity {
    pub final_url: String,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub content_disposition: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub digest_sha256: Option<String>,
    pub file_name: String,
    pub file_type: String,
}

// ─────────────────────────── Capability Detection ────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerCapabilities {
    pub range_support: CapabilityState,
    pub resume_support: CapabilityState,
    pub parallel_connections: CapabilityState,
    pub compression: CapabilityState,
    pub chunked_transfer: CapabilityState,
    pub http2_multiplexing: CapabilityState,
    pub content_length_reliable: CapabilityState,
    pub detected_connections: Option<u32>,
    /// RFC 6249 mirror URLs discovered from `Link: <url>; rel=duplicate`
    /// headers during the HTTP probe. These feed into the mirror failover
    /// system so the download engine can switch to an alternate source if
    /// the primary fails.
    pub link_mirrors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum CapabilityState {
    Confirmed,
    NotSupported,
    #[default]
    Unknown,
}

// ─────────────────────────── Stability Intelligence ──────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerProfile {
    pub host: String,
    pub range_support: CapabilityState,
    pub stability_score: f64,
    pub rate_limit_detected: bool,
    pub recommended_connections: u32,
    pub historical_error_rate: f64,
    pub avg_response_time_ms: f64,
    pub last_observed: String,
    pub total_probes: u64,
    pub successful_probes: u64,
    pub consecutive_failures: u32,
}

impl Default for ServerProfile {
    fn default() -> Self {
        Self {
            host: String::new(),
            range_support: CapabilityState::Unknown,
            stability_score: 1.0,
            rate_limit_detected: false,
            recommended_connections: 8,
            historical_error_rate: 0.0,
            avg_response_time_ms: 0.0,
            last_observed: String::new(),
            total_probes: 0,
            successful_probes: 0,
            consecutive_failures: 0,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StabilityAnalysis {
    pub response_stability: f64,
    pub connection_stability: f64,
    pub error_rate: f64,
    pub rate_limiting_detected: bool,
    pub overall_stability: f64,
}

// ─────────────────────────── Error Intelligence ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolutionError {
    pub category: ErrorCategory,
    pub phase: ErrorPhase,
    pub message: String,
    pub http_status: Option<u16>,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorCategory {
    DnsFailure,
    ConnectionFailure,
    Timeout,
    TlsFailure,
    HttpFailure,
    RedirectFailure,
    AuthenticationRequired,
    AccessDenied,
    ProxyFailure,
    RateLimited,
    NotFound,
    ProtocolFailure,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorPhase {
    DnsResolution,
    TcpConnect,
    TlsHandshake,
    HttpRequest,
    HttpResponse,
    RedirectFollowing,
    DataTransfer,
    Validation,
}

// ─────────────────────────── Retry Intelligence ──────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryDecision {
    pub should_retry: bool,
    pub delay: Duration,
    pub max_attempts: u32,
    pub attempt_count: u32,
    pub strategy: RetryStrategy,
    pub reason: String,
    pub circuit_breaker_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum RetryStrategy {
    ExponentialBackoff,
    ExponentialBackoffWithJitter,
    FixedDelay,
    Immediate,
    CircuitBreaker,
    DoNotRetry,
}

impl Default for RetryDecision {
    fn default() -> Self {
        Self {
            should_retry: false,
            delay: Duration::from_secs(0),
            max_attempts: 3,
            attempt_count: 0,
            strategy: RetryStrategy::DoNotRetry,
            reason: "No error recorded".to_owned(),
            circuit_breaker_active: false,
        }
    }
}

// ─────────────────────────── Download Strategy ───────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum DownloadStrategy {
    #[default]
    SingleConnection,
    Segmented,
    AdaptiveSegmented,
    Authenticated,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StrategyRationale {
    pub primary_reason: String,
    pub factors: Vec<String>,
    pub confidence: f64,
}

// ─────────────────────────── HTTP Probe ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub method: ProbeMethod,
    pub status_code: u16,
    pub headers: HashMap<String, String>,
    pub duration: Duration,
    pub final_url: Option<String>,
    pub error: Option<String>,
    pub redirect_hop: Option<RedirectHop>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProbeMethod {
    Head,
    GetRange,
    Get,
}

// ─────────────────────────── Request Diagnostics ─────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestDiagnostics {
    pub head_result: Option<ProbeResult>,
    pub range_result: Option<ProbeResult>,
    pub get_result: Option<ProbeResult>,
    pub methods_attempted: Vec<ProbeMethod>,
    pub best_method: Option<ProbeMethod>,
    pub total_probe_duration: Duration,
}

// ─────────────────────────── Resolution Report ───────────────────────────────

#[derive(Debug, Clone)]
pub struct ResolutionReport {
    pub url_intel: Option<UrlIntelligence>,
    pub request_diagnostics: RequestDiagnostics,
    pub redirect_chain: RedirectChain,
    pub resource_identity: Option<ResourceIdentity>,
    pub server_capabilities: ServerCapabilities,
    pub stability: StabilityAnalysis,
    pub server_profile: Option<ServerProfile>,
    pub authentication_required: bool,
    pub errors: Vec<ResolutionError>,
    pub retry_decision: RetryDecision,
    pub recommended_strategy: DownloadStrategy,
    pub strategy_rationale: StrategyRationale,
    pub resolution_phase: ResolutionPhase,
    #[allow(dead_code)]
    pub started_at: std::time::Instant,
    pub elapsed: Duration,
}

impl Default for ResolutionReport {
    fn default() -> Self {
        Self {
            url_intel: None,
            request_diagnostics: RequestDiagnostics::default(),
            redirect_chain: RedirectChain::default(),
            resource_identity: None,
            server_capabilities: ServerCapabilities::default(),
            stability: StabilityAnalysis::default(),
            server_profile: None,
            authentication_required: false,
            errors: Vec::new(),
            retry_decision: RetryDecision::default(),
            recommended_strategy: DownloadStrategy::default(),
            strategy_rationale: StrategyRationale::default(),
            resolution_phase: ResolutionPhase::default(),
            started_at: std::time::Instant::now(),
            elapsed: Duration::ZERO,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum ResolutionPhase {
    #[default]
    Initial,
    Probing,
    Complete,
}
