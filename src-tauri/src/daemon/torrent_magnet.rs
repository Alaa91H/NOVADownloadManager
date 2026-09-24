use std::collections::HashSet;
use std::net::SocketAddr;

use nova_torrent_core::{
    InfoHash, MagnetLink, TorrentMetainfo, TrackerAnnounceRequest, TrackerEvent,
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
    pub metadata_peer: Option<SocketAddr>,
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
            .discover_tracker_peers(
                magnet.info_hash,
                &magnet.trackers,
                magnet.exact_length.unwrap_or(0),
                local_peer_id,
                cancel,
            )
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

    /// Discover peers for metainfo that is already trusted locally (for
    /// example, a user-selected .torrent file or a restored storage manifest).
    ///
    /// Unlike magnet resolution this path never asks a peer to supply metadata:
    /// the exact info dictionary and piece hashes are already known. That keeps
    /// .torrent imports usable with peers that do not implement BEP 9 and also
    /// lets restart recovery reuse NOVA's durable metainfo safely.
    pub async fn discover_metainfo(
        &self,
        metainfo: TorrentMetainfo,
        cancel: &CancellationToken,
    ) -> Result<MagnetResolution, String> {
        if self.config.announce_port == 0 {
            return Err("Torrent resolver announce port cannot be zero".to_owned());
        }

        let local_peer_id = generate_peer_id();
        let tracker_peers = self
            .discover_tracker_peers(
                metainfo.info_hash,
                &metainfo.trackers,
                metainfo.total_length,
                local_peer_id,
                cancel,
            )
            .await;

        let mut dht_peers = Vec::new();
        let mut used_dht = false;
        if tracker_peers.is_empty() && !metainfo.private && self.config.enable_dht {
            if let Ok(discovery) = self.dht.discover_peers(metainfo.info_hash, cancel).await {
                dht_peers = bounded_unique(discovery.peers, self.config.max_candidate_peers);
                used_dht = !dht_peers.is_empty();
            }
        }

        Ok(MagnetResolution {
            metainfo,
            local_peer_id,
            metadata_peer: None,
            tracker_peers,
            dht_peers,
            pex_peers: Vec::new(),
            used_dht,
        })
    }

    async fn discover_tracker_peers(
        &self,
        info_hash: InfoHash,
        trackers: &[String],
        left: u64,
        local_peer_id: [u8; 20],
        cancel: &CancellationToken,
    ) -> Vec<SocketAddr> {
        if trackers.is_empty() || self.config.max_tracker_queries == 0 {
            return Vec::new();
        }

        let request = TrackerAnnounceRequest {
            info_hash,
            peer_id: local_peer_id,
            port: self.config.announce_port,
            uploaded: 0,
            downloaded: 0,
            left,
            event: TrackerEvent::None,
            key: tracker_key(),
            num_want: Some(200),
        };

        let mut tasks = JoinSet::new();
        for tracker_url in trackers
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
        metadata_peer: Some(metadata.address),
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

    #[tokio::test]
    async fn trackerless_magnet_resolves_through_dht_and_bep9_peer() {
        use crate::daemon::torrent_dht::DhtConfig;
        use crate::daemon::torrent_peer::{
            read_peer_frame, PeerEngineConfig, PeerSessionConfig,
        };
        use nova_torrent_core::{
            DhtMessage, DhtNodeId, DhtQuery, DhtResponse, ExtendedHandshake,
            MetadataMessage, PeerHandshake, PeerMessage, EXTENSION_HANDSHAKE_ID,
            LOCAL_UT_METADATA_ID, MAX_DHT_PACKET_BYTES, PEER_HANDSHAKE_LEN,
        };
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, UdpSocket};

        let mut info =
            b"d6:lengthi8e4:name9:piece.bin12:piece lengthi8e6:pieces20:".to_vec();
        info.extend_from_slice(&[
            0x42, 0x5a, 0xf1, 0x2a, 0x07, 0x43, 0x50, 0x2b, 0x32, 0x2e,
            0x93, 0xa0, 0x15, 0xbc, 0xf8, 0x68, 0xe3, 0x24, 0xd5, 0x6a,
        ]);
        info.push(b'e');
        let expected = TorrentMetainfo::from_info_bytes(&info, &[]).unwrap();
        let info_hash = expected.info_hash;

        let peer_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let peer_address = peer_listener.local_addr().unwrap();
        let peer_info = info.clone();
        let peer_task = tokio::spawn(async move {
            let (mut stream, _) = peer_listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();
            let client = PeerHandshake::decode(&handshake).unwrap();
            assert_eq!(client.info_hash, info_hash);
            assert!(client.supports_extension_protocol());

            let mut remote =
                PeerHandshake::new(info_hash, *b"-NVTEST-REMOTE-00001");
            remote.reserved[5] |= 0x10;
            stream.write_all(&remote.encode()).await.unwrap();

            let extended = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert!(matches!(
                extended,
                PeerMessage::Extended {
                    extension_id: EXTENSION_HANDSHAKE_ID,
                    ..
                }
            ));

            let remote_caps = ExtendedHandshake {
                ut_metadata: Some(3),
                ut_pex: None,
                metadata_size: Some(peer_info.len()),
                request_queue: Some(4),
                client_name: Some("resolver-test".to_owned()),
            };
            stream
                .write_all(
                    &PeerMessage::Extended {
                        extension_id: EXTENSION_HANDSHAKE_ID,
                        payload: remote_caps.encode().unwrap(),
                    }
                    .encode()
                    .unwrap(),
                )
                .await
                .unwrap();

            let request = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let PeerMessage::Extended {
                extension_id: 3,
                payload,
            } = request
            else {
                panic!("expected metadata request");
            };
            assert_eq!(
                MetadataMessage::parse(&payload).unwrap(),
                MetadataMessage::Request { piece: 0 }
            );

            stream
                .write_all(
                    &PeerMessage::Extended {
                        extension_id: LOCAL_UT_METADATA_ID,
                        payload: MetadataMessage::Data {
                            piece: 0,
                            total_size: peer_info.len(),
                            data: peer_info,
                        }
                        .encode()
                        .unwrap(),
                    }
                    .encode()
                    .unwrap(),
                )
                .await
                .unwrap();
        });

        let dht_socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let dht_address = dht_socket.local_addr().unwrap();
        let dht_task = tokio::spawn(async move {
            let mut buffer = vec![0u8; MAX_DHT_PACKET_BYTES];
            let (length, source) = dht_socket.recv_from(&mut buffer).await.unwrap();
            buffer.truncate(length);
            let request = DhtMessage::parse(&buffer).unwrap();
            let DhtMessage::Query {
                transaction_id,
                query: DhtQuery::GetPeers {
                    info_hash: requested,
                    ..
                },
            } = request
            else {
                panic!("expected DHT get_peers");
            };
            assert_eq!(requested, info_hash);
            let response = DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: DhtNodeId::new([4u8; 20]),
                    token: Some(vec![1, 2, 3]),
                    nodes: Vec::new(),
                    peers: vec![peer_address],
                },
            };
            dht_socket
                .send_to(&response.encode().unwrap(), source)
                .await
                .unwrap();
        });

        let dht = DhtEngine::for_tests(
            DhtNodeId::new([7u8; 20]),
            DhtConfig {
                bootstrap: vec![dht_address.to_string()],
                query_timeout: Duration::from_secs(2),
                bootstrap_timeout: Duration::from_secs(2),
                alpha: 1,
                max_queries: 2,
                max_candidates: 8,
                max_peers: 8,
            },
        );
        let peers = PeerEngine::for_tests(PeerEngineConfig {
            session: PeerSessionConfig {
                connect_timeout: Duration::from_secs(2),
                handshake_timeout: Duration::from_secs(2),
                frame_timeout: Duration::from_secs(2),
                block_timeout: Duration::from_secs(2),
                metadata_timeout: Duration::from_secs(2),
                pipeline_depth: 2,
                metadata_pipeline_depth: 2,
                max_block_retries: 1,
                max_metadata_retries: 1,
                max_control_frames_without_progress: 32,
                enable_pex: true,
            },
            max_outbound_connections: 4,
            download_rate_limit_bytes_per_sec: None,
        });
        let resolver = MagnetResolver::new(
            TrackerTransport::production_default(),
            dht,
            peers,
            MagnetResolverConfig {
                announce_port: 6881,
                max_tracker_queries: 0,
                max_candidate_peers: 16,
                enable_dht: true,
                dht_fallback_with_trackers: false,
            },
        );

        let uri = format!("magnet:?xt=urn:btih:{}", info_hash.to_hex());
        let result = resolver
            .resolve_uri(&uri, &CancellationToken::new())
            .await
            .expect("resolve trackerless magnet");

        assert!(result.used_dht);
        assert_eq!(result.metainfo.info_hash, info_hash);
        assert_eq!(result.metainfo.name, "piece.bin");
        assert_eq!(result.metadata_peer, Some(peer_address));
        assert_eq!(result.dht_peers, vec![peer_address]);
        dht_task.await.unwrap();
        peer_task.await.unwrap();
    }

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
