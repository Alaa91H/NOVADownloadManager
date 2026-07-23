use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct HostCapabilities {
    pub supports_range: bool,
    pub supports_resume: bool,
    pub supports_head: bool,
    pub max_connections: u32,
    pub stable_connections: u32,
    pub optimal_segment_size: u64,
    pub measured_rtt_us: u64,
    pub measured_throughput: u64,
    pub per_connection_ceiling: u64,
    pub multiplexed: bool,
    pub last_probed: Instant,
    pub probe_count: u32,
    pub probe_failures: u32,
}

impl Default for HostCapabilities {
    fn default() -> Self {
        Self {
            supports_range: true,
            supports_resume: true,
            supports_head: true,
            max_connections: 4,
            stable_connections: 4,
            optimal_segment_size: 1024 * 1024,
            measured_rtt_us: 0,
            measured_throughput: 0,
            per_connection_ceiling: 0,
            multiplexed: false,
            last_probed: Instant::now(),
            probe_count: 0,
            probe_failures: 0,
        }
    }
}

pub struct CapabilityDiscovery {
    capabilities: HashMap<String, HostCapabilities>,
    default: HostCapabilities,
    stale_threshold: Duration,
}

impl CapabilityDiscovery {
    pub fn new() -> Self {
        Self {
            capabilities: HashMap::new(),
            default: HostCapabilities::default(),
            stale_threshold: Duration::from_secs(300),
        }
    }

    pub fn get_or_default(&self, host: &str) -> HostCapabilities {
        self.capabilities.get(host).cloned().unwrap_or_else(|| {
            let mut cap = self.default.clone();
            cap.last_probed = Instant::now() - self.stale_threshold;
            cap
        })
    }

    pub fn update(&mut self, host: &str, capabilities: HostCapabilities) {
        let entry = self.capabilities.entry(host.to_string()).or_default();
        let mut new_cap = capabilities;
        new_cap.probe_count = entry.probe_count + 1;
        new_cap.last_probed = Instant::now();
        if !new_cap.supports_range {
            new_cap.max_connections = 1;
            new_cap.stable_connections = 1;
        }
        *entry = new_cap;
    }

    pub fn record_probe_failure(&mut self, host: &str) {
        if let Some(cap) = self.capabilities.get_mut(host) {
            cap.probe_failures += 1;
        }
    }

    pub fn needs_probe(&self, host: &str) -> bool {
        match self.capabilities.get(host) {
            None => true,
            Some(cap) => {
                cap.last_probed.elapsed() > self.stale_threshold
                    || cap.probe_count == 0
                    || (cap.probe_failures as f64 / cap.probe_count.max(1) as f64) > 0.5
            }
        }
    }

    pub fn hosts_needing_probe(&self) -> Vec<String> {
        self.capabilities.keys()
            .filter(|host| self.needs_probe(host))
            .cloned()
            .collect()
    }

    pub fn all_capabilities(&self) -> &HashMap<String, HostCapabilities> {
        &self.capabilities
    }

    pub fn remove(&mut self, host: &str) {
        self.capabilities.remove(host);
    }

    pub fn set_max_connections(&mut self, host: &str, max: u32) {
        if let Some(cap) = self.capabilities.get_mut(host) {
            cap.max_connections = max;
            if max < cap.stable_connections {
                cap.stable_connections = max;
            }
        }
    }

    pub fn update_throughput(&mut self, host: &str, throughput: u64, per_conn: u64) {
        if let Some(cap) = self.capabilities.get_mut(host) {
            cap.measured_throughput = throughput;
            cap.per_connection_ceiling = per_conn;
            let ideal = if per_conn > 0 { (throughput / per_conn).max(1) as u32 } else { 1 };
            cap.stable_connections = ideal.min(cap.max_connections);
        }
    }

    pub fn set_multiplexed(&mut self, host: &str, multiplexed: bool) {
        if let Some(cap) = self.capabilities.get_mut(host) {
            cap.multiplexed = multiplexed;
            if multiplexed {
                cap.stable_connections = 1;
            }
        }
    }
}

impl Default for CapabilityDiscovery {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_discovery_has_no_capabilities() {
        let cd = CapabilityDiscovery::new();
        assert!(cd.all_capabilities().is_empty());
    }

    #[test]
    fn needs_probe_for_unknown_host() {
        let cd = CapabilityDiscovery::new();
        assert!(cd.needs_probe("unknown.com"));
    }

    #[test]
    fn update_creates_capability() {
        let mut cd = CapabilityDiscovery::new();
        let cap = HostCapabilities::default();
        cd.update("example.com", cap);
        assert!(!cd.needs_probe("example.com"));
    }

    #[test]
    fn record_probe_failure_increments() {
        let mut cd = CapabilityDiscovery::new();
        cd.update("example.com", HostCapabilities::default());
        cd.record_probe_failure("example.com");
        cd.record_probe_failure("example.com");
        let cap = cd.get_or_default("example.com");
        assert_eq!(cap.probe_failures, 2);
    }

    #[test]
    fn remove_clears_capability() {
        let mut cd = CapabilityDiscovery::new();
        cd.update("example.com", HostCapabilities::default());
        cd.remove("example.com");
        assert!(cd.needs_probe("example.com"));
    }

    #[test]
    fn set_max_connections_limits_stable() {
        let mut cd = CapabilityDiscovery::new();
        let mut cap = HostCapabilities::default();
        cap.stable_connections = 8;
        cd.update("example.com", cap);
        cd.set_max_connections("example.com", 2);
        let updated = cd.get_or_default("example.com");
        assert_eq!(updated.max_connections, 2);
        assert_eq!(updated.stable_connections, 2);
    }

    #[test]
    fn update_throughput_adjusts_stable() {
        let mut cd = CapabilityDiscovery::new();
        cd.update("example.com", HostCapabilities::default());
        cd.update_throughput("example.com", 10_000_000, 2_500_000);
        let cap = cd.get_or_default("example.com");
        assert_eq!(cap.measured_throughput, 10_000_000);
        assert_eq!(cap.per_connection_ceiling, 2_500_000);
        assert_eq!(cap.stable_connections, 4);
    }

    #[test]
    fn multiplexed_sets_stable_to_1() {
        let mut cd = CapabilityDiscovery::new();
        cd.update("example.com", HostCapabilities::default());
        cd.set_multiplexed("example.com", true);
        let cap = cd.get_or_default("example.com");
        assert!(cap.multiplexed);
        assert_eq!(cap.stable_connections, 1);
    }

    #[test]
    fn no_range_sets_max_connections_to_1() {
        let mut cd = CapabilityDiscovery::new();
        let mut cap = HostCapabilities::default();
        cap.supports_range = false;
        cd.update("example.com", cap);
        let result = cd.get_or_default("example.com");
        assert_eq!(result.max_connections, 1);
    }

    #[test]
    fn hosts_needing_probe_lists_stale() {
        let mut cd = CapabilityDiscovery::new();
        cd.update("a.com", HostCapabilities::default());
        cd.update("b.com", HostCapabilities::default());
        let needing = cd.hosts_needing_probe();
        assert_eq!(needing.len(), 0);
    }
}
