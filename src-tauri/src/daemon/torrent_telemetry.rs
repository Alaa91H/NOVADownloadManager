use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const MAX_PEER_TELEMETRY_ENTRIES: usize = 256;
const MAX_TRACKER_TELEMETRY_ENTRIES: usize = 64;
const MAX_TELEMETRY_ERROR_CHARS: usize = 240;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentPeerTelemetryView {
    pub address: String,
    pub direction: String,
    pub state: String,
    pub downloaded_bytes: u64,
    pub uploaded_bytes: u64,
    pub successful_pieces: u32,
    pub failures: u32,
    pub supports_extensions: Option<bool>,
    pub supports_dht: Option<bool>,
    pub last_error: Option<String>,
    pub last_update_unix: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentTrackerTelemetryView {
    pub endpoint: String,
    pub state: String,
    pub last_event: String,
    pub peer_count: usize,
    pub seeders: Option<u32>,
    pub leechers: Option<u32>,
    pub interval_seconds: Option<u32>,
    pub last_error: Option<String>,
    pub last_update_unix: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentSwarmTelemetrySnapshot {
    pub peers: Vec<TorrentPeerTelemetryView>,
    pub trackers: Vec<TorrentTrackerTelemetryView>,
}

#[derive(Clone, Debug)]
struct PeerRecord {
    address: SocketAddr,
    direction: &'static str,
    state: &'static str,
    downloaded_bytes: u64,
    uploaded_bytes: u64,
    successful_pieces: u32,
    failures: u32,
    supports_extensions: Option<bool>,
    supports_dht: Option<bool>,
    last_error: Option<String>,
    last_update_unix: u64,
}

impl PeerRecord {
    fn new(address: SocketAddr, direction: &'static str) -> Self {
        Self {
            address,
            direction,
            state: "connecting",
            downloaded_bytes: 0,
            uploaded_bytes: 0,
            successful_pieces: 0,
            failures: 0,
            supports_extensions: None,
            supports_dht: None,
            last_error: None,
            last_update_unix: unix_now(),
        }
    }

    fn view(&self) -> TorrentPeerTelemetryView {
        TorrentPeerTelemetryView {
            address: self.address.to_string(),
            direction: self.direction.to_owned(),
            state: self.state.to_owned(),
            downloaded_bytes: self.downloaded_bytes,
            uploaded_bytes: self.uploaded_bytes,
            successful_pieces: self.successful_pieces,
            failures: self.failures,
            supports_extensions: self.supports_extensions,
            supports_dht: self.supports_dht,
            last_error: self.last_error.clone(),
            last_update_unix: self.last_update_unix,
        }
    }
}

#[derive(Clone, Debug)]
struct TrackerRecord {
    endpoint: String,
    state: &'static str,
    last_event: String,
    peer_count: usize,
    seeders: Option<u32>,
    leechers: Option<u32>,
    interval_seconds: Option<u32>,
    last_error: Option<String>,
    last_update_unix: u64,
}

impl TrackerRecord {
    fn new(endpoint: String) -> Self {
        Self {
            endpoint,
            state: "idle",
            last_event: "none".to_owned(),
            peer_count: 0,
            seeders: None,
            leechers: None,
            interval_seconds: None,
            last_error: None,
            last_update_unix: unix_now(),
        }
    }

    fn view(&self) -> TorrentTrackerTelemetryView {
        TorrentTrackerTelemetryView {
            endpoint: self.endpoint.clone(),
            state: self.state.to_owned(),
            last_event: self.last_event.clone(),
            peer_count: self.peer_count,
            seeders: self.seeders,
            leechers: self.leechers,
            interval_seconds: self.interval_seconds,
            last_error: self.last_error.clone(),
            last_update_unix: self.last_update_unix,
        }
    }
}

#[derive(Debug, Default)]
struct TelemetryState {
    peers: VecDeque<PeerRecord>,
    trackers: VecDeque<TrackerRecord>,
}

#[derive(Clone, Debug, Default)]
pub struct TorrentSwarmTelemetry {
    inner: Arc<Mutex<TelemetryState>>,
}

impl TorrentSwarmTelemetry {
    pub fn peer_connecting(&self, address: SocketAddr) {
        self.update_peer(address, "outbound", |peer| {
            peer.state = "connecting";
            peer.last_error = None;
        });
    }

    pub fn peer_connected(
        &self,
        address: SocketAddr,
        supports_extensions: bool,
        supports_dht: bool,
    ) {
        self.update_peer(address, "outbound", |peer| {
            peer.state = "connected";
            peer.supports_extensions = Some(supports_extensions);
            peer.supports_dht = Some(supports_dht);
            peer.last_error = None;
        });
    }

    pub fn peer_piece_success(&self, address: SocketAddr, bytes: u64) {
        self.update_peer(address, "outbound", |peer| {
            peer.state = "received";
            peer.downloaded_bytes = peer.downloaded_bytes.saturating_add(bytes);
            peer.successful_pieces = peer.successful_pieces.saturating_add(1);
            peer.last_error = None;
        });
    }

    pub fn peer_failure(&self, address: SocketAddr, error: &str) {
        self.update_peer(address, "outbound", |peer| {
            peer.state = "failed";
            peer.failures = peer.failures.saturating_add(1);
            peer.last_error = Some(limit_error(error));
        });
    }

    pub fn inbound_peer_connected(
        &self,
        address: SocketAddr,
        supports_extensions: bool,
        supports_dht: bool,
    ) {
        self.update_peer(address, "inbound", |peer| {
            peer.state = "uploading";
            peer.supports_extensions = Some(supports_extensions);
            peer.supports_dht = Some(supports_dht);
            peer.last_error = None;
        });
    }

    pub fn inbound_peer_finished(&self, address: SocketAddr, uploaded_bytes: u64) {
        self.update_peer(address, "inbound", |peer| {
            peer.state = "closed";
            peer.uploaded_bytes = peer.uploaded_bytes.saturating_add(uploaded_bytes);
            peer.last_error = None;
        });
    }

    pub fn inbound_peer_failed(&self, address: SocketAddr, error: &str) {
        self.update_peer(address, "inbound", |peer| {
            peer.state = "failed";
            peer.failures = peer.failures.saturating_add(1);
            peer.last_error = Some(limit_error(error));
        });
    }

    pub fn register_trackers<'a>(&self, trackers: impl IntoIterator<Item = &'a str>) {
        for tracker in trackers {
            let endpoint = tracker_endpoint(tracker);
            self.update_tracker(endpoint, |_| {});
        }
    }

    pub fn tracker_attempt<'a>(
        &self,
        trackers: impl IntoIterator<Item = &'a str>,
        event: &str,
    ) {
        for tracker in trackers {
            let endpoint = tracker_endpoint(tracker);
            self.update_tracker(endpoint, |record| {
                record.state = "announcing";
                record.last_event = event.to_owned();
                record.last_error = None;
            });
        }
    }

    pub fn tracker_success(
        &self,
        tracker: &str,
        event: &str,
        peer_count: usize,
        seeders: Option<u32>,
        leechers: Option<u32>,
        interval_seconds: u32,
    ) {
        let endpoint = tracker_endpoint(tracker);
        self.update_tracker(endpoint, |record| {
            record.state = "ok";
            record.last_event = event.to_owned();
            record.peer_count = peer_count;
            record.seeders = seeders;
            record.leechers = leechers;
            record.interval_seconds = Some(interval_seconds);
            record.last_error = None;
        });
    }

    pub fn tracker_failure<'a>(
        &self,
        trackers: impl IntoIterator<Item = &'a str>,
        event: &str,
        error: &str,
    ) {
        let error = limit_error(error);
        for tracker in trackers {
            let endpoint = tracker_endpoint(tracker);
            self.update_tracker(endpoint, |record| {
                record.state = "error";
                record.last_event = event.to_owned();
                record.last_error = Some(error.clone());
            });
        }
    }

    pub fn snapshot(&self) -> TorrentSwarmTelemetrySnapshot {
        let state = match self.inner.lock() {
            Ok(state) => state,
            Err(poison) => poison.into_inner(),
        };
        TorrentSwarmTelemetrySnapshot {
            peers: state.peers.iter().rev().map(PeerRecord::view).collect(),
            trackers: state.trackers.iter().rev().map(TrackerRecord::view).collect(),
        }
    }

    fn update_peer(
        &self,
        address: SocketAddr,
        direction: &'static str,
        update: impl FnOnce(&mut PeerRecord),
    ) {
        let mut state = match self.inner.lock() {
            Ok(state) => state,
            Err(poison) => poison.into_inner(),
        };
        let mut record = state
            .peers
            .iter()
            .position(|peer| peer.address == address && peer.direction == direction)
            .and_then(|position| state.peers.remove(position))
            .unwrap_or_else(|| PeerRecord::new(address, direction));
        update(&mut record);
        record.last_update_unix = unix_now();
        state.peers.push_back(record);
        while state.peers.len() > MAX_PEER_TELEMETRY_ENTRIES {
            state.peers.pop_front();
        }
    }

    fn update_tracker(&self, endpoint: String, update: impl FnOnce(&mut TrackerRecord)) {
        let mut state = match self.inner.lock() {
            Ok(state) => state,
            Err(poison) => poison.into_inner(),
        };
        let mut record = state
            .trackers
            .iter()
            .position(|tracker| tracker.endpoint == endpoint)
            .and_then(|position| state.trackers.remove(position))
            .unwrap_or_else(|| TrackerRecord::new(endpoint));
        update(&mut record);
        record.last_update_unix = unix_now();
        state.trackers.push_back(record);
        while state.trackers.len() > MAX_TRACKER_TELEMETRY_ENTRIES {
            state.trackers.pop_front();
        }
    }
}

