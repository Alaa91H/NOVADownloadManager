#![allow(dead_code)]

pub mod error_intel;
pub mod http_probe;
pub mod plan_builder;
pub mod retry_intel;
pub mod stability;
pub mod strategy;
pub mod types;
pub mod url_intel;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use types::*;

use crate::daemon::state::SharedState;
use crate::daemon::types::CreateDownloadBody;

pub use stability::ServerProfileStore;

/// The Resource Intelligence Engine.
///
/// Takes a URL + user intent, runs the full analysis pipeline, and produces
/// a `ResolutionReport` and `DownloadPlan`. The engine is non-blocking:
/// the caller receives an initial report quickly, and deep analysis continues
/// in the background.
pub struct ResourceIntelligenceEngine {
    pub profile_store: Arc<ServerProfileStore>,
}

impl ResourceIntelligenceEngine {
    pub fn new() -> Self {
        Self {
            profile_store: Arc::new(ServerProfileStore::new()),
        }
    }

    /// Run the full resolution pipeline on a URL. Returns the final
    /// `ResolutionReport`. The caller should use this to build a `DownloadPlan`.
    pub async fn resolve(
        &self,
        state: &SharedState,
        url: &str,
        body: Option<&CreateDownloadBody>,
    ) -> ResolutionReport {
        let started_at = Instant::now();
        let mut report = ResolutionReport {
            resolution_phase: ResolutionPhase::Initial,
            started_at,
            ..Default::default()
        };

        // ── Stage 1: URL Intelligence ──────────────────────────────────
        let url_intel = url_intel::analyze_url(url);
        report.url_intel = Some(url_intel.clone());
        report.resolution_phase = ResolutionPhase::Probing;

        // Early exit for non-HTTP resources.
        match url_intel.resource_type {
            ResourceType::Magnet | ResourceType::Torrent => {
                report.elapsed = started_at.elapsed();
                return report;
            }
            ResourceType::Ftp => {
                // FTP downloads go through curl directly — no HTTP probing.
                report.elapsed = started_at.elapsed();
                return report;
            }
            _ => {}
        }

        // ── Stage 2: Network + TLS + HTTP Negotiation ──────────────────
        let probe_client = build_probe_client(state, body);
        let custom_headers = extract_custom_headers(body);

        let negotiator = http_probe::HttpNegotiator::new(&probe_client, &url_intel.normalized_url)
            .with_headers(custom_headers);

        let negotiation = negotiator.negotiate().await;

        report.resource_identity = Some(negotiation.resource_identity.clone());
        report.redirect_chain = negotiation.redirect_chain;
        report.server_capabilities = negotiation.capabilities.clone();
        report.request_diagnostics = RequestDiagnostics {
            head_result: negotiation.head_result,
            range_result: negotiation.range_result,
            get_result: negotiation.get_result,
            methods_attempted: negotiation.methods_attempted,
            best_method: negotiation.best_method,
            total_probe_duration: negotiation.total_duration,
        };
        report.errors = negotiation.errors;

        // ── Stage 3: Stability Analysis ────────────────────────────────
        let host = url_intel.host.clone();
        let stability = self.profile_store.analyze(&host);
        report.stability = stability;
        report.server_profile = self.profile_store.get(&host);

        // Record this probe in the server profile.
        if let Some(head) = &report.request_diagnostics.head_result {
            let range_confirmed = matches!(
                report.server_capabilities.range_support,
                CapabilityState::Confirmed
            );
            self.profile_store
                .record_probe(&host, head, range_confirmed);
        }

        // ── Stage 4: Error Intelligence ────────────────────────────────
        report.errors.iter().for_each(|e| {
            log::debug!(
                "RIE error: {:?} in {:?}: {}",
                e.category,
                e.phase,
                e.message
            );
        });

        // ── Stage 5: Retry Decision ────────────────────────────────────
        let total_failures = report.errors.len() as u32;
        report.retry_decision = if let Some(last_error) = report.errors.last() {
            retry_intel::decide_retry(
                last_error,
                0,
                total_failures,
                report.stability.overall_stability,
            )
        } else {
            RetryDecision::default()
        };

        // ── Stage 6: Strategy Selection ────────────────────────────────
        let default_resource = ResourceIdentity::default();
        let resource_ref = report
            .resource_identity
            .as_ref()
            .unwrap_or(&default_resource);
        let file_size = resource_ref.content_length.unwrap_or(0);
        let auth_required = report
            .errors
            .iter()
            .any(|e| e.category == ErrorCategory::AuthenticationRequired);
        report.authentication_required = auth_required;

        let (strategy, rationale) = strategy::select_strategy(
            resource_ref,
            &report.server_capabilities,
            &report.stability,
            report.server_profile.as_ref(),
            auth_required,
            file_size,
        );
        report.recommended_strategy = strategy;
        report.strategy_rationale = rationale;

        report.resolution_phase = ResolutionPhase::Complete;
        report.elapsed = started_at.elapsed();

        report
    }

    /// Build a minimal resolution report for immediate task display.
    /// Runs only URL analysis — no network calls.
    pub fn minimal_resolve(url: &str) -> ResolutionReport {
        let url_intel = url_intel::analyze_url(url);
        ResolutionReport {
            url_intel: Some(url_intel),
            resolution_phase: ResolutionPhase::Initial,
            recommended_strategy: DownloadStrategy::SingleConnection,
            strategy_rationale: StrategyRationale {
                primary_reason: "Minimal resolution — network probe not yet complete".to_string(),
                factors: vec!["Initial URL analysis only".to_string()],
                confidence: 0.3,
            },
            started_at: Instant::now(),
            ..Default::default()
        }
    }
}

fn build_probe_client(state: &SharedState, body: Option<&CreateDownloadBody>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder();
    if let Some(opts) = body.and_then(|b| b.direct_options.as_ref()) {
        if let Some(proxy) = opts.get("proxy").and_then(|v| v.as_str()) {
            if let Ok(proxy) = reqwest::Proxy::all(proxy) {
                builder = builder.proxy(proxy);
            }
        }
        if let Some(source) = opts
            .get("sourceAddress")
            .or_else(|| opts.get("interface"))
            .and_then(|v| v.as_str())
        {
            if let Ok(addr) = source.parse::<std::net::IpAddr>() {
                builder = builder.local_address(addr);
            }
        }
    }
    builder
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| state.http_client.clone())
}

fn extract_custom_headers(body: Option<&CreateDownloadBody>) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    if let Some(opts) = body.and_then(|b| b.direct_options.as_ref()) {
        if let Some(ua) = opts.get("userAgent").and_then(|v| v.as_str()) {
            headers.insert("user-agent".to_string(), ua.to_string());
        }
        if let Some(referer) = opts
            .get("referer")
            .and_then(|v| v.as_str())
            .or_else(|| body.and_then(|b| b.referer.as_deref()))
        {
            headers.insert("referer".to_string(), referer.to_string());
        }
        if let Some(cookies) = opts.get("cookies").and_then(|v| v.as_str()) {
            headers.insert("cookie".to_string(), cookies.to_string());
        }
        if let Some(raw) = opts.get("headers").and_then(|v| v.as_str()) {
            for line in raw.lines().map(str::trim).filter(|l| !l.is_empty()) {
                if let Some((k, v)) = line.split_once(':') {
                    headers.insert(k.trim().to_lowercase(), v.trim().to_string());
                }
            }
        }
    }
    headers
}
