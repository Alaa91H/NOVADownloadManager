use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use super::strategy::select_strategy;
use super::types::*;

pub fn build_download_plan(report: &ResolutionReport, existing_partial_size: u64) -> DownloadPlan {
    let resource = report.resource_identity.as_ref();
    let capabilities = &report.server_capabilities;
    let stability = &report.stability;
    let profile = report.server_profile.as_ref();
    let auth_required = report.authentication_required;

    let file_size = resource.and_then(|r| r.content_length).unwrap_or(0);

    let (strategy, rationale) = select_strategy(
        resource.unwrap_or(&ResourceIdentity::default()),
        capabilities,
        stability,
        profile,
        auth_required,
        file_size,
    );

    let connections = compute_connections(&strategy, profile, stability);
    let resumable = matches!(capabilities.resume_support, CapabilityState::Confirmed)
        || existing_partial_size > 0;

    let mirrors = resource
        .map(|_r| {
            report
                .request_diagnostics
                .head_result
                .as_ref()
                .or(report.request_diagnostics.range_result.as_ref())
                .or(report.request_diagnostics.get_result.as_ref())
                .map(extract_link_mirrors)
                .unwrap_or_default()
        })
        .unwrap_or_default();

    // If we have partial data and resume is supported, prefer resume strategy.
    let final_strategy = if existing_partial_size > 0 && resumable {
        DownloadStrategy::ResumeExisting
    } else {
        strategy
    };

    DownloadPlan {
        url: report
            .url_intel
            .as_ref()
            .map(|u| u.normalized_url.clone())
            .unwrap_or_default(),
        strategy: final_strategy,
        connections,
        resumable,
        file_size,
        file_name: resource.map(|r| r.file_name.clone()).unwrap_or_default(),
        content_type: resource.and_then(|r| r.content_type.clone()),
        etag: resource.and_then(|r| r.etag.clone()),
        last_modified: resource.and_then(|r| r.last_modified.clone()),
        digest_sha256: resource.and_then(|r| r.digest_sha256.clone()),
        mirrors,
        mirror_priorities: Vec::new(),
        referer: None,
        rate_limit_bps: None,
        confidence: rationale.confidence,
        built_at: std::time::Instant::now(),
        report_hash: compute_report_hash(report),
    }
}

fn compute_connections(
    strategy: &DownloadStrategy,
    profile: Option<&ServerProfile>,
    stability: &StabilityAnalysis,
) -> u32 {
    match strategy {
        DownloadStrategy::SingleConnection => 1,
        DownloadStrategy::Authenticated => 1,
        DownloadStrategy::ExternalResolver => 1,
        DownloadStrategy::ProxyRequired => 1,
        DownloadStrategy::NetworkFallback => 1,
        DownloadStrategy::ResumeExisting
        | DownloadStrategy::Segmented
        | DownloadStrategy::AdaptiveSegmented => {
            if let Some(p) = profile {
                p.recommended_connections
            } else if stability.overall_stability > 0.9 {
                8
            } else if stability.overall_stability > 0.6 {
                4
            } else {
                2
            }
        }
    }
}

fn compute_report_hash(report: &ResolutionReport) -> u64 {
    let mut hasher = DefaultHasher::new();
    if let Some(ref url) = report.resource_identity {
        url.final_url.hash(&mut hasher);
        url.content_length.hash(&mut hasher);
        url.etag.hash(&mut hasher);
        url.last_modified.hash(&mut hasher);
    }
    report.resolution_phase.hash(&mut hasher);
    hasher.finish()
}

fn extract_link_mirrors(result: &ProbeResult) -> Vec<String> {
    result
        .headers
        .get("link")
        .map(|link| {
            link.split(',')
                .filter_map(|part| {
                    let part = part.trim();
                    if part.contains("rel=\"duplicate\"") || part.contains("rel=duplicate") {
                        part.split('<').nth(1)?.split('>').next().map(String::from)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}
