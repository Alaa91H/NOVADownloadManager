use super::types::*;

pub fn select_strategy(
    _resource: &ResourceIdentity,
    capabilities: &ServerCapabilities,
    stability: &StabilityAnalysis,
    profile: Option<&ServerProfile>,
    auth_required: bool,
    file_size: u64,
) -> (DownloadStrategy, StrategyRationale) {
    let mut factors = Vec::new();

    // Auth gate.
    if auth_required {
        factors.push("Authentication required — using external resolver".to_string());
        return (
            DownloadStrategy::Authenticated,
            StrategyRationale {
                primary_reason: "Authentication required to access resource".to_string(),
                factors,
                confidence: 0.9,
            },
        );
    }

    let range_confirmed = capabilities.range_support == CapabilityState::Confirmed;
    let stable = stability.overall_stability > 0.7;
    let large_file = file_size > 10 * 1024 * 1024; // >10 MB
    let small_file = file_size > 0 && file_size <= 1024 * 1024; // <=1 MB

    // Resume existing partial.
    // (Caller should check this before calling us; we include it for completeness.)

    // Small file + unknown range: single connection.
    if small_file && !range_confirmed {
        factors.push(format!(
            "Small file ({}) and range support unknown",
            human_size(file_size)
        ));
        return (
            DownloadStrategy::SingleConnection,
            StrategyRationale {
                primary_reason: "Small file, no range confirmation".to_string(),
                factors,
                confidence: 0.8,
            },
        );
    }

    // Large file + range confirmed + stable: segmented.
    if large_file && range_confirmed && stable {
        let connections = recommended_connections(profile, stability);
        factors.push(format!("Large file ({})", human_size(file_size)));
        factors.push("Range confirmed by server".to_string());
        factors.push(format!(
            "Server stability: {:.0}%",
            stability.overall_stability * 100.0
        ));
        factors.push(format!("Recommended connections: {connections}"));
        return (
            DownloadStrategy::AdaptiveSegmented,
            StrategyRationale {
                primary_reason: "Large file with confirmed range and stable server".to_string(),
                factors,
                confidence: 0.9,
            },
        );
    }

    // Large file + range confirmed + unstable: segmented with fewer connections.
    if large_file && range_confirmed && !stable {
        factors.push(format!("Large file ({})", human_size(file_size)));
        factors.push("Range confirmed but server is unstable".to_string());
        return (
            DownloadStrategy::Segmented,
            StrategyRationale {
                primary_reason: "Range available but server stability is low".to_string(),
                factors,
                confidence: 0.7,
            },
        );
    }

    // Large file + range unknown: try segmented cautiously.
    if large_file && !range_confirmed {
        factors.push(format!(
            "Large file ({}) with unknown range support",
            human_size(file_size)
        ));
        return (
            DownloadStrategy::Segmented,
            StrategyRationale {
                primary_reason: "Large file, attempting segmented despite unknown range"
                    .to_string(),
                factors,
                confidence: 0.5,
            },
        );
    }

    // Default: single connection.
    factors.push("Default strategy for unclassified conditions".to_string());
    (
        DownloadStrategy::SingleConnection,
        StrategyRationale {
            primary_reason: "Standard single-connection download".to_string(),
            factors,
            confidence: 0.6,
        },
    )
}

fn recommended_connections(profile: Option<&ServerProfile>, stability: &StabilityAnalysis) -> u32 {
    if let Some(p) = profile {
        return p.recommended_connections;
    }
    if stability.overall_stability > 0.9 {
        8
    } else if stability.overall_stability > 0.6 {
        4
    } else {
        2
    }
}

fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}
