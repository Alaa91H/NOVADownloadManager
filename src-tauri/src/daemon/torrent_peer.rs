use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use nova_torrent_core::{
    BlockRequest, ExtendedHandshake, InfoHash, MetadataAssembler, MetadataMessage, PeerExchange,
    PeerHandshake, PeerMessage, PeerState, PieceLayout, TorrentMetainfo, DEFAULT_BLOCK_SIZE,
    EXTENSION_HANDSHAKE_ID, LOCAL_UT_METADATA_ID, LOCAL_UT_PEX_ID, MAX_PEER_FRAME_BYTES,
    MAX_PEX_PEERS, PEER_HANDSHAKE_LEN,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::daemon::torrent_bandwidth::TorrentBandwidthLimiter;
use crate::daemon::utils::{is_internal_ip, private_network_allowed};

const MAX_PEER_CANDIDATES: usize = 4_096;
const MAX_METADATA_CANDIDATES: usize = 4_096;

#[derive(Clone, Debug)]
pub struct PeerSessionConfig {
    pub connect_timeout: Duration,
    pub handshake_timeout: Duration,
    pub frame_timeout: Duration,
    pub block_timeout: Duration,
    pub metadata_timeout: Duration,
    pub pipeline_depth: usize,
    pub metadata_pipeline_depth: usize,
    pub max_block_retries: u32,
    pub max_metadata_retries: u32,
    pub max_control_frames_without_progress: u32,
    pub enable_pex: bool,
}

impl Default for PeerSessionConfig {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(8),
            handshake_timeout: Duration::from_secs(8),
            frame_timeout: Duration::from_secs(30),
            block_timeout: Duration::from_secs(12),
            metadata_timeout: Duration::from_secs(10),
            pipeline_depth: 8,
            metadata_pipeline_depth: 8,
            max_block_retries: 2,
            max_metadata_retries: 2,
            max_control_frames_without_progress: 128,
            enable_pex: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerMetadataResult {
    pub address: SocketAddr,
    pub peer_id: [u8; 20],
    pub metainfo: TorrentMetainfo,
    pub pex_peers: Vec<SocketAddr>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerPieceResult {
    pub address: SocketAddr,
    pub peer_id: [u8; 20],
    pub piece_index: u32,
    pub bytes: Vec<u8>,
    pub elapsed: Duration,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PeerReputation {
    pub successful_pieces: u32,
    pub successful_bytes: u64,
    pub successful_metadata_exchanges: u32,
    pub connect_failures: u32,
    pub timeouts: u32,
    pub protocol_errors: u32,
    pub hash_failures: u32,
}

impl PeerReputation {
    pub fn record_success(&mut self, bytes: u64) {
        self.successful_pieces = self.successful_pieces.saturating_add(1);
        self.successful_bytes = self.successful_bytes.saturating_add(bytes);
        self.timeouts = self.timeouts.saturating_sub(1);
    }

    pub fn record_metadata_success(&mut self) {
        self.successful_metadata_exchanges =
            self.successful_metadata_exchanges.saturating_add(1);
        self.timeouts = self.timeouts.saturating_sub(1);
    }

    pub fn record_connect_failure(&mut self) {
        self.connect_failures = self.connect_failures.saturating_add(1);
    }

    pub fn record_timeout(&mut self) {
        self.timeouts = self.timeouts.saturating_add(1);
    }

    pub fn record_protocol_error(&mut self) {
        self.protocol_errors = self.protocol_errors.saturating_add(1);
    }

    pub fn record_hash_failure(&mut self) {
        self.hash_failures = self.hash_failures.saturating_add(1);
    }

    pub fn should_evict(&self) -> bool {
        self.hash_failures > 0
            || self.protocol_errors >= 2
            || self.timeouts >= 4
            || self.connect_failures >= 5
    }

    pub fn priority_score(&self) -> i64 {
        let successes = i64::from(self.successful_pieces) * 100
            + i64::from(self.successful_metadata_exchanges) * 50;
        let throughput_credit = (self.successful_bytes / (1024 * 1024)).min(100) as i64;
        let penalties = i64::from(self.connect_failures) * 5
            + i64::from(self.timeouts) * 20
            + i64::from(self.protocol_errors) * 50
            + i64::from(self.hash_failures) * 500;
        successes + throughput_credit - penalties
    }
}

#[derive(Clone, Debug, Default)]
pub struct PeerReputationBook {
    peers: HashMap<SocketAddr, PeerReputation>,
}

impl PeerReputationBook {
    pub fn get(&self, address: &SocketAddr) -> PeerReputation {
        self.peers.get(address).cloned().unwrap_or_default()
    }

    pub fn get_mut(&mut self, address: SocketAddr) -> &mut PeerReputation {
        self.peers.entry(address).or_default()
    }

    pub fn rank_candidates(&self, candidates: &[SocketAddr]) -> Vec<SocketAddr> {
        let mut ranked = candidates
            .iter()
            .copied()
            .filter(|address| !self.get(address).should_evict())
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            self.get(right)
                .priority_score()
                .cmp(&self.get(left).priority_score())
                .then_with(|| left.cmp(right))
        });
        ranked.dedup();
        ranked
    }
}

#[derive(Clone, Debug)]
pub struct PeerEngineConfig {
    pub session: PeerSessionConfig,
    pub max_outbound_connections: usize,
    /// Shared download ceiling across all peer sessions. None or zero means unlimited.
    pub download_rate_limit_bytes_per_sec: Option<u64>,
}

impl Default for PeerEngineConfig {
    fn default() -> Self {
        Self {
            session: PeerSessionConfig::default(),
            max_outbound_connections: 32,
            download_rate_limit_bytes_per_sec: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PeerEngine {
    config: PeerEngineConfig,
    reputation: Arc<Mutex<PeerReputationBook>>,
    connection_slots: Arc<Semaphore>,
    download_limiter: Option<Arc<TorrentBandwidthLimiter>>,
    allow_private_network: bool,
}

impl PeerEngine {
    pub fn new(config: PeerEngineConfig) -> Self {
        let limit = config.max_outbound_connections.max(1);
        let download_limiter = config
            .download_rate_limit_bytes_per_sec
            .filter(|rate| *rate > 0)
            .and_then(|rate| TorrentBandwidthLimiter::new(rate).ok())
            .map(Arc::new);
        Self {
            config,
            reputation: Arc::new(Mutex::new(PeerReputationBook::default())),
            connection_slots: Arc::new(Semaphore::new(limit)),
            download_limiter,
            allow_private_network: private_network_allowed(),
        }
    }

    pub fn production_default() -> Self {
        Self::new(PeerEngineConfig::default())
    }

    pub fn with_download_limiter(
        &self,
        limiter: Arc<TorrentBandwidthLimiter>,
    ) -> Self {
        let mut engine = self.clone();
        engine.download_limiter = Some(limiter);
        engine
    }


    pub async fn reputation(&self, address: SocketAddr) -> PeerReputation {
        self.reputation.lock().await.get(&address)
    }

    pub async fn ranked_candidates(&self, candidates: &[SocketAddr]) -> Vec<SocketAddr> {
        self.reputation.lock().await.rank_candidates(candidates)
    }

    /// Establish a bounded batch of outbound sessions. The semaphore makes
    /// the connection ceiling explicit even when this method is later called
    /// by multiple swarm tasks concurrently.
    pub async fn connect_candidates(
        &self,
        candidates: &[SocketAddr],
        info_hash: InfoHash,
        local_peer_id: [u8; 20],
        piece_count: u32,
        cancel: &CancellationToken,
    ) -> Vec<PeerSession> {
        let ranked = self.ranked_candidates(candidates).await;
        let limit = self.config.max_outbound_connections.max(1);
        let mut tasks = JoinSet::new();

        for address in ranked.into_iter().take(MAX_PEER_CANDIDATES) {
            let permit = self.connection_slots.clone();
            let config = self.config.session.clone();
            let allow_private_network = self.allow_private_network;
            let download_limiter = self.download_limiter.clone();
            let child_cancel = cancel.child_token();
            tasks.spawn(async move {
                let connection_permit = permit.acquire_owned().await.ok()?;
                let result = PeerSession::connect_with_policy(
                    address,
                    info_hash,
                    local_peer_id,
                    piece_count,
                    config,
                    allow_private_network,
                    &child_cancel,
                )
                .await
                .map(|mut session| {
                    session.attach_connection_permit(connection_permit);
                    if let Some(limiter) = download_limiter {
                        session.attach_download_limiter(limiter);
                    }
                    session
                });
                Some((address, result))
            });
        }

        let mut sessions = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if cancel.is_cancelled() {
                tasks.abort_all();
                break;
            }
            let Ok(Some((address, result))) = joined else {
                continue;
            };
            match result {
                Ok(session) => {
                    sessions.push(session);
                    if sessions.len() >= limit {
                        tasks.abort_all();
                        break;
                    }
                }
                Err(error) => {
                    self.record_failure(address, &error).await;
                }
            }
        }
        sessions
    }

    /// Try a verified piece against ranked peers one at a time. This avoids
    /// downloading the same piece from several peers while still giving the
    /// caller automatic failover and reputation updates.
    pub async fn download_piece_from_candidates(
        &self,
        candidates: &[SocketAddr],
        metainfo: &TorrentMetainfo,
        piece_index: u32,
        local_peer_id: [u8; 20],
        cancel: &CancellationToken,
    ) -> Result<PeerPieceResult, String> {
        let ranked = self.ranked_candidates(candidates).await;
        if ranked.is_empty() {
            return Err("No eligible torrent peers are available".to_owned());
        }

        let piece_count = u32::try_from(metainfo.piece_count())
            .map_err(|_| "Torrent piece count exceeds peer protocol range".to_owned())?;
        let mut failures = Vec::new();

        for address in ranked {
            if cancel.is_cancelled() {
                return Err("Torrent peer selection cancelled".to_owned());
            }

            let connection_permit = tokio::select! {
                _ = cancel.cancelled() => return Err("Torrent peer selection cancelled".to_owned()),
                permit = self.connection_slots.clone().acquire_owned() => {
                    permit.map_err(|_| "Torrent peer connection limiter is closed".to_owned())?
                }
            };

            let mut session_config = self.config.session.clone();
            if metainfo.private {
                session_config.enable_pex = false;
            }
            let mut session = match PeerSession::connect_with_policy(
                address,
                metainfo.info_hash,
                local_peer_id,
                piece_count,
                session_config,
                self.allow_private_network,
                cancel,
            )
            .await
            {
                Ok(mut session) => {
                    session.attach_connection_permit(connection_permit);
                    if let Some(limiter) = self.download_limiter.clone() {
                        session.attach_download_limiter(limiter);
                    }
                    session
                },
                Err(error) => {
                    self.record_failure(address, &error).await;
                    failures.push(format!("{address}: {}", limit_peer_error(&error)));
                    continue;
                }
            };

            match session.download_piece(metainfo, piece_index, cancel).await {
                Ok(result) => {
                    self.reputation
                        .lock()
                        .await
                        .get_mut(address)
                        .record_success(result.bytes.len() as u64);
                    return Ok(result);
                }
                Err(error) => {
                    self.record_failure(address, &error).await;
                    failures.push(format!("{address}: {}", limit_peer_error(&error)));
                }
            }
        }

        Err(format!(
            "All eligible peers failed for piece {piece_index}: {}",
            failures.join("; ")
        ))
    }

    pub async fn fetch_metadata_from_candidates(
        &self,
        candidates: &[SocketAddr],
        info_hash: InfoHash,
        trackers: &[String],
        local_peer_id: [u8; 20],
        cancel: &CancellationToken,
    ) -> Result<PeerMetadataResult, String> {
        let ranked = self.ranked_candidates(candidates).await;
        if ranked.is_empty() {
            return Err("No eligible torrent peers are available for metadata exchange".to_owned());
        }

        let mut queue = ranked
            .into_iter()
            .take(MAX_METADATA_CANDIDATES)
            .collect::<VecDeque<_>>();
        let mut seen = queue.iter().copied().collect::<HashSet<_>>();
        let mut failures = Vec::new();

        while let Some(address) = queue.pop_front() {
            if cancel.is_cancelled() {
                return Err("Magnet metadata peer selection cancelled".to_owned());
            }

            let connection_permit = tokio::select! {
                _ = cancel.cancelled() => return Err("Magnet metadata peer selection cancelled".to_owned()),
                permit = self.connection_slots.clone().acquire_owned() => {
                    permit.map_err(|_| "Torrent peer connection limiter is closed".to_owned())?
                }
            };

            let mut session_config = self.config.session.clone();
            if !trackers.is_empty() {
                session_config.enable_pex = false;
            }
            let mut session = match PeerSession::connect_with_policy(
                address,
                info_hash,
                local_peer_id,
                0,
                session_config,
                self.allow_private_network,
                cancel,
            )
            .await
            {
                Ok(mut session) => {
                    session.attach_connection_permit(connection_permit);
                    session
                }
                Err(error) => {
                    self.record_failure(address, &error).await;
                    failures.push(format!("{address}: {}", limit_peer_error(&error)));
                    continue;
                }
            };

            if !session.supports_extensions() {
                let error = format!("Peer {address} does not support BEP 10");
                self.record_failure(address, &error).await;
                failures.push(format!("{address}: {}", limit_peer_error(&error)));
                continue;
            }

            match session
                .fetch_metadata(info_hash, trackers, cancel)
                .await
            {
                Ok(result) => {
                    self.reputation
                        .lock()
                        .await
                        .get_mut(address)
                        .record_metadata_success();
                    return Ok(result);
                }
                Err(error) => {
                    for peer in session.take_discovered_pex_peers() {
                        if seen.len() >= MAX_METADATA_CANDIDATES {
                            break;
                        }
                        if seen.insert(peer) {
                            queue.push_back(peer);
                        }
                    }
                    self.record_failure(address, &error).await;
                    failures.push(format!("{address}: {}", limit_peer_error(&error)));
                }
            }
        }

        Err(format!(
            "All eligible peers failed magnet metadata exchange: {}",
            failures.join("; ")
        ))
    }

    #[cfg(test)]
    pub(crate) fn for_tests(config: PeerEngineConfig) -> Self {
        let limit = config.max_outbound_connections.max(1);
        let download_limiter = config
            .download_rate_limit_bytes_per_sec
            .filter(|rate| *rate > 0)
            .and_then(|rate| TorrentBandwidthLimiter::new(rate).ok())
            .map(Arc::new);
        Self {
            config,
            reputation: Arc::new(Mutex::new(PeerReputationBook::default())),
            connection_slots: Arc::new(Semaphore::new(limit)),
            download_limiter,
            allow_private_network: true,
        }
    }

    async fn record_failure(&self, address: SocketAddr, error: &str) {
        let mut book = self.reputation.lock().await;
        let reputation = book.get_mut(address);
        if error.contains("SHA-1 verification")
            || error.contains("metadata SHA-1")
            || error.contains("hash mismatch")
        {
            reputation.record_hash_failure();
        } else if error.contains("timed out")
            || error.contains("too long")
            || error.contains("exhausted retries")
        {
            reputation.record_timeout();
        } else if error.contains("protocol")
            || error.contains("unsolicited")
            || error.contains("wrong torrent info hash")
            || error.contains("invalid handshake")
            || error.contains("out of range")
        {
            reputation.record_protocol_error();
        } else {
            reputation.record_connect_failure();
        }
    }
}

pub fn generate_peer_id() -> [u8; 20] {
    let mut peer_id = [0u8; 20];
    peer_id[..8].copy_from_slice(b"-NV0001-");
    let random = uuid::Uuid::new_v4().simple().to_string();
    peer_id[8..].copy_from_slice(&random.as_bytes()[..12]);
    peer_id
}

fn limit_peer_error(error: &str) -> String {
    const LIMIT: usize = 256;
    let mut output = error.chars().take(LIMIT).collect::<String>();
    if error.chars().count() > LIMIT {
        output.push_str("...");
    }
    output
}

#[derive(Debug)]
pub struct PeerSession {
    address: SocketAddr,
    _connection_permit: Option<OwnedSemaphorePermit>,
    download_limiter: Option<Arc<TorrentBandwidthLimiter>>,
    remote_peer_id: [u8; 20],
    remote_supports_extensions: bool,
    remote_supports_dht: bool,
    remote_extensions: Option<ExtendedHandshake>,
    discovered_pex_peers: VecDeque<SocketAddr>,
    state: PeerState,
    stream: TcpStream,
    config: PeerSessionConfig,
    allow_private_network: bool,
}

impl PeerSession {
    pub async fn connect(
        address: SocketAddr,
        info_hash: InfoHash,
        local_peer_id: [u8; 20],
        piece_count: u32,
        config: PeerSessionConfig,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        Self::connect_with_policy(
            address,
            info_hash,
            local_peer_id,
            piece_count,
            config,
            private_network_allowed(),
            cancel,
        )
        .await
    }

    async fn connect_with_policy(
        address: SocketAddr,
        info_hash: InfoHash,
        local_peer_id: [u8; 20],
        piece_count: u32,
        config: PeerSessionConfig,
        allow_private_network: bool,
        cancel: &CancellationToken,
    ) -> Result<Self, String> {
        if address.port() == 0 {
            return Err("Peer address uses port 0".to_owned());
        }
        if is_internal_ip(address.ip()) && !allow_private_network {
            return Err(format!(
                "Blocked peer connection to internal IP {}",
                address.ip()
            ));
        }

        let mut stream = tokio::select! {
            _ = cancel.cancelled() => return Err("Peer connection cancelled".to_owned()),
            result = timeout(config.connect_timeout, TcpStream::connect(address)) => {
                result
                    .map_err(|_| format!("Timed out connecting to peer {address}"))?
                    .map_err(|error| format!("Could not connect to peer {address}: {error}"))?
            }
        };
        let _ = stream.set_nodelay(true);

        let mut local_handshake = PeerHandshake::new(info_hash, local_peer_id);
        // BEP 10 is now implemented end-to-end for ut_metadata and ut_pex.
        local_handshake.reserved[5] |= 0x10;

        write_all_cancellable(
            &mut stream,
            &local_handshake.encode(),
            config.handshake_timeout,
            cancel,
            "peer handshake",
        )
        .await?;

        let mut remote_bytes = [0u8; PEER_HANDSHAKE_LEN];
        read_exact_cancellable(
            &mut stream,
            &mut remote_bytes,
            config.handshake_timeout,
            cancel,
            "peer handshake",
        )
        .await?;
        let remote = PeerHandshake::decode(&remote_bytes)
            .map_err(|error| format!("Peer {address} sent an invalid handshake: {error}"))?;

        if remote.info_hash != info_hash {
            return Err(format!("Peer {address} returned the wrong torrent info hash"));
        }
        if remote.peer_id == local_peer_id {
            return Err(format!("Peer {address} returned our own peer id"));
        }

        let remote_supports_extensions = remote.supports_extension_protocol();
        let mut session = Self {
            address,
            _connection_permit: None,
            download_limiter: None,
            remote_peer_id: remote.peer_id,
            remote_supports_extensions,
            remote_supports_dht: remote.supports_dht_port(),
            remote_extensions: None,
            discovered_pex_peers: VecDeque::new(),
            state: PeerState::new(piece_count),
            stream,
            config,
            allow_private_network,
        };

        if remote_supports_extensions {
            let mut local_extensions = ExtendedHandshake::local(None);
            if !session.config.enable_pex {
                local_extensions.ut_pex = None;
            }
            let payload = local_extensions
                .encode()
                .map_err(|error| format!("Could not encode local extended handshake: {error}"))?;
            session
                .send(
                    &PeerMessage::Extended {
                        extension_id: EXTENSION_HANDSHAKE_ID,
                        payload,
                    },
                    cancel,
                )
                .await?;
        }

        Ok(session)
    }

    fn attach_connection_permit(&mut self, permit: OwnedSemaphorePermit) {
        self._connection_permit = Some(permit);
    }

    fn attach_download_limiter(&mut self, limiter: Arc<TorrentBandwidthLimiter>) {
        self.download_limiter = Some(limiter);
    }


    pub const fn address(&self) -> SocketAddr {
        self.address
    }

    pub const fn remote_peer_id(&self) -> &[u8; 20] {
        &self.remote_peer_id
    }

    pub const fn supports_extensions(&self) -> bool {
        self.remote_supports_extensions
    }

    pub const fn supports_dht(&self) -> bool {
        self.remote_supports_dht
    }

    pub fn state(&self) -> &PeerState {
        &self.state
    }

    pub fn remote_extensions(&self) -> Option<&ExtendedHandshake> {
        self.remote_extensions.as_ref()
    }

    pub fn take_discovered_pex_peers(&mut self) -> Vec<SocketAddr> {
        self.discovered_pex_peers.drain(..).collect()
    }


    pub async fn send(&mut self, message: &PeerMessage, cancel: &CancellationToken) -> Result<(), String> {
        let encoded = message
            .encode()
            .map_err(|error| format!("Could not encode peer message: {error}"))?;
        write_all_cancellable(
            &mut self.stream,
            &encoded,
            self.config.frame_timeout,
            cancel,
            "peer message",
        )
        .await
    }

    pub async fn receive(&mut self, cancel: &CancellationToken) -> Result<PeerMessage, String> {
        let message = read_peer_frame(
            &mut self.stream,
            self.config.frame_timeout,
            cancel,
        )
        .await?;
        self.state
            .apply(&message)
            .map_err(|error| format!("Peer {} protocol state error: {error}", self.address))?;

        if let PeerMessage::Extended {
            extension_id,
            payload,
        } = &message
        {
            if *extension_id == EXTENSION_HANDSHAKE_ID {
                let handshake = ExtendedHandshake::parse(payload)
                    .map_err(|error| format!("Peer {} sent invalid extended handshake: {error}", self.address))?;
                self.remote_extensions = Some(handshake);
            } else if *extension_id == LOCAL_UT_PEX_ID && self.config.enable_pex {
                let pex = PeerExchange::parse(payload)
                    .map_err(|error| format!("Peer {} sent invalid ut_pex payload: {error}", self.address))?;
                for peer in pex.added {
                    if self.discovered_pex_peers.len() >= MAX_PEX_PEERS {
                        break;
                    }
                    if peer.port() == 0
                        || (is_internal_ip(peer.ip()) && !self.allow_private_network)
                        || self.discovered_pex_peers.contains(&peer)
                    {
                        continue;
                    }
                    self.discovered_pex_peers.push_back(peer);
                }
            }
        }

        Ok(message)
    }

    pub async fn fetch_metadata(
        &mut self,
        info_hash: InfoHash,
        trackers: &[String],
        cancel: &CancellationToken,
    ) -> Result<PeerMetadataResult, String> {
        if !self.remote_supports_extensions {
            return Err(format!(
                "Peer {} does not support BEP 10 extended messaging",
                self.address
            ));
        }

        let remote = timeout(
            self.config.metadata_timeout,
            self.wait_for_extended_handshake(cancel),
        )
        .await
        .map_err(|_| format!(
            "Peer {} timed out before providing an extended handshake",
            self.address
        ))??;
        let remote_metadata_id = remote.ut_metadata.ok_or_else(|| {
            format!("Peer {} does not advertise ut_metadata", self.address)
        })?;
        let total_size = remote.metadata_size.ok_or_else(|| {
            format!("Peer {} did not advertise metadata_size", self.address)
        })?;

        let mut assembler = MetadataAssembler::new(info_hash, total_size)
            .map_err(|error| format!("Invalid metadata geometry from peer {}: {error}", self.address))?;
        let mut pending = VecDeque::from(
            (0..assembler.piece_count())
                .map(|piece| piece as u32)
                .collect::<Vec<_>>(),
        );
        let mut outstanding = BTreeMap::<u32, MetadataOutstanding>::new();
        let remote_reqq = remote
            .request_queue
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(self.config.metadata_pipeline_depth);
        let pipeline_depth = self
            .config
            .metadata_pipeline_depth
            .max(1)
            .min(remote_reqq.max(1))
            .min(32);
        let mut control_frames_without_progress = 0u32;

        while !assembler.is_complete() {
            self.fill_metadata_pipeline(
                remote_metadata_id,
                pipeline_depth,
                &mut pending,
                &mut outstanding,
                cancel,
            )
            .await?;

            let frame = tokio::select! {
                _ = cancel.cancelled() => return Err("Magnet metadata download cancelled".to_owned()),
                result = timeout(self.config.metadata_timeout, self.receive(cancel)) => result,
            };

            let message = match frame {
                Ok(result) => result?,
                Err(_) => {
                    self.retry_oldest_metadata_request(
                        remote_metadata_id,
                        &mut outstanding,
                        cancel,
                    )
                    .await?;
                    continue;
                }
            };

            match message {
                PeerMessage::Extended {
                    extension_id,
                    payload,
                } if extension_id == LOCAL_UT_METADATA_ID => {
                    match MetadataMessage::parse(&payload)
                        .map_err(|error| format!("Peer {} sent invalid ut_metadata payload: {error}", self.address))?
                    {
                        MetadataMessage::Data {
                            piece,
                            total_size,
                            data,
                        } => {
                            if outstanding.remove(&piece).is_none() && !assembler.has_piece(piece) {
                                return Err(format!(
                                    "Peer {} sent unsolicited metadata piece {}",
                                    self.address, piece
                                ));
                            }
                            let complete = assembler
                                .insert(piece, total_size, data)
                                .map_err(|error| format!(
                                    "Peer {} metadata assembly failed: {error}",
                                    self.address
                                ))?;
                            control_frames_without_progress = 0;
                            if complete {
                                break;
                            }
                        }
                        MetadataMessage::Reject { piece } => {
                            outstanding.remove(&piece);
                            return Err(format!(
                                "Peer {} rejected metadata piece {}",
                                self.address, piece
                            ));
                        }
                        MetadataMessage::Request { piece } => {
                            let payload = MetadataMessage::Reject { piece }
                                .encode()
                                .map_err(|error| format!(
                                    "Could not encode metadata rejection: {error}"
                                ))?;
                            self.send(
                                &PeerMessage::Extended {
                                    extension_id: remote_metadata_id,
                                    payload,
                                },
                                cancel,
                            )
                            .await?;
                            control_frames_without_progress =
                                control_frames_without_progress.saturating_add(1);
                        }
                    }
                }
                PeerMessage::Extended { .. }
                | PeerMessage::KeepAlive
                | PeerMessage::Choke
                | PeerMessage::Unchoke
                | PeerMessage::Interested
                | PeerMessage::NotInterested
                | PeerMessage::Have(_)
                | PeerMessage::Bitfield(_)
                | PeerMessage::Request { .. }
                | PeerMessage::Piece { .. }
                | PeerMessage::Cancel { .. }
                | PeerMessage::Port(_)
                | PeerMessage::Extended { .. } => {
                    control_frames_without_progress =
                        control_frames_without_progress.saturating_add(1);
                }
            }

            if control_frames_without_progress > self.config.max_control_frames_without_progress {
                return Err(format!(
                    "Peer {} produced too many frames without metadata progress",
                    self.address
                ));
            }
        }

        let raw_info = assembler
            .finish()
            .map_err(|error| format!("Peer {} metadata verification failed: {error}", self.address))?;
        let metainfo = TorrentMetainfo::from_info_bytes(&raw_info, trackers)
            .map_err(|error| format!("Peer {} returned invalid torrent metadata: {error}", self.address))?;
        if metainfo.info_hash != info_hash {
            return Err(format!(
                "Peer {} metadata info hash changed after validation",
                self.address
            ));
        }

        Ok(PeerMetadataResult {
            address: self.address,
            peer_id: self.remote_peer_id,
            metainfo,
            pex_peers: self.take_discovered_pex_peers(),
        })
    }

    async fn wait_for_extended_handshake(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<ExtendedHandshake, String> {
        if let Some(handshake) = self.remote_extensions.clone() {
            return Ok(handshake);
        }

        for _ in 0..=self.config.max_control_frames_without_progress {
            let message = self.receive(cancel).await?;
            if matches!(
                message,
                PeerMessage::Extended {
                    extension_id: EXTENSION_HANDSHAKE_ID,
                    ..
                }
            ) {
                if let Some(handshake) = self.remote_extensions.clone() {
                    return Ok(handshake);
                }
            }
        }

        Err(format!(
            "Peer {} did not provide an extended handshake",
            self.address
        ))
    }

    async fn fill_metadata_pipeline(
        &mut self,
        remote_metadata_id: u8,
        pipeline_depth: usize,
        pending: &mut VecDeque<u32>,
        outstanding: &mut BTreeMap<u32, MetadataOutstanding>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        while outstanding.len() < pipeline_depth {
            let Some(piece) = pending.pop_front() else {
                break;
            };
            let payload = MetadataMessage::request(piece)
                .encode()
                .map_err(|error| format!("Could not encode metadata request: {error}"))?;
            self.send(
                &PeerMessage::Extended {
                    extension_id: remote_metadata_id,
                    payload,
                },
                cancel,
            )
            .await?;
            outstanding.insert(
                piece,
                MetadataOutstanding {
                    retries: 0,
                    last_sent: Instant::now(),
                },
            );
        }
        Ok(())
    }

    async fn retry_oldest_metadata_request(
        &mut self,
        remote_metadata_id: u8,
        outstanding: &mut BTreeMap<u32, MetadataOutstanding>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let Some((&piece, oldest)) = outstanding
            .iter()
            .min_by_key(|(_, request)| request.last_sent)
        else {
            return Err(format!(
                "Peer {} metadata transfer timed out without outstanding requests",
                self.address
            ));
        };

        if oldest.retries >= self.config.max_metadata_retries {
            return Err(format!(
                "Peer {} exhausted metadata retries for piece {}",
                self.address, piece
            ));
        }

        let payload = MetadataMessage::request(piece)
            .encode()
            .map_err(|error| format!("Could not encode metadata retry: {error}"))?;
        self.send(
            &PeerMessage::Extended {
                extension_id: remote_metadata_id,
                payload,
            },
            cancel,
        )
        .await?;

        if let Some(request) = outstanding.get_mut(&piece) {
            request.retries = request.retries.saturating_add(1);
            request.last_sent = Instant::now();
        }
        Ok(())
    }

    pub async fn download_piece(
        &mut self,
        metainfo: &TorrentMetainfo,
        piece_index: u32,
        cancel: &CancellationToken,
    ) -> Result<PeerPieceResult, String> {
        let piece_index_usize = piece_index as usize;
        let piece_size = metainfo
            .piece_size(piece_index_usize)
            .ok_or_else(|| format!("Torrent piece {piece_index} is out of range"))?;
        let layout = PieceLayout::new(metainfo.total_length, metainfo.piece_length)
            .map_err(|error| format!("Invalid torrent piece layout: {error}"))?;
        let requests = layout
            .block_requests(piece_index, DEFAULT_BLOCK_SIZE)
            .map_err(|error| format!("Could not plan piece blocks: {error}"))?;

        if requests.is_empty() || piece_size == 0 {
            return Err(format!("Torrent piece {piece_index} has no data"));
        }

        if !self.state.am_interested() {
            self.send(&PeerMessage::Interested, cancel).await?;
            self.state.set_am_interested(true);
        }

        let started = Instant::now();
        let mut pending = VecDeque::from(requests.clone());
        let mut outstanding = BTreeMap::<u32, OutstandingBlock>::new();
        let mut received = BTreeMap::<u32, Vec<u8>>::new();
        let mut control_frames_without_progress = 0u32;

        loop {
            if received.len() == requests.len() {
                break;
            }

            if !self.state.peer_choking() {
                self.fill_pipeline(&mut pending, &mut outstanding, cancel)
                    .await?;
            }

            let frame_result = tokio::select! {
                _ = cancel.cancelled() => return Err("Peer piece download cancelled".to_owned()),
                result = timeout(self.config.block_timeout, self.receive(cancel)) => result,
            };

            let message = match frame_result {
                Ok(result) => result?,
                Err(_) => {
                    if self.state.peer_choking() {
                        return Err(format!(
                            "Peer {} remained choked for too long",
                            self.address
                        ));
                    }
                    self.retry_oldest_block(&mut outstanding, cancel).await?;
                    continue;
                }
            };

            match message {
                PeerMessage::Piece {
                    piece_index: remote_piece,
                    begin,
                    block,
                } => {
                    if remote_piece != piece_index {
                        return Err(format!(
                            "Peer {} sent piece {} while piece {} was requested",
                            self.address, remote_piece, piece_index
                        ));
                    }

                    if received.contains_key(&begin) {
                        // A late duplicate after a retry is harmless as long as
                        // the first valid copy was already accepted.
                        continue;
                    }

                    let expected = outstanding.remove(&begin).ok_or_else(|| {
                        format!(
                            "Peer {} sent unsolicited block at offset {}",
                            self.address, begin
                        )
                    })?;
                    if block.len() != expected.request.length as usize {
                        return Err(format!(
                            "Peer {} sent block {} with length {}, expected {}",
                            self.address,
                            begin,
                            block.len(),
                            expected.request.length
                        ));
                    }
                    received.insert(begin, block);
                    control_frames_without_progress = 0;
                }
                PeerMessage::Choke => {
                    // BEP 3 permits a peer to discard outstanding requests as
                    // soon as it chokes us. Put them back into the pending
                    // queue so they are re-issued only after a future unchoke.
                    let mut cancelled = outstanding
                        .values()
                        .map(|block| block.request)
                        .collect::<Vec<_>>();
                    cancelled.sort_by_key(|request| request.begin);
                    for request in cancelled.into_iter().rev() {
                        pending.push_front(request);
                    }
                    outstanding.clear();
                    control_frames_without_progress =
                        control_frames_without_progress.saturating_add(1);
                }
                PeerMessage::Unchoke
                | PeerMessage::KeepAlive
                | PeerMessage::Have(_)
                | PeerMessage::Bitfield(_)
                | PeerMessage::Interested
                | PeerMessage::NotInterested
                | PeerMessage::Request { .. }
                | PeerMessage::Cancel { .. }
                | PeerMessage::Port(_) => {
                    control_frames_without_progress =
                        control_frames_without_progress.saturating_add(1);
                }
            }

            if control_frames_without_progress
                > self.config.max_control_frames_without_progress
            {
                return Err(format!(
                    "Peer {} produced too many frames without download progress",
                    self.address
                ));
            }
        }

        let mut bytes = Vec::with_capacity(piece_size as usize);
        for request in &requests {
            let block = received.get(&request.begin).ok_or_else(|| {
                format!(
                    "Peer {} piece {} is missing block {}",
                    self.address, piece_index, request.begin
                )
            })?;
            bytes.extend_from_slice(block);
        }

        if bytes.len() as u64 != piece_size {
            return Err(format!(
                "Peer {} assembled piece {} with {} bytes, expected {}",
                self.address,
                piece_index,
                bytes.len(),
                piece_size
            ));
        }

        let verified = metainfo
            .verify_piece(piece_index_usize, &bytes)
            .map_err(|error| format!("Could not verify piece {piece_index}: {error}"))?;
        if !verified {
            return Err(format!(
                "Peer {} failed SHA-1 verification for piece {}",
                self.address, piece_index
            ));
        }

        Ok(PeerPieceResult {
            address: self.address,
            peer_id: self.remote_peer_id,
            piece_index,
            bytes,
            elapsed: started.elapsed(),
        })
    }

    async fn fill_pipeline(
        &mut self,
        pending: &mut VecDeque<BlockRequest>,
        outstanding: &mut BTreeMap<u32, OutstandingBlock>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let depth = self.config.pipeline_depth.max(1);
        while outstanding.len() < depth {
            let Some(request) = pending.pop_front() else {
                break;
            };
            if let Some(limiter) = &self.download_limiter {
                limiter.acquire(u64::from(request.length), cancel).await?;
            }
            self.send(
                &PeerMessage::Request {
                    piece_index: request.piece_index,
                    begin: request.begin,
                    length: request.length,
                },
                cancel,
            )
            .await?;
            outstanding.insert(
                request.begin,
                OutstandingBlock {
                    request,
                    retries: 0,
                    last_sent: Instant::now(),
                },
            );
        }
        Ok(())
    }

    async fn retry_oldest_block(
        &mut self,
        outstanding: &mut BTreeMap<u32, OutstandingBlock>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let Some((&begin, oldest)) = outstanding
            .iter()
            .min_by_key(|(_, block)| block.last_sent)
        else {
            return Err(format!(
                "Peer {} timed out without any outstanding requests",
                self.address
            ));
        };

        if oldest.retries >= self.config.max_block_retries {
            return Err(format!(
                "Peer {} exhausted retries for block {}",
                self.address, begin
            ));
        }

        let request = oldest.request;
        if let Some(limiter) = &self.download_limiter {
            limiter.acquire(u64::from(request.length), cancel).await?;
        }
        self.send(
            &PeerMessage::Request {
                piece_index: request.piece_index,
                begin: request.begin,
                length: request.length,
            },
            cancel,
        )
        .await?;

        if let Some(block) = outstanding.get_mut(&begin) {
            block.retries = block.retries.saturating_add(1);
            block.last_sent = Instant::now();
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
struct MetadataOutstanding {
    retries: u32,
    last_sent: Instant,
}

#[derive(Clone, Copy, Debug)]
struct OutstandingBlock {
    request: BlockRequest,
    retries: u32,
    last_sent: Instant,
}

pub async fn read_peer_frame(
    stream: &mut TcpStream,
    frame_timeout: Duration,
    cancel: &CancellationToken,
) -> Result<PeerMessage, String> {
    let mut prefix = [0u8; 4];
    read_exact_cancellable(
        stream,
        &mut prefix,
        frame_timeout,
        cancel,
        "peer frame length",
    )
    .await?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_PEER_FRAME_BYTES {
        return Err(format!(
            "Peer frame exceeds {} byte limit: {}",
            MAX_PEER_FRAME_BYTES, length
        ));
    }
    if length == 0 {
        return Ok(PeerMessage::KeepAlive);
    }

    let total = length
        .checked_add(4)
        .ok_or_else(|| "Peer frame length overflow".to_owned())?;
    let mut frame = vec![0u8; total];
    frame[..4].copy_from_slice(&prefix);
    read_exact_cancellable(
        stream,
        &mut frame[4..],
        frame_timeout,
        cancel,
        "peer frame payload",
    )
    .await?;

    PeerMessage::decode_frame(&frame)
        .map(|(message, _)| message)
        .map_err(|error| format!("Invalid peer frame: {error}"))
}

async fn read_exact_cancellable(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    operation_timeout: Duration,
    cancel: &CancellationToken,
    operation: &str,
) -> Result<(), String> {
    tokio::select! {
        _ = cancel.cancelled() => Err(format!("{operation} cancelled")),
        result = timeout(operation_timeout, stream.read_exact(buffer)) => {
            result
                .map_err(|_| format!("{operation} timed out"))?
                .map(|_| ())
                .map_err(|error| format!("{operation} failed: {error}"))
        }
    }
}

async fn write_all_cancellable(
    stream: &mut TcpStream,
    bytes: &[u8],
    operation_timeout: Duration,
    cancel: &CancellationToken,
    operation: &str,
) -> Result<(), String> {
    tokio::select! {
        _ = cancel.cancelled() => Err(format!("{operation} cancelled")),
        result = timeout(operation_timeout, stream.write_all(bytes)) => {
            result
                .map_err(|_| format!("{operation} timed out"))?
                .map_err(|error| format!("{operation} failed: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_torrent_core::{TorrentFile, TorrentMetainfo};
    use tokio::net::TcpListener;

    fn test_metainfo() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([7u8; 20]),
            name: "piece.bin".to_owned(),
            piece_length: 8,
            piece_hashes: vec![[
                0x42, 0x5a, 0xf1, 0x2a, 0x07, 0x43, 0x50, 0x2b, 0x32, 0x2e,
                0x93, 0xa0, 0x15, 0xbc, 0xf8, 0x68, 0xe3, 0x24, 0xd5, 0x6a,
            ]],
            files: vec![TorrentFile {
                path: "piece.bin".to_owned(),
                length: 8,
                offset: 0,
            }],
            total_length: 8,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        }
    }

    fn test_config() -> PeerSessionConfig {
        PeerSessionConfig {
            connect_timeout: Duration::from_secs(2),
            handshake_timeout: Duration::from_secs(2),
            frame_timeout: Duration::from_secs(2),
            block_timeout: Duration::from_secs(2),
            metadata_timeout: Duration::from_secs(2),
            pipeline_depth: 4,
            metadata_pipeline_depth: 4,
            max_block_retries: 1,
            max_metadata_retries: 1,
            max_control_frames_without_progress: 32,
            enable_pex: true,
        }
    }

    async fn connect_test_session(
        address: SocketAddr,
        info_hash: InfoHash,
        local_peer_id: [u8; 20],
        piece_count: u32,
        cancel: &CancellationToken,
    ) -> Result<PeerSession, String> {
        PeerSession::connect_with_policy(
            address,
            info_hash,
            local_peer_id,
            piece_count,
            test_config(),
            true,
            cancel,
        )
        .await
    }

    #[tokio::test]
    async fn peer_session_does_not_advertise_or_accept_pex_when_disabled() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let info_hash = InfoHash::new([6u8; 20]);

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();

            let mut remote =
                PeerHandshake::new(info_hash, *b"-NVTEST-REMOTE-00001");
            remote.reserved[5] |= 0x10;
            stream.write_all(&remote.encode()).await.unwrap();

            let local_extended = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let PeerMessage::Extended {
                extension_id: EXTENSION_HANDSHAKE_ID,
                payload,
            } = local_extended
            else {
                panic!("expected extended handshake");
            };
            let local = ExtendedHandshake::parse(&payload).unwrap();
            assert_eq!(local.ut_pex, None);

            let mut pex = b"d5:added6:".to_vec();
            pex.extend_from_slice(&[8, 8, 8, 8, 0x1a, 0xe1]);
            pex.push(b'e');
            stream
                .write_all(
                    &PeerMessage::Extended {
                        extension_id: LOCAL_UT_PEX_ID,
                        payload: pex,
                    }
                    .encode()
                    .unwrap(),
                )
                .await
                .unwrap();
        });

        let cancel = CancellationToken::new();
        let mut config = test_config();
        config.enable_pex = false;
        let mut session = PeerSession::connect_with_policy(
            address,
            info_hash,
            *b"-NV0001-123456789012",
            0,
            config,
            true,
            &cancel,
        )
        .await
        .unwrap();

        let _ = session.receive(&cancel).await.unwrap();
        assert!(session.take_discovered_pex_peers().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn peer_session_fetches_verified_bep9_metadata_and_collects_pex() {
        let mut info = b"d6:lengthi8e4:name9:piece.bin12:piece lengthi8e6:pieces20:".to_vec();
        info.extend_from_slice(&[
            0x42, 0x5a, 0xf1, 0x2a, 0x07, 0x43, 0x50, 0x2b, 0x32, 0x2e,
            0x93, 0xa0, 0x15, 0xbc, 0xf8, 0x68, 0xe3, 0x24, 0xd5, 0x6a,
        ]);
        info.push(b'e');
        let expected = TorrentMetainfo::from_info_bytes(&info, &[]).unwrap();
        let info_hash = expected.info_hash;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_info = info.clone();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();
            let client = PeerHandshake::decode(&handshake).unwrap();
            assert!(client.supports_extension_protocol());

            let mut remote =
                PeerHandshake::new(info_hash, *b"-NVTEST-REMOTE-00001");
            remote.reserved[5] |= 0x10;
            stream.write_all(&remote.encode()).await.unwrap();

            let client_extended = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let PeerMessage::Extended {
                extension_id: EXTENSION_HANDSHAKE_ID,
                payload,
            } = client_extended
            else {
                panic!("expected client extended handshake");
            };
            let client_caps = ExtendedHandshake::parse(&payload).unwrap();
            assert_eq!(client_caps.ut_metadata, Some(LOCAL_UT_METADATA_ID));

            let remote_caps = ExtendedHandshake {
                ut_metadata: Some(3),
                ut_pex: Some(5),
                metadata_size: Some(server_info.len()),
                request_queue: Some(4),
                client_name: Some("NOVA test peer".to_owned()),
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

            let mut pex = b"d5:added6:".to_vec();
            pex.extend_from_slice(&[127, 0, 0, 1, 0x1a, 0xe1]);
            pex.push(b'e');
            stream
                .write_all(
                    &PeerMessage::Extended {
                        extension_id: LOCAL_UT_PEX_ID,
                        payload: pex,
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
                panic!("expected ut_metadata request");
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
                            total_size: server_info.len(),
                            data: server_info,
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

        let cancel = CancellationToken::new();
        let mut session = PeerSession::connect_with_policy(
            address,
            info_hash,
            *b"-NV0001-123456789012",
            0,
            test_config(),
            true,
            &cancel,
        )
        .await
        .expect("connect metadata peer");

        let result = session
            .fetch_metadata(
                info_hash,
                &["https://tracker.test/announce".to_owned()],
                &cancel,
            )
            .await
            .expect("fetch metadata");

        assert_eq!(result.metainfo.info_hash, info_hash);
        assert_eq!(result.metainfo.name, "piece.bin");
        assert_eq!(result.metainfo.total_length, 8);
        assert_eq!(result.pex_peers, vec!["127.0.0.1:6881".parse().unwrap()]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn peer_session_validates_handshake_and_downloads_verified_piece() {
        let metainfo = test_metainfo();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let remote_peer_id = *b"-NVTEST-REMOTE-00001";
        let info_hash = metainfo.info_hash;

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();
            let client = PeerHandshake::decode(&handshake).unwrap();
            assert_eq!(client.info_hash, info_hash);

            let remote = PeerHandshake::new(info_hash, remote_peer_id);
            stream.write_all(&remote.encode()).await.unwrap();
            stream
                .write_all(&PeerMessage::Bitfield(vec![0x80]).encode().unwrap())
                .await
                .unwrap();

            let interested = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(interested, PeerMessage::Interested);
            stream
                .write_all(&PeerMessage::Unchoke.encode().unwrap())
                .await
                .unwrap();

            let request = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                request,
                PeerMessage::Request {
                    piece_index: 0,
                    begin: 0,
                    length: 8,
                }
            );
            stream
                .write_all(
                    &PeerMessage::Piece {
                        piece_index: 0,
                        begin: 0,
                        block: b"abcdefgh".to_vec(),
                    }
                    .encode()
                    .unwrap(),
                )
                .await
                .unwrap();
        });

        let cancel = CancellationToken::new();
        let mut session = connect_test_session(
            address,
            metainfo.info_hash,
            *b"-NV0001-123456789012",
            1,
            &cancel,
        )
        .await
        .expect("connect peer");
        let result = session
            .download_piece(&metainfo, 0, &cancel)
            .await
            .expect("download piece");
        assert_eq!(result.bytes, b"abcdefgh");
        assert_eq!(result.peer_id, remote_peer_id);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn peer_session_rejects_wrong_info_hash() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();
            let wrong = PeerHandshake::new(
                InfoHash::new([9u8; 20]),
                *b"-NVTEST-REMOTE-00001",
            );
            stream.write_all(&wrong.encode()).await.unwrap();
        });

        let cancel = CancellationToken::new();
        let error = connect_test_session(
            address,
            InfoHash::new([7u8; 20]),
            *b"-NV0001-123456789012",
            1,
            &cancel,
        )
        .await
        .expect_err("wrong hash must fail");
        assert!(error.contains("wrong torrent info hash"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn peer_session_retries_timed_out_block_once_and_accepts_retry_response() {
        let metainfo = test_metainfo();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let info_hash = metainfo.info_hash;

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();
            let remote = PeerHandshake::new(
                info_hash,
                *b"-NVTEST-REMOTE-00001",
            );
            stream.write_all(&remote.encode()).await.unwrap();

            let interested = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(interested, PeerMessage::Interested);
            stream
                .write_all(&PeerMessage::Unchoke.encode().unwrap())
                .await
                .unwrap();

            let first = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            let retry = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            assert_eq!(first, retry);

            let PeerMessage::Request {
                piece_index,
                begin,
                ..
            } = retry
            else {
                panic!("expected retried request");
            };
            stream
                .write_all(
                    &PeerMessage::Piece {
                        piece_index,
                        begin,
                        block: b"abcdefgh".to_vec(),
                    }
                    .encode()
                    .unwrap(),
                )
                .await
                .unwrap();
        });

        let cancel = CancellationToken::new();
        let mut config = test_config();
        config.block_timeout = Duration::from_millis(100);
        config.max_block_retries = 1;
        let mut session = PeerSession::connect_with_policy(
            address,
            metainfo.info_hash,
            *b"-NV0001-123456789012",
            1,
            config,
            true,
            &cancel,
        )
        .await
        .unwrap();

        let result = session
            .download_piece(&metainfo, 0, &cancel)
            .await
            .expect("retry should succeed");
        assert_eq!(result.bytes, b"abcdefgh");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn peer_session_rejects_unsolicited_block() {
        let metainfo = test_metainfo();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let info_hash = metainfo.info_hash;

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
            stream.read_exact(&mut handshake).await.unwrap();
            let remote = PeerHandshake::new(
                info_hash,
                *b"-NVTEST-REMOTE-00001",
            );
            stream.write_all(&remote.encode()).await.unwrap();
            let _ = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            stream
                .write_all(&PeerMessage::Unchoke.encode().unwrap())
                .await
                .unwrap();
            let _ = read_peer_frame(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            stream
                .write_all(
                    &PeerMessage::Piece {
                        piece_index: 0,
                        begin: 99,
                        block: vec![1],
                    }
                    .encode()
                    .unwrap(),
                )
                .await
                .unwrap();
        });

        let cancel = CancellationToken::new();
        let mut session = connect_test_session(
            address,
            metainfo.info_hash,
            *b"-NV0001-123456789012",
            1,
            &cancel,
        )
        .await
        .unwrap();
        let error = session
            .download_piece(&metainfo, 0, &cancel)
            .await
            .expect_err("unsolicited block");
        assert!(error.contains("unsolicited block"));
        server.await.unwrap();
    }

    async fn serve_single_piece(
        listener: TcpListener,
        info_hash: InfoHash,
        payload: &'static [u8],
    ) {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
        stream.read_exact(&mut handshake).await.unwrap();
        let remote = PeerHandshake::new(info_hash, *b"-NVTEST-REMOTE-00001");
        stream.write_all(&remote.encode()).await.unwrap();

        let _interested = read_peer_frame(
            &mut stream,
            Duration::from_secs(2),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        stream
            .write_all(&PeerMessage::Unchoke.encode().unwrap())
            .await
            .unwrap();
        let request = read_peer_frame(
            &mut stream,
            Duration::from_secs(2),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let PeerMessage::Request {
            piece_index,
            begin,
            length,
        } = request
        else {
            panic!("expected request");
        };
        assert_eq!(length as usize, payload.len());
        stream
            .write_all(
                &PeerMessage::Piece {
                    piece_index,
                    begin,
                    block: payload.to_vec(),
                }
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn peer_engine_evicts_corrupt_peer_and_fails_over_to_verified_peer() {
        let metainfo = test_metainfo();
        let listener_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let listener_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address_a = listener_a.local_addr().unwrap();
        let address_b = listener_b.local_addr().unwrap();

        let (bad_listener, bad_address, good_listener, good_address) =
            if address_a < address_b {
                (listener_a, address_a, listener_b, address_b)
            } else {
                (listener_b, address_b, listener_a, address_a)
            };

        let bad_hash = metainfo.info_hash;
        let good_hash = metainfo.info_hash;
        let bad_server =
            tokio::spawn(serve_single_piece(bad_listener, bad_hash, b"XXXXXXXX"));
        let good_server =
            tokio::spawn(serve_single_piece(good_listener, good_hash, b"abcdefgh"));

        let engine = PeerEngine::for_tests(PeerEngineConfig {
            session: test_config(),
            max_outbound_connections: 2,
            download_rate_limit_bytes_per_sec: None,
        });
        let cancel = CancellationToken::new();
        let result = engine
            .download_piece_from_candidates(
                &[bad_address, good_address],
                &metainfo,
                0,
                *b"-NV0001-123456789012",
                &cancel,
            )
            .await
            .expect("fallback to verified peer");

        assert_eq!(result.address, good_address);
        assert_eq!(result.bytes, b"abcdefgh");
        assert!(engine.reputation(bad_address).await.should_evict());
        assert_eq!(engine.reputation(good_address).await.successful_pieces, 1);
        bad_server.await.unwrap();
        good_server.await.unwrap();
    }

    #[test]
    fn generated_peer_id_uses_nova_prefix_and_exact_wire_length() {
        let peer_id = generate_peer_id();
        assert_eq!(peer_id.len(), 20);
        assert_eq!(&peer_id[..8], b"-NV0001-");
        assert!(peer_id[8..].iter().all(u8::is_ascii_hexdigit));
    }

    #[tokio::test]
    async fn peer_engine_filters_evicted_candidates() {
        let good: SocketAddr = "1.1.1.1:6881".parse().unwrap();
        let bad: SocketAddr = "8.8.8.8:6881".parse().unwrap();
        let engine = PeerEngine::production_default();
        engine
            .reputation
            .lock()
            .await
            .get_mut(bad)
            .record_hash_failure();
        assert_eq!(engine.ranked_candidates(&[bad, good]).await, vec![good]);
    }

    #[test]
    fn reputation_evicts_corrupt_or_repeatedly_bad_peers() {
        let mut reputation = PeerReputation::default();
        reputation.record_success(4 * 1024 * 1024);
        assert!(reputation.priority_score() > 0);
        assert!(!reputation.should_evict());

        reputation.record_hash_failure();
        assert!(reputation.should_evict());
        assert!(reputation.priority_score() < 0);
    }

    #[test]
    fn reputation_book_ranks_successful_peers_first() {
        let a: SocketAddr = "1.1.1.1:6881".parse().unwrap();
        let b: SocketAddr = "8.8.8.8:6881".parse().unwrap();
        let mut book = PeerReputationBook::default();
        book.get_mut(b).record_success(1024 * 1024);
        book.get_mut(a).record_timeout();
        assert_eq!(book.rank_candidates(&[a, b]), vec![b, a]);
    }
}