fn tracker_endpoint(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.set_path("/");
            url.to_string()
        }
        Err(_) => "<invalid-tracker>".to_owned(),
    }
}

fn limit_error(value: &str) -> String {
    let mut output = value
        .chars()
        .take(MAX_TELEMETRY_ERROR_CHARS)
        .collect::<String>();
    if value.chars().count() > MAX_TELEMETRY_ERROR_CHARS {
        output.push_str("...");
    }
    output
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_telemetry_removes_credentials_and_path() {
        let telemetry = TorrentSwarmTelemetry::default();
        telemetry.register_trackers([
            "https://user:pass@tracker.example/private/passkey?token=secret#fragment",
        ]);
        let snapshot = telemetry.snapshot();
        assert_eq!(snapshot.trackers.len(), 1);
        assert_eq!(snapshot.trackers[0].endpoint, "https://tracker.example/");
        assert!(!snapshot.trackers[0].endpoint.contains("secret"));
        assert!(!snapshot.trackers[0].endpoint.contains("passkey"));
    }

    #[test]
    fn peer_telemetry_is_bounded() {
        let telemetry = TorrentSwarmTelemetry::default();
        for index in 0..400u16 {
            telemetry.peer_connecting(SocketAddr::from((
                [8, 8, (index / 250) as u8, (index % 250 + 1) as u8],
                1000 + index,
            )));
        }
        assert_eq!(telemetry.snapshot().peers.len(), MAX_PEER_TELEMETRY_ENTRIES);
    }
}
