use std::collections::HashSet;
use std::net::SocketAddr;

use nova_torrent_core::{
    MagnetLink, TorrentMetainfo, TrackerAnnounceRequest, TrackerEvent,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::daemon::native_torrent::TrackerTransport;
use crate::daemon::torrent_dht::DhtEngine;
use crate::daemon::torrent_peer::{generate_peer_id, PeerEngine, PeerMetadataResult};

#[derive(Clone, Debug)]
pub struct MagnetResolverConfig {
    pub announce_port: u16,
    pub max_tracker_queries: usize,
    pub max_candidate_peers: usize,
    pub enable_dht: bool,
    /// Disabled by default to avoid leaking the info-hash of a potentially
    /// private torrent before its BEP 9 metadata reveals the private flag.
    pub dht_fallback_with_trackers: bool,
}

impl Default for MagnetResolverConfig {
    fn default() -> Self {
        Self {
            announce_port: 6881,
            max_tracker_queries: 8,
            max_candidate_peers: 512,
            enable_dht: true,
            dht_fallback_with_trackers: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MagnetResolution {
    pub metainfo: TorrentMetainfo,
    pub local_peer_id: [u8; 20],
    pub metadata_peer: SocketAddr,
    pub tracker_peers: Vec<SocketAddr>,
    pub dht_peers: Vec<SocketAddr>,
    pub pex_peers: Vec<SocketAddr>,
    pub used_dht: bool,
}

#[derive(Clone, Debug)]
pub struct MagnetResolver {
    tracker: TrackerTransport,
    dht: DhtEngine,
    peers: PeerEngine,
    config: MagnetResolverConfig,
}

impl MagnetResolver {
    pub fn new(
        tracker: TrackerTransport,
        dht: DhtEngine,
        peers: PeerEngine,
        config: MagnetResolverConfig,
    ) -> Self {
        Self {
            tracker,
            dht,
            peers,
            config,
        }
    }

    pub fn production_default() -> Self {
        Self::new(
            TrackerTransport::production_default(),
            DhtEngine::production_default(),
            PeerEngine::production_default(),
            MagnetResolverConfig::default(),
        )
    }

    pub async fn resolve_uri(
        &self,
        magnet_uri: &str,
        cancel: &CancellationToken,
    ) -> Result<MagnetResolution, String> {
        let magnet = MagnetLink::parse(magnet_uri)
            .map_err(|error| format!("Invalid magnet URI: {error}"))?;
        self.resolve_link(&magnet, cancel).await
    }

    pub async fn resolve_link(
        &self,
        magnet: &MagnetLink,
        cancel: &CancellationToken,
    ) -> Result<MagnetResolution, String> {
        if self.config.announce_port == 0 {
            return Err("Magnet resolver announce port cannot be zero".to_owned());
        }

        let local_peer_id = generate_peer_id();
        let tracker_peers = self
            .discover_tracker_peers(magnet, local_peer_id, cancel)
            .await;

        if !tracker_peers.is_empty() {
            match self
                .peers
                .fetch_metadata_from_candidates(
                    &tracker_peers,
                    magnet.info_hash,
                    &magnet.trackers,
                    local_peer_id,
                    cancel,
                )
                .await
            {
                Ok(metadata) => {
                    return Ok(build_resolution(
                        metadata,
                        local_peer_id,
                        tracker_peers,
                        Vec::new(),
                        false,
                    ));
                }
                Err(tracker_metadata_error)
                    if !self.config.enable_dht
                        || !self.config.dht_fallback_with_trackers =>
                {
                    return Err(format!(
                        "Tracker peers were found but metadata exchange failed: {tracker_metadata_error}"
                    ));
                }
                Err(_) => {}
            }
        }

        if !self.config.enable_dht {
            if magnet.trackers.is_empty() {
                return Err("Trackerless magnet requires DHT, but DHT is disabled".to_owned());
            }
            return Err("No usable tracker peers were found for magnet metadata".to_owned());
        }

        if !magnet.trackers.is_empty() && !self.config.dht_fallback_with_trackers {
            return Err(
                "No usable tracker peers were found; DHT fallback is disabled while torrent privacy is unknown"
                    .to_owned(),
            );
        }

        let dht = self
            .dht
            .discover_peers(magnet.info_hash, cancel)
            .await
            .map_err(|error| format!("DHT peer discovery failed: {error}"))?;
        let dht_peers = bounded_unique(dht.peers, self.config.max_candidate_peers);
        if dht_peers.is_empty() {
            return Err("DHT discovery returned no peers for magnet metadata".to_owned());
        }

        let metadata = self
            .peers
            .fetch_metadata_from_candidates(
                &dht_peers,
                magnet.info_hash,
                &magnet.trackers,
                local_peer_id,
                cancel,
            )
            .await
            .map_err(|error| format!("DHT peers could not provide magnet metadata: {error}"))?;

        Ok(build_resolution(
            metadata,
            local_peer_id,
            tracker_peers,
            dht_peers,
            true,
        ))
    }

    async fn discover_tracker_peers(
        &self,
        magnet: &MagnetLink,
        local_peer_id: [u8; 20],
        cancel: &CancellationToken,
    ) -> Vec<SocketAddr> {
        if magnet.trackers.is_empty() || self.config.max_tracker_queries == 0 {
            return Vec::new();
        }

        let request = TrackerAnnounceRequest {
            info_hash: magnet.info_hash,
            peer_id: local_peer_id,
            port: self.config.announce_port,
            uploaded: 0,
            downloaded: 0,
            // Before BEP 9 metadata is available, exact remaining bytes are
            // unknown. xl is used when the magnet provides it; otherwise zero
            // is used only for peer discovery and not persisted as task state.
            left: magnet.exact_length.unwrap_or(0),
            event: TrackerEvent::None,
            key: tracker_key(),
            num_want: Some(200),
        };

        let mut tasks = JoinSet::new();
        for tracker_url in magnet
            .trackers
            .iter()
            .take(self.config.max_tracker_queries.min(32))
        {
            let transport = self.tracker.clone();
            let url = tracker_url.clone();
            let request = request.clone();
            let child = cancel.child_token();
            tasks.spawn(async move {
                tokio::select! {
                    _ = child.cancelled() => None,
                    result = transport.announce_tracker(&url, &request) => result.ok(),
                }
            });
        }

        let mut peers = HashSet::new();
        while let Some(joined) = tasks.join_next().await {
            if cancel.is_cancelled() {
                tasks.abort_all();
                break;
            }
            let Ok(Some(success)) = joined else {
                continue;
            };
            for peer in success.peers {
                peers.insert(peer.address);
                if peers.len() >= self.config.max_candidate_peers.max(1) {
                    tasks.abort_all();
                    break;
                }
            }
        }

        let mut peers = peers.into_iter().collect::<Vec<_>>();
        peers.sort_unstable();
        peers.truncate(self.config.max_candidate_peers.max(1));
        peers
    }
}

fn build_resolution(
    metadata: PeerMetadataResult,
    local_peer_id: [u8; 20],
    tracker_peers: Vec<SocketAddr>,
    dht_peers: Vec<SocketAddr>,
    used_dht: bool,
) -> MagnetResolution {
    let private = metadata.metainfo.private;
    MagnetResolution {
        metainfo: metadata.metainfo,
        local_peer_id,
        metadata_peer: metadata.address,
        tracker_peers,
        dht_peers: if private { Vec::new() } else { dht_peers },
        pex_peers: if private {
            Vec::new()
        } else {
            bounded_unique(metadata.pex_peers, 2_048)
        },
        used_dht,
    }
}

fn bounded_unique(peers: Vec<SocketAddr>, limit: usize) -> Vec<SocketAddr> {
    let mut unique = peers.into_iter().collect::<HashSet<_>>().into_iter().collect::<Vec<_>>();
    unique.sort_unstable();
    unique.truncate(limit.max(1));
    unique
}

fn tracker_key() -> u32 {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_resolution_discards_dht_and_pex_candidates() {
        let metadata = PeerMetadataResult {
            address: "1.1.1.1:6881".parse().unwrap(),
            peer_id: *b"-NVTEST-REMOTE-00001",
            metainfo: TorrentMetainfo {
                info_hash: nova_torrent_core::InfoHash::new([1u8; 20]),
                name: "private.bin".to_owned(),
                piece_length: 1,
                piece_hashes: vec![[2u8; 20]],
                files: vec![nova_torrent_core::TorrentFile {
                    path: "private.bin".to_owned(),
                    length: 1,
                    offset: 0,
                }],
                total_length: 1,
                trackers: Vec::new(),
                tracker_tiers: Vec::new(),
                private: true,
            },
            pex_peers: vec!["8.8.8.8:6881".parse().unwrap()],
        };

        let resolution = build_resolution(
            metadata,
            *b"-NV0001-123456789012",
            vec!["9.9.9.9:6881".parse().unwrap()],
            vec!["8.8.4.4:6881".parse().unwrap()],
            true,
        );
        assert!(resolution.metainfo.private);
        assert!(resolution.dht_peers.is_empty());
        assert!(resolution.pex_peers.is_empty());
    }

    #[test]
    fn bounded_unique_deduplicates_and_sorts() {
        let a = "8.8.8.8:1".parse().unwrap();
        let b = "1.1.1.1:2".parse().unwrap();
        assert_eq!(bounded_unique(vec![a, b, a], 10), vec![b, a]);
    }
}
