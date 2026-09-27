use std::time::Duration;

use super::server_profiler::ProtocolVersion;
use crate::daemon::engine::config::MAX_CONNECTIONS_PER_DOWNLOAD;

pub struct ProtocolAdapter {
    negotiated: ProtocolVersion,
    multiplexing: bool,
}

impl ProtocolAdapter {
    pub const fn new(protocol: ProtocolVersion) -> Self {
        let multiplexing = matches!(protocol, ProtocolVersion::Http2 | ProtocolVersion::Http3);
        Self {
            negotiated: protocol,
            multiplexing,
        }
    }

    pub fn connection_range(&self, cpu_count: u32) -> (u32, u32) {
        // Resource sampling may temporarily report zero CPUs in constrained
        // containers. Never produce min > max: downstream `clamp` requires a
        // valid interval and would otherwise panic while a download is active.
        let conservative_scaled = cpu_count.max(1).saturating_mul(2);
        let parallel_http11_scaled = cpu_count.max(1).saturating_mul(8);
        match self.negotiated {
            // Multiplexed HTTP needs fewer TCP connections; exceeding this
            // range commonly harms fairness and causes needless contention.
            ProtocolVersion::Http2 | ProtocolVersion::Http3 => {
                (2, conservative_scaled.min(16).max(2))
            }
            // Range-capable HTTP/1.1 can benefit from higher parallelism on
            // capable hosts. ResourceMonitor and convergence still gate the
            // actual target, and the central circuit-breaker stays absolute.
            ProtocolVersion::Http11 => (
                1,
                parallel_http11_scaled
                    .min(MAX_CONNECTIONS_PER_DOWNLOAD)
                    .max(1),
            ),
            ProtocolVersion::Ftp => (1, 1),
            ProtocolVersion::Sftp | ProtocolVersion::Scp => (1, 1),
            ProtocolVersion::Unknown => (2, conservative_scaled.min(16).max(2)),
        }
    }

    pub const fn prefer_multiplexing(&self) -> bool {
        self.multiplexing
    }

    pub const fn connection_timeout(&self) -> Duration {
        match self.negotiated {
            ProtocolVersion::Http2 | ProtocolVersion::Http3 => Duration::from_secs(30),
            ProtocolVersion::Http11 => Duration::from_secs(15),
            ProtocolVersion::Ftp => Duration::from_secs(60),
            ProtocolVersion::Sftp | ProtocolVersion::Scp => Duration::from_secs(60),
            ProtocolVersion::Unknown => Duration::from_secs(30),
        }
    }

    pub const fn keepalive_interval(&self) -> Duration {
        match self.negotiated {
            ProtocolVersion::Http2 | ProtocolVersion::Http3 => Duration::from_secs(30),
            ProtocolVersion::Http11 => Duration::from_secs(15),
            _ => Duration::from_secs(60),
        }
    }

    pub const fn is_single_stream(&self) -> bool {
        matches!(
            self.negotiated,
            ProtocolVersion::Ftp | ProtocolVersion::Sftp | ProtocolVersion::Scp
        )
    }

    pub const fn protocol(&self) -> &ProtocolVersion {
        &self.negotiated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http2_connection_range() {
        let a = ProtocolAdapter::new(ProtocolVersion::Http2);
        let (min, max) = a.connection_range(8);
        assert_eq!(min, 2);
        assert_eq!(max, 16);
        assert!(a.prefer_multiplexing());
        assert!(!a.is_single_stream());
    }

    #[test]
    fn http11_connection_range() {
        let a = ProtocolAdapter::new(ProtocolVersion::Http11);
        let (min, max) = a.connection_range(8);
        assert_eq!(min, 1);
        assert_eq!(max, 64);
        assert!(!a.prefer_multiplexing());
    }

    #[test]
    fn http11_can_offer_more_than_legacy_connection_ceiling() {
        let a = ProtocolAdapter::new(ProtocolVersion::Http11);
        let (_, max) = a.connection_range(8);
        assert!(max > 32);
        assert!(max <= MAX_CONNECTIONS_PER_DOWNLOAD);
    }

    #[test]
    fn ftp_single_connection() {
        let a = ProtocolAdapter::new(ProtocolVersion::Ftp);
        let (min, max) = a.connection_range(8);
        assert_eq!(min, 1);
        assert_eq!(max, 1);
        assert!(a.is_single_stream());
    }

    #[test]
    fn sftp_single_connection() {
        let a = ProtocolAdapter::new(ProtocolVersion::Sftp);
        assert!(a.is_single_stream());
        let (_, max) = a.connection_range(8);
        assert_eq!(max, 1);
    }

    #[test]
    fn connection_timeout_by_protocol() {
        assert_eq!(
            ProtocolAdapter::new(ProtocolVersion::Http2).connection_timeout(),
            Duration::from_secs(30)
        );
        assert_eq!(
            ProtocolAdapter::new(ProtocolVersion::Http11).connection_timeout(),
            Duration::from_secs(15)
        );
        assert_eq!(
            ProtocolAdapter::new(ProtocolVersion::Ftp).connection_timeout(),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn cpu_count_scales_max_connections() {
        let a = ProtocolAdapter::new(ProtocolVersion::Http2);
        let (_, max_4) = a.connection_range(4);
        let (_, max_16) = a.connection_range(16);
        assert!(max_16 > max_4);
    }

    #[test]
    fn unknown_protocol_uses_conservative_defaults() {
        let a = ProtocolAdapter::new(ProtocolVersion::Unknown);
        let (min, max) = a.connection_range(8);
        assert_eq!(min, 2);
        assert_eq!(max, 16);
    }

    #[test]
    fn zero_cpu_count_still_produces_a_valid_connection_interval() {
        for protocol in [
            ProtocolVersion::Http2,
            ProtocolVersion::Http3,
            ProtocolVersion::Http11,
            ProtocolVersion::Unknown,
        ] {
            let (min, max) = ProtocolAdapter::new(protocol).connection_range(0);
            assert!(min >= 1);
            assert!(min <= max, "invalid interval {min}..={max}");
        }
    }
}
