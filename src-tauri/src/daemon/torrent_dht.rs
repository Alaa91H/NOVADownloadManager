use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nova_torrent_core::{
    DhtMessage, DhtNodeId, DhtQuery, DhtResponse, InfoHash, MAX_DHT_PACKET_BYTES,
    MAX_DHT_PEERS,
};
use tokio::net::{lookup_host, UdpSocket};
use tokio::sync::{oneshot, Mutex as TokioMutex, RwLock as TokioRwLock};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use sha1::{Digest, Sha1};

use crate::daemon::state::SharedState;
use crate::daemon::utils::{is_internal_ip, private_network_allowed};
use crate::lock_or_err;

const DHT_BUCKET_COUNT: usize = 160;
const DHT_BUCKET_SIZE: usize = 8;
const DHT_ROUTING_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;
const DHT_STATE_VERSION: u32 = 1;
const DHT_STATE_FILE_NAME: &str = "torrent-dht-state.json";
const MAX_DHT_STATE_BYTES: u64 = 2 * 1024 * 1024;
const DHT_TOKEN_ROTATE_INTERVAL: Duration = Duration::from_secs(5 * 60);
const DHT_PEER_TTL: Duration = Duration::from_secs(30 * 60);
const DHT_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);
const DHT_ANNOUNCE_REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);
const DHT_ANNOUNCE_RETRY_INTERVAL: Duration = Duration::from_secs(60);
const MAX_STORED_INFO_HASHES: usize = 1_024;
const MAX_STORED_PEERS_PER_HASH: usize = 128;
const MAX_RESPONSE_PEERS: usize = 16;
const MAX_RESPONSE_NODES: usize = 8;
static ACTIVE_TORRENT_DHT_PORT: AtomicU16 = AtomicU16::new(0);

const DEFAULT_BOOTSTRAP: &[&str] = &[
    "router.bittorrent.com:6881",
    "dht.transmissionbt.com:6881",
    "router.utorrent.com:6881",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DhtRoutingSnapshotEntry {
    pub node: nova_torrent_core::DhtNode,
    pub last_seen_unix: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RoutingEntry {
    node: nova_torrent_core::DhtNode,
    last_seen_unix: u64,
}

#[derive(Debug)]
struct DhtRoutingTable {
    local_id: DhtNodeId,
    buckets: Vec<VecDeque<RoutingEntry>>,
}

impl DhtRoutingTable {
    fn new(local_id: DhtNodeId) -> Self {
        Self {
            local_id,
            buckets: (0..DHT_BUCKET_COUNT).map(|_| VecDeque::new()).collect(),
        }
    }

    #[cfg(test)]
    fn restore(local_id: DhtNodeId, entries: &[DhtRoutingSnapshotEntry]) -> Self {
        let mut table = Self::new(local_id);
        let cutoff = unix_now().saturating_sub(DHT_ROUTING_MAX_AGE_SECS);
        let mut restored = entries
            .iter()
            .copied()
            .filter(|entry| entry.last_seen_unix >= cutoff)
            .collect::<Vec<_>>();
        restored.sort_by_key(|entry| entry.last_seen_unix);
        for entry in restored {
            table.record_at(entry.node, entry.last_seen_unix);
        }
        table
    }

    fn record(&mut self, node: nova_torrent_core::DhtNode) {
        self.record_at(node, unix_now());
    }

    fn record_at(&mut self, node: nova_torrent_core::DhtNode, last_seen_unix: u64) {
        let Some(index) = bucket_index(self.local_id, node.id) else {
            return;
        };
        let bucket = &mut self.buckets[index];
        if let Some(position) = bucket
            .iter()
            .position(|entry| entry.node.id == node.id || entry.node.address == node.address)
        {
            bucket.remove(position);
        }
        while bucket.len() >= DHT_BUCKET_SIZE {
            bucket.pop_front();
        }
        bucket.push_back(RoutingEntry {
            node,
            last_seen_unix,
        });
    }

    fn prune(&mut self) {
        let cutoff = unix_now().saturating_sub(DHT_ROUTING_MAX_AGE_SECS);
        for bucket in &mut self.buckets {
            bucket.retain(|entry| entry.last_seen_unix >= cutoff);
        }
    }

    fn snapshot(&self) -> Vec<DhtRoutingSnapshotEntry> {
        self.buckets
            .iter()
            .flat_map(|bucket| bucket.iter())
            .map(|entry| DhtRoutingSnapshotEntry {
                node: entry.node,
                last_seen_unix: entry.last_seen_unix,
            })
            .collect()
    }

    fn closest_to_info_hash(&self, target: InfoHash, limit: usize) -> Vec<nova_torrent_core::DhtNode> {
        let mut nodes = self
            .buckets
            .iter()
            .flat_map(|bucket| bucket.iter().map(|entry| entry.node))
            .collect::<Vec<_>>();
        nodes.sort_by(|left, right| {
            left.id
                .xor_distance(target)
                .cmp(&right.id.xor_distance(target))
                .then_with(|| left.address.cmp(&right.address))
        });
        nodes.truncate(limit);
        nodes
    }

    fn closest_to_node(&self, target: DhtNodeId, limit: usize) -> Vec<nova_torrent_core::DhtNode> {
        let mut nodes = self
            .buckets
            .iter()
            .flat_map(|bucket| bucket.iter().map(|entry| entry.node))
            .collect::<Vec<_>>();
        nodes.sort_by(|left, right| {
            xor_node_distance(left.id, target)
                .cmp(&xor_node_distance(right.id, target))
                .then_with(|| left.address.cmp(&right.address))
        });
        nodes.truncate(limit);
        nodes
    }
}

struct PendingDhtExchange {
    address: SocketAddr,
    sender: oneshot::Sender<DhtMessage>,
}

struct DhtSharedTransport {
    socket: TokioRwLock<Option<Arc<UdpSocket>>>,
    pending: TokioMutex<HashMap<Vec<u8>, PendingDhtExchange>>,
}

impl std::fmt::Debug for DhtSharedTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DhtSharedTransport")
    }
}

impl DhtSharedTransport {
    fn new() -> Self {
        Self {
            socket: TokioRwLock::new(None),
            pending: TokioMutex::new(HashMap::new()),
        }
    }

    async fn set_socket(&self, socket: Option<Arc<UdpSocket>>) {
        let disconnecting = socket.is_none();
        *self.socket.write().await = socket;
        if disconnecting {
            self.pending.lock().await.clear();
        }
    }

    async fn socket(&self) -> Option<Arc<UdpSocket>> {
        self.socket.read().await.clone()
    }

    async fn register(
        &self,
        transaction_id: Vec<u8>,
        address: SocketAddr,
    ) -> Result<oneshot::Receiver<DhtMessage>, String> {
        let mut pending = self.pending.lock().await;
        if pending.contains_key(&transaction_id) {
            return Err("DHT transaction id collision".to_owned());
        }
        let (sender, receiver) = oneshot::channel();
        pending.insert(
            transaction_id,
            PendingDhtExchange {
                address,
                sender,
            },
        );
        Ok(receiver)
    }

    async fn remove(&self, transaction_id: &[u8]) {
        self.pending.lock().await.remove(transaction_id);
    }

    async fn deliver(&self, source: SocketAddr, message: DhtMessage) -> bool {
        let transaction_id = match &message {
            DhtMessage::Response { transaction_id, .. }
            | DhtMessage::Error { transaction_id, .. } => transaction_id.clone(),
            DhtMessage::Query { .. } => return false,
        };
        let mut pending = self.pending.lock().await;
        let Some(exchange) = pending.get(&transaction_id) else {
            return false;
        };
        if exchange.address != source {
            return false;
        }
        let Some(exchange) = pending.remove(&transaction_id) else {
            return false;
        };
        let _ = exchange.sender.send(message);
        true
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDhtState {
    version: u32,
    node_id: String,
    #[serde(default)]
    nodes: Vec<PersistedDhtNode>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDhtNode {
    id: String,
    address: String,
    last_seen_unix: u64,
}

#[derive(Clone, Copy, Debug)]
struct StoredPeer {
    address: SocketAddr,
    seen_at: Instant,
}

#[derive(Debug)]
struct DhtTokenState {
    current: [u8; 20],
    previous: [u8; 20],
    rotated_at: Instant,
}

impl DhtTokenState {
    fn new() -> Self {
        Self {
            current: random_secret(),
            previous: random_secret(),
            rotated_at: Instant::now(),
        }
    }

    fn rotate_if_needed(&mut self) {
        if self.rotated_at.elapsed() >= DHT_TOKEN_ROTATE_INTERVAL {
            self.previous = self.current;
            self.current = random_secret();
            self.rotated_at = Instant::now();
        }
    }

    fn issue(&mut self, ip: IpAddr) -> Vec<u8> {
        self.rotate_if_needed();
        token_digest(&self.current, ip).to_vec()
    }

    fn validate(&mut self, ip: IpAddr, token: &[u8]) -> bool {
        self.rotate_if_needed();
        constant_time_eq(token, &token_digest(&self.current, ip))
            || constant_time_eq(token, &token_digest(&self.previous, ip))
    }
}

#[derive(Clone, Debug)]
pub struct DhtService {
    engine: DhtEngine,
    peers: Arc<Mutex<HashMap<InfoHash, Vec<StoredPeer>>>>,
    tokens: Arc<Mutex<DhtTokenState>>,
    state_path: Arc<PathBuf>,
}

impl DhtService {
    pub fn load_or_new(data_dir: &str) -> Self {
        let path = Path::new(data_dir).join(DHT_STATE_FILE_NAME);
        let restored = load_dht_state(&path);
        let (node_id, nodes) = match restored {
            Some(state) => match parse_node_id_hex(&state.node_id) {
                Some(node_id) => {
                    let nodes = state
                        .nodes
                        .into_iter()
                        .filter_map(|entry| {
                            let id = parse_node_id_hex(&entry.id)?;
                            let address = entry.address.parse::<SocketAddr>().ok()?;
                            Some(DhtRoutingSnapshotEntry {
                                node: nova_torrent_core::DhtNode { id, address },
                                last_seen_unix: entry.last_seen_unix,
                            })
                        })
                        .collect::<Vec<_>>();
                    (node_id, nodes)
                }
                None => {
                    log::warn!("Ignoring DHT state with invalid node id");
                    (generate_dht_node_id(), Vec::new())
                }
            },
            None => (generate_dht_node_id(), Vec::new()),
        };

        let engine = DhtEngine::with_routing(node_id, DhtConfig::default(), nodes);
        engine.prune_routing();
        let service = Self {
            engine,
            peers: Arc::new(Mutex::new(HashMap::new())),
            tokens: Arc::new(Mutex::new(DhtTokenState::new())),
            state_path: Arc::new(path),
        };
        if let Err(error) = service.save_state() {
            log::debug!("Could not initialize DHT state file: {error}");
        }
        service
    }

    pub fn engine(&self) -> DhtEngine {
        self.engine.clone()
    }

    pub fn node_id(&self) -> DhtNodeId {
        self.engine.node_id()
    }

    pub fn routing_node_count(&self) -> usize {
        self.engine.routing_snapshot().len()
    }

    pub fn save_state(&self) -> Result<(), String> {
        self.engine.prune_routing();
        let nodes = self
            .engine
            .routing_snapshot()
            .into_iter()
            .map(|entry| PersistedDhtNode {
                id: node_id_hex(entry.node.id),
                address: entry.node.address.to_string(),
                last_seen_unix: entry.last_seen_unix,
            })
            .collect::<Vec<_>>();
        let state = PersistedDhtState {
            version: DHT_STATE_VERSION,
            node_id: node_id_hex(self.engine.node_id()),
            nodes,
        };
        let bytes = serde_json::to_vec_pretty(&state)
            .map_err(|error| format!("Could not encode DHT state: {error}"))?;
        if bytes.len() as u64 > MAX_DHT_STATE_BYTES {
            return Err(format!(
                "DHT state exceeds {} byte safety limit",
                MAX_DHT_STATE_BYTES
            ));
        }
        if let Some(parent) = self.state_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create DHT state directory: {error}"))?;
        }
        let tmp = self.state_path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes)
            .map_err(|error| format!("Could not write DHT state {}: {error}", tmp.display()))?;
        let file = std::fs::File::open(&tmp)
            .map_err(|error| format!("Could not reopen DHT state {}: {error}", tmp.display()))?;
        file.sync_all()
            .map_err(|error| format!("Could not sync DHT state {}: {error}", tmp.display()))?;
        if self.state_path.exists() {
            std::fs::remove_file(self.state_path.as_ref())
                .map_err(|error| format!("Could not replace DHT state: {error}"))?;
        }
        std::fs::rename(&tmp, self.state_path.as_ref())
            .map_err(|error| format!("Could not commit DHT state: {error}"))
    }

    pub async fn run_server(
        &self,
        state: SharedState,
        cancel: CancellationToken,
    ) -> Result<u16, String> {
        let port = configured_dht_port();
        let socket = Arc::new(
            UdpSocket::bind(("0.0.0.0", port))
                .await
                .map_err(|error| format!("Could not bind torrent DHT UDP port {port}: {error}"))?,
        );
        let local = socket
            .local_addr()
            .map_err(|error| format!("Could not read torrent DHT listener address: {error}"))?;
        self.engine.attach_socket(Some(socket.clone())).await;
        ACTIVE_TORRENT_DHT_PORT.store(local.port(), Ordering::Release);
        log::info!("Native torrent DHT server started on {local}");

        let mut maintenance = tokio::time::interval(DHT_MAINTENANCE_INTERVAL);
        maintenance.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut buffer = vec![0u8; MAX_DHT_PACKET_BYTES];

        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = maintenance.tick() => {
                    self.maintenance();
                    if let Err(error) = self.save_state() {
                        log::debug!("Could not persist DHT routing state: {error}");
                    }
                }
                received = socket.recv_from(&mut buffer) => {
                    let (length, source) = match received {
                        Ok(value) => value,
                        Err(error) => {
                            log::debug!("Torrent DHT receive failed: {error}");
                            continue;
                        }
                    };
                    if !self.engine.address_allowed(source) {
                        continue;
                    }
                    let packet = &buffer[..length];
                    let message = match DhtMessage::parse(packet) {
                        Ok(message) => message,
                        Err(_) => continue,
                    };
                    if matches!(
                        &message,
                        DhtMessage::Response { .. } | DhtMessage::Error { .. }
                    )
                        && self
                            .engine
                            .deliver_shared_response(source, message.clone())
                            .await
                    {
                        continue;
                    }
                    let Some(response) = self.handle_message(&state, source, message) else {
                        continue;
                    };
                    let encoded = match response.encode() {
                        Ok(encoded) => encoded,
                        Err(error) => {
                            log::debug!("Could not encode torrent DHT response: {error}");
                            continue;
                        }
                    };
                    if encoded.len() > 1_200 {
                        log::debug!(
                            "Dropping oversized torrent DHT response to {source}: {} bytes",
                            encoded.len()
                        );
                        continue;
                    }
                    let _ = socket.send_to(&encoded, source).await;
                }
            }
        }

        self.engine.attach_socket(None).await;
        ACTIVE_TORRENT_DHT_PORT.store(0, Ordering::Release);
        self.maintenance();
        if let Err(error) = self.save_state() {
            log::warn!("Could not save DHT routing state during shutdown: {error}");
        }
        Ok(local.port())
    }

    #[cfg(test)]
    fn handle_packet(
        &self,
        state: &SharedState,
        source: SocketAddr,
        packet: &[u8],
    ) -> Option<DhtMessage> {
        let message = DhtMessage::parse(packet).ok()?;
        self.handle_message(state, source, message)
    }

    fn handle_message(
        &self,
        state: &SharedState,
        source: SocketAddr,
        message: DhtMessage,
    ) -> Option<DhtMessage> {
        let DhtMessage::Query {
            transaction_id,
            query,
        } = message
        else {
            return None;
        };

        let remote_id = match &query {
            DhtQuery::Ping { id }
            | DhtQuery::FindNode { id, .. }
            | DhtQuery::GetPeers { id, .. }
            | DhtQuery::AnnouncePeer { id, .. } => *id,
        };
        self.engine.record_node(nova_torrent_core::DhtNode {
            id: remote_id,
            address: source,
        });

        match query {
            DhtQuery::Ping { .. } => Some(DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: self.engine.node_id(),
                    token: None,
                    nodes: Vec::new(),
                    peers: Vec::new(),
                },
            }),
            DhtQuery::FindNode { target, .. } => Some(DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: self.engine.node_id(),
                    token: None,
                    nodes: self
                        .engine
                        .closest_nodes_for_node(target, MAX_RESPONSE_NODES),
                    peers: Vec::new(),
                },
            }),
            DhtQuery::GetPeers { info_hash, .. } => {
                let private = local_torrent_dht_blocked(state, info_hash);
                let peers = if private {
                    Vec::new()
                } else {
                    self.peers_for(info_hash)
                };
                let token = if private {
                    None
                } else {
                    Some(self.issue_token(source.ip()))
                };
                let nodes = if peers.is_empty() {
                    self.engine
                        .closest_nodes_for_info_hash(info_hash, MAX_RESPONSE_NODES)
                } else {
                    Vec::new()
                };
                Some(DhtMessage::Response {
                    transaction_id,
                    response: DhtResponse {
                        id: self.engine.node_id(),
                        token,
                        nodes,
                        peers,
                    },
                })
            }
            DhtQuery::AnnouncePeer {
                info_hash,
                port,
                token,
                implied_port,
                ..
            } => {
                if local_torrent_dht_blocked(state, info_hash) {
                    return Some(DhtMessage::Error {
                        transaction_id,
                        code: 203,
                        message: "DHT disabled for this torrent".to_owned(),
                    });
                }
                if !self.validate_token(source.ip(), &token) {
                    return Some(DhtMessage::Error {
                        transaction_id,
                        code: 203,
                        message: "Invalid token".to_owned(),
                    });
                }
                let peer = SocketAddr::new(
                    source.ip(),
                    if implied_port { source.port() } else { port },
                );
                if !self.engine.address_allowed(peer) {
                    return Some(DhtMessage::Error {
                        transaction_id,
                        code: 203,
                        message: "Invalid peer address".to_owned(),
                    });
                }
                self.store_peer(info_hash, peer);
                Some(DhtMessage::Response {
                    transaction_id,
                    response: DhtResponse {
                        id: self.engine.node_id(),
                        token: None,
                        nodes: Vec::new(),
                        peers: Vec::new(),
                    },
                })
            }
        }
    }

    fn issue_token(&self, ip: IpAddr) -> Vec<u8> {
        match self.tokens.lock() {
            Ok(mut tokens) => tokens.issue(ip),
            Err(poison) => poison.into_inner().issue(ip),
        }
    }

    fn validate_token(&self, ip: IpAddr, token: &[u8]) -> bool {
        match self.tokens.lock() {
            Ok(mut tokens) => tokens.validate(ip, token),
            Err(poison) => poison.into_inner().validate(ip, token),
        }
    }

    fn store_peer(&self, info_hash: InfoHash, address: SocketAddr) {
        let mut peers = match self.peers.lock() {
            Ok(peers) => peers,
            Err(poison) => poison.into_inner(),
        };
        prune_peer_store(&mut peers);
        if !peers.contains_key(&info_hash) && peers.len() >= MAX_STORED_INFO_HASHES {
            if let Some(oldest_key) = peers
                .iter()
                .min_by_key(|(_, values)| {
                    values
                        .iter()
                        .map(|peer| peer.seen_at)
                        .min()
                        .unwrap_or_else(Instant::now)
                })
                .map(|(key, _)| *key)
            {
                peers.remove(&oldest_key);
            }
        }
        let values = peers.entry(info_hash).or_default();
        if let Some(existing) = values.iter_mut().find(|peer| peer.address == address) {
            existing.seen_at = Instant::now();
            return;
        }
        if values.len() >= MAX_STORED_PEERS_PER_HASH {
            values.sort_by_key(|peer| peer.seen_at);
            values.remove(0);
        }
        values.push(StoredPeer {
            address,
            seen_at: Instant::now(),
        });
    }

    fn peers_for(&self, info_hash: InfoHash) -> Vec<SocketAddr> {
        let mut peers = match self.peers.lock() {
            Ok(peers) => peers,
            Err(poison) => poison.into_inner(),
        };
        prune_peer_store(&mut peers);
        let mut output = peers
            .get(&info_hash)
            .into_iter()
            .flat_map(|values| values.iter().map(|peer| peer.address))
            .filter(|address| self.engine.address_allowed(*address))
            .collect::<Vec<_>>();
        output.sort_unstable();
        output.dedup();
        output.truncate(MAX_RESPONSE_PEERS);
        output
    }

    fn maintenance(&self) {
        self.engine.prune_routing();
        let mut peers = match self.peers.lock() {
            Ok(peers) => peers,
            Err(poison) => poison.into_inner(),
        };
        prune_peer_store(&mut peers);
        match self.tokens.lock() {
            Ok(mut tokens) => tokens.rotate_if_needed(),
            Err(poison) => poison.into_inner().rotate_if_needed(),
        }
    }

    #[cfg(test)]
    fn for_tests(node_id: DhtNodeId, state_path: PathBuf) -> Self {
        let engine = DhtEngine::for_tests(node_id, DhtConfig::default());
        Self {
            engine,
            peers: Arc::new(Mutex::new(HashMap::new())),
            tokens: Arc::new(Mutex::new(DhtTokenState::new())),
            state_path: Arc::new(state_path),
        }
    }
}

pub async fn run_dht_announce_lifecycle(
    state: SharedState,
    task_id: String,
    storage: crate::daemon::torrent_storage::TorrentStorageSession,
    cancel: CancellationToken,
) {
    let plan = match storage.transfer_plan().await {
        Ok(plan) => plan,
        Err(error) => {
            log::debug!(
                "Torrent DHT lifecycle {task_id}: storage plan unavailable: {error}"
            );
            return;
        }
    };
    if plan.metainfo.private {
        return;
    }
    let info_hash = plan.metainfo.info_hash;

    loop {
        if cancel.is_cancelled() {
            break;
        }

        let Some(peer_port) = crate::daemon::torrent_seed::active_seed_port() else {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(DHT_ANNOUNCE_RETRY_INTERVAL) => {}
            }
            continue;
        };
        if active_dht_port().is_none() {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(DHT_ANNOUNCE_RETRY_INTERVAL) => {}
            }
            continue;
        }

        let engine = state.torrent_dht.engine();
        let discovery = match engine.discover_peers(info_hash, &cancel).await {
            Ok(discovery) => discovery,
            Err(_) if cancel.is_cancelled() => break,
            Err(error) => {
                log::debug!("Torrent DHT lifecycle {task_id}: discovery failed: {error}");
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(DHT_ANNOUNCE_RETRY_INTERVAL) => {}
                }
                continue;
            }
        };

        merge_discovered_dht_peers(&state, &task_id, &discovery.peers);

        let mut announces = JoinSet::new();
        for target in discovery.announce_targets.into_iter().take(8) {
            let engine = engine.clone();
            let child = cancel.child_token();
            announces.spawn(async move {
                engine
                    .announce_peer(&target, info_hash, peer_port, &child)
                    .await
            });
        }
        while let Some(result) = announces.join_next().await {
            if cancel.is_cancelled() {
                announces.abort_all();
                break;
            }
            if let Ok(Err(error)) = result {
                log::trace!("Torrent DHT announce failed: {error}");
            }
        }
        if cancel.is_cancelled() {
            break;
        }

        if let Err(error) = state.torrent_dht.save_state() {
            log::debug!("Torrent DHT lifecycle {task_id}: routing persistence failed: {error}");
        }

        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(DHT_ANNOUNCE_REFRESH_INTERVAL) => {}
        }
    }
}

fn merge_discovered_dht_peers(
    state: &SharedState,
    task_id: &str,
    discovered: &[SocketAddr],
) {
    let mut jobs = lock_or_err!(state.torrent_jobs);
    let Some(job) = jobs.get_mut(task_id) else {
        return;
    };
    if job.private || job.requires_reauth {
        return;
    }

    let mut seen = job.candidates.iter().copied().collect::<HashSet<_>>();
    let mut added = 0usize;
    for peer in discovered.iter().copied() {
        if peer.port() == 0 || !state.torrent_dht.engine().address_allowed(peer) {
            continue;
        }
        if seen.insert(peer) && job.candidates.len() < 2_048 {
            job.candidates.push(peer);
            added = added.saturating_add(1);
        }
    }
    job.dht_peer_count = discovered.len().min(MAX_DHT_PEERS);
    if added > 0 {
        state.mark_dirty();
    }
}

pub fn configured_dht_port() -> u16 {
    std::env::var("NOVA_TORRENT_DHT_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or_else(crate::daemon::torrent_seed::configured_seed_port)
}

pub fn active_dht_port() -> Option<u16> {
    let port = ACTIVE_TORRENT_DHT_PORT.load(Ordering::Acquire);
    (port != 0).then_some(port)
}

#[derive(Clone, Debug)]
pub struct DhtConfig {
    pub bootstrap: Vec<String>,
    pub query_timeout: Duration,
    pub bootstrap_timeout: Duration,
    pub alpha: usize,
    pub max_queries: usize,
    pub max_candidates: usize,
    pub max_peers: usize,
}

impl Default for DhtConfig {
    fn default() -> Self {
        Self {
            bootstrap: DEFAULT_BOOTSTRAP.iter().map(|value| (*value).to_owned()).collect(),
            query_timeout: Duration::from_secs(4),
            bootstrap_timeout: Duration::from_secs(5),
            alpha: 3,
            max_queries: 96,
            max_candidates: 512,
            max_peers: 256,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DhtAnnounceTarget {
    pub address: SocketAddr,
    pub token: Vec<u8>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DhtDiscovery {
    pub peers: Vec<SocketAddr>,
    pub announce_targets: Vec<DhtAnnounceTarget>,
    pub queried_nodes: usize,
    pub responding_nodes: usize,
}

#[derive(Clone, Debug)]
pub struct DhtEngine {
    node_id: DhtNodeId,
    config: DhtConfig,
    allow_private_network: bool,
    routing: Arc<Mutex<DhtRoutingTable>>,
    transport: Arc<DhtSharedTransport>,
}

impl DhtEngine {
    pub fn new(node_id: DhtNodeId, config: DhtConfig) -> Self {
        Self::with_routing(node_id, config, Vec::new())
    }

    pub fn with_routing(
        node_id: DhtNodeId,
        config: DhtConfig,
        entries: Vec<DhtRoutingSnapshotEntry>,
    ) -> Self {
        let allow_private_network = private_network_allowed();
        let mut routing = DhtRoutingTable::new(node_id);
        let cutoff = unix_now().saturating_sub(DHT_ROUTING_MAX_AGE_SECS);
        let mut entries = entries
            .into_iter()
            .filter(|entry| entry.last_seen_unix >= cutoff)
            .filter(|entry| {
                entry.node.address.port() != 0
                    && !is_unspecified_or_broadcast(entry.node.address.ip())
                    && (allow_private_network || !is_internal_ip(entry.node.address.ip()))
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.last_seen_unix);
        for entry in entries {
            routing.record_at(entry.node, entry.last_seen_unix);
        }
        Self {
            node_id,
            config,
            allow_private_network,
            routing: Arc::new(Mutex::new(routing)),
            transport: Arc::new(DhtSharedTransport::new()),
        }
    }

    pub fn production_default() -> Self {
        Self::new(generate_dht_node_id(), DhtConfig::default())
    }

    pub const fn node_id(&self) -> DhtNodeId {
        self.node_id
    }

    async fn attach_socket(&self, socket: Option<Arc<UdpSocket>>) {
        self.transport.set_socket(socket).await;
    }

    async fn deliver_shared_response(
        &self,
        source: SocketAddr,
        message: DhtMessage,
    ) -> bool {
        self.transport.deliver(source, message).await
    }

    pub fn record_node(&self, node: nova_torrent_core::DhtNode) {
        if node.id == self.node_id || !self.address_allowed(node.address) {
            return;
        }
        match self.routing.lock() {
            Ok(mut routing) => routing.record(node),
            Err(poison) => poison.into_inner().record(node),
        }
    }

    pub fn routing_snapshot(&self) -> Vec<DhtRoutingSnapshotEntry> {
        match self.routing.lock() {
            Ok(routing) => routing.snapshot(),
            Err(poison) => poison.into_inner().snapshot(),
        }
    }

    pub fn prune_routing(&self) {
        match self.routing.lock() {
            Ok(mut routing) => routing.prune(),
            Err(poison) => poison.into_inner().prune(),
        }
    }

    pub fn closest_nodes_for_info_hash(
        &self,
        target: InfoHash,
        limit: usize,
    ) -> Vec<nova_torrent_core::DhtNode> {
        match self.routing.lock() {
            Ok(routing) => routing.closest_to_info_hash(target, limit),
            Err(poison) => poison.into_inner().closest_to_info_hash(target, limit),
        }
    }

    pub fn closest_nodes_for_node(
        &self,
        target: DhtNodeId,
        limit: usize,
    ) -> Vec<nova_torrent_core::DhtNode> {
        match self.routing.lock() {
            Ok(routing) => routing.closest_to_node(target, limit),
            Err(poison) => poison.into_inner().closest_to_node(target, limit),
        }
    }

    pub async fn discover_peers(
        &self,
        info_hash: InfoHash,
        cancel: &CancellationToken,
    ) -> Result<DhtDiscovery, String> {
        let bootstrap = self.resolve_bootstrap(cancel).await?;
        if bootstrap.is_empty() {
            return Err("No usable DHT bootstrap nodes resolved".to_owned());
        }

        let alpha = self.config.alpha.clamp(1, 16);
        let max_queries = self.config.max_queries.clamp(1, 4_096);
        let max_candidates = self.config.max_candidates.clamp(alpha, 8_192);
        let max_peers = self.config.max_peers.clamp(1, MAX_DHT_PEERS);

        let known_ids = self
            .routing_snapshot()
            .into_iter()
            .map(|entry| (entry.node.address, entry.node.id))
            .collect::<HashMap<_, _>>();
        let mut candidates = bootstrap
            .into_iter()
            .map(|address| Candidate {
                id: known_ids.get(&address).copied(),
                address,
            })
            .collect::<Vec<_>>();
        let mut known_addresses = candidates
            .iter()
            .map(|candidate| candidate.address)
            .collect::<HashSet<_>>();
        let mut queried = HashSet::new();
        let mut peers = HashSet::new();
        let mut announce_tokens = HashMap::<SocketAddr, Vec<u8>>::new();
        let mut queried_nodes = 0usize;
        let mut responding_nodes = 0usize;

        while queried_nodes < max_queries && peers.len() < max_peers {
            candidates.sort_by(|left, right| candidate_cmp(left, right, info_hash));

            let mut batch = Vec::new();
            for candidate in &candidates {
                if batch.len() >= alpha || queried_nodes + batch.len() >= max_queries {
                    break;
                }
                if queried.insert(candidate.address) {
                    batch.push(candidate.clone());
                }
            }
            if batch.is_empty() {
                break;
            }

            let mut tasks = JoinSet::new();
            for candidate in batch {
                let engine = self.clone();
                let child = cancel.child_token();
                tasks.spawn(async move {
                    let result = engine
                        .query_get_peers(candidate.address, info_hash, &child)
                        .await;
                    (candidate, result)
                });
            }

            while let Some(joined) = tasks.join_next().await {
                if cancel.is_cancelled() {
                    tasks.abort_all();
                    return Err("DHT peer discovery cancelled".to_owned());
                }

                queried_nodes = queried_nodes.saturating_add(1);
                let Ok((candidate, result)) = joined else {
                    continue;
                };
                let response = match result {
                    Ok(response) => response,
                    Err(_) => continue,
                };
                responding_nodes = responding_nodes.saturating_add(1);
                self.record_node(nova_torrent_core::DhtNode {
                    id: response.id,
                    address: candidate.address,
                });

                if let Some(token) = response.token {
                    announce_tokens.insert(candidate.address, token);
                }

                for peer in response.peers {
                    if peer.port() == 0 || !self.address_allowed(peer) {
                        continue;
                    }
                    peers.insert(peer);
                    if peers.len() >= max_peers {
                        break;
                    }
                }

                if peers.len() >= max_peers {
                    continue;
                }

                for node in response.nodes {
                    if node.address.port() == 0 || !self.address_allowed(node.address) {
                        continue;
                    }
                    self.record_node(node);
                    if known_addresses.len() >= max_candidates {
                        continue;
                    }
                    if known_addresses.insert(node.address) {
                        candidates.push(Candidate {
                            id: Some(node.id),
                            address: node.address,
                        });
                    }
                }
            }
        }

        let mut peers = peers.into_iter().collect::<Vec<_>>();
        peers.sort_unstable();

        let mut announce_targets = announce_tokens
            .into_iter()
            .map(|(address, token)| DhtAnnounceTarget { address, token })
            .collect::<Vec<_>>();
        announce_targets.sort_by_key(|target| target.address);

        Ok(DhtDiscovery {
            peers,
            announce_targets,
            queried_nodes,
            responding_nodes,
        })
    }

    pub async fn announce_peer(
        &self,
        target: &DhtAnnounceTarget,
        info_hash: InfoHash,
        port: u16,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if port == 0 {
            return Err("DHT announce port cannot be zero".to_owned());
        }
        if !self.address_allowed(target.address) {
            return Err(format!(
                "DHT announce target {} is blocked by network policy",
                target.address
            ));
        }

        let transaction_id = transaction_id();
        let query = DhtMessage::Query {
            transaction_id: transaction_id.clone(),
            query: DhtQuery::AnnouncePeer {
                id: self.node_id,
                info_hash,
                port,
                token: target.token.clone(),
                implied_port: false,
            },
        };
        let response = self
            .exchange(target.address, query, &transaction_id, cancel)
            .await?;
        match response {
            DhtMessage::Response { .. } => Ok(()),
            DhtMessage::Error { code, message, .. } => {
                Err(format!("DHT announce rejected ({code}): {message}"))
            }
            _ => Err("DHT announce returned an unexpected message".to_owned()),
        }
    }

    async fn query_get_peers(
        &self,
        address: SocketAddr,
        info_hash: InfoHash,
        cancel: &CancellationToken,
    ) -> Result<DhtResponse, String> {
        if !self.address_allowed(address) {
            return Err(format!("DHT node {address} is blocked by network policy"));
        }
        let transaction_id = transaction_id();
        let query = DhtMessage::Query {
            transaction_id: transaction_id.clone(),
            query: DhtQuery::GetPeers {
                id: self.node_id,
                info_hash,
            },
        };
        match self
            .exchange(address, query, &transaction_id, cancel)
            .await?
        {
            DhtMessage::Response { response, .. } => Ok(response),
            DhtMessage::Error { code, message, .. } => {
                Err(format!("DHT node {address} returned error {code}: {message}"))
            }
            _ => Err(format!("DHT node {address} returned an unexpected message")),
        }
    }

    async fn exchange(
        &self,
        address: SocketAddr,
        query: DhtMessage,
        expected_transaction: &[u8],
        cancel: &CancellationToken,
    ) -> Result<DhtMessage, String> {
        let packet = query
            .encode()
            .map_err(|error| format!("Could not encode DHT query: {error}"))?;

        if let Some(socket) = self.transport.socket().await.filter(|socket| {
            socket
                .local_addr()
                .map(|local| local.is_ipv4() == address.is_ipv4())
                .unwrap_or(false)
        }) {
            let receiver = self
                .transport
                .register(expected_transaction.to_vec(), address)
                .await?;
            let sent = tokio::select! {
                _ = cancel.cancelled() => {
                    self.transport.remove(expected_transaction).await;
                    return Err("DHT query cancelled".to_owned());
                }
                result = timeout(self.config.query_timeout, socket.send_to(&packet, address)) => {
                    match result {
                        Ok(Ok(sent)) => sent,
                        Ok(Err(error)) => {
                            self.transport.remove(expected_transaction).await;
                            return Err(format!("DHT send to {address} failed: {error}"));
                        }
                        Err(_) => {
                            self.transport.remove(expected_transaction).await;
                            return Err(format!("DHT send to {address} timed out"));
                        }
                    }
                }
            };
            if sent != packet.len() {
                self.transport.remove(expected_transaction).await;
                return Err(format!(
                    "DHT datagram to {address} was truncated: {sent}/{} bytes",
                    packet.len()
                ));
            }

            let message = tokio::select! {
                _ = cancel.cancelled() => {
                    self.transport.remove(expected_transaction).await;
                    return Err("DHT query cancelled".to_owned());
                }
                result = timeout(self.config.query_timeout, receiver) => {
                    match result {
                        Ok(Ok(message)) => message,
                        Ok(Err(_)) => {
                            return Err(format!("DHT response channel from {address} closed"));
                        }
                        Err(_) => {
                            self.transport.remove(expected_transaction).await;
                            return Err(format!("DHT receive from {address} timed out"));
                        }
                    }
                }
            };
            return Ok(message);
        }

        // Bootstrap/tests can run before the process-wide DHT listener is
        // attached. Fall back to a bounded one-shot socket in that case.
        let bind = if address.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let socket = UdpSocket::bind(bind)
            .await
            .map_err(|error| format!("Could not bind DHT UDP socket: {error}"))?;
        socket
            .connect(address)
            .await
            .map_err(|error| format!("Could not connect DHT UDP socket to {address}: {error}"))?;

        let sent = tokio::select! {
            _ = cancel.cancelled() => return Err("DHT query cancelled".to_owned()),
            result = timeout(self.config.query_timeout, socket.send(&packet)) => {
                result
                    .map_err(|_| format!("DHT send to {address} timed out"))?
                    .map_err(|error| format!("DHT send to {address} failed: {error}"))?
            }
        };
        if sent != packet.len() {
            return Err(format!(
                "DHT datagram to {address} was truncated: {sent}/{} bytes",
                packet.len()
            ));
        }

        let mut buffer = vec![0u8; MAX_DHT_PACKET_BYTES];
        let received = tokio::select! {
            _ = cancel.cancelled() => return Err("DHT query cancelled".to_owned()),
            result = timeout(self.config.query_timeout, socket.recv(&mut buffer)) => {
                result
                    .map_err(|_| format!("DHT receive from {address} timed out"))?
                    .map_err(|error| format!("DHT receive from {address} failed: {error}"))?
            }
        };
        buffer.truncate(received);

        let message = DhtMessage::parse(&buffer)
            .map_err(|error| format!("DHT node {address} returned invalid KRPC: {error}"))?;
        let actual_transaction = match &message {
            DhtMessage::Query { transaction_id, .. }
            | DhtMessage::Response { transaction_id, .. }
            | DhtMessage::Error { transaction_id, .. } => transaction_id,
        };
        if actual_transaction.as_slice() != expected_transaction {
            return Err(format!("DHT node {address} returned a mismatched transaction id"));
        }
        Ok(message)
    }

    async fn resolve_bootstrap(
        &self,
        cancel: &CancellationToken,
    ) -> Result<Vec<SocketAddr>, String> {
        let mut resolved = self
            .routing_snapshot()
            .into_iter()
            .map(|entry| entry.node.address)
            .filter(|address| self.address_allowed(*address))
            .collect::<Vec<_>>();
        resolved.sort_unstable();
        resolved.dedup();
        resolved.truncate(self.config.max_candidates.max(1));

        for bootstrap in &self.config.bootstrap {
            if resolved.len() >= self.config.max_candidates.max(1) {
                break;
            }
            let lookup = tokio::select! {
                _ = cancel.cancelled() => return Err("DHT bootstrap resolution cancelled".to_owned()),
                result = timeout(self.config.bootstrap_timeout, lookup_host(bootstrap.as_str())) => {
                    match result {
                        Ok(Ok(addresses)) => addresses.collect::<Vec<_>>(),
                        Ok(Err(_)) | Err(_) => Vec::new(),
                    }
                }
            };

            if !self.allow_private_network
                && lookup
                    .iter()
                    .any(|address| is_internal_ip(address.ip()) || is_unspecified_or_broadcast(address.ip()))
            {
                continue;
            }

            for address in lookup {
                if self.address_allowed(address) && !resolved.contains(&address) {
                    resolved.push(address);
                }
            }
        }
        Ok(resolved)
    }

    pub(crate) fn address_allowed(&self, address: SocketAddr) -> bool {
        address.port() != 0
            && (self.allow_private_network || !is_internal_ip(address.ip()))
            && !is_unspecified_or_broadcast(address.ip())
    }

    #[cfg(test)]
    pub(crate) fn for_tests(node_id: DhtNodeId, config: DhtConfig) -> Self {
        Self {
            node_id,
            config,
            allow_private_network: true,
            routing: Arc::new(Mutex::new(DhtRoutingTable::new(node_id))),
            transport: Arc::new(DhtSharedTransport::new()),
        }
    }
}

fn load_dht_state(path: &Path) -> Option<PersistedDhtState> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_DHT_STATE_BYTES {
        log::warn!("Ignoring oversized DHT state file {}", path.display());
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let state = serde_json::from_slice::<PersistedDhtState>(&bytes).ok()?;
    if state.version != DHT_STATE_VERSION {
        log::warn!(
            "Ignoring unsupported DHT state version {} in {}",
            state.version,
            path.display()
        );
        return None;
    }
    Some(state)
}

fn node_id_hex(id: DhtNodeId) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(40);
    for &byte in id.as_bytes() {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn parse_node_id_hex(value: &str) -> Option<DhtNodeId> {
    if value.len() != 40 {
        return None;
    }
    let raw = value.as_bytes();
    let mut bytes = [0u8; 20];
    for index in 0..20 {
        let high = hex_nibble(raw[index * 2])?;
        let low = hex_nibble(raw[index * 2 + 1])?;
        bytes[index] = (high << 4) | low;
    }
    Some(DhtNodeId::new(bytes))
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn random_secret() -> [u8; 20] {
    let first = *uuid::Uuid::new_v4().as_bytes();
    let second = *uuid::Uuid::new_v4().as_bytes();
    let mut secret = [0u8; 20];
    secret[..16].copy_from_slice(&first);
    secret[16..].copy_from_slice(&second[..4]);
    secret
}

fn token_digest(secret: &[u8; 20], ip: IpAddr) -> [u8; 20] {
    let mut hash = Sha1::new();
    hash.update(secret);
    match ip {
        IpAddr::V4(ip) => hash.update(ip.octets()),
        IpAddr::V6(ip) => hash.update(ip.octets()),
    }
    let digest = hash.finalize();
    let mut token = [0u8; 20];
    token.copy_from_slice(&digest);
    token
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (left, right)| diff | (*left ^ *right))
        == 0
}

fn prune_peer_store(peers: &mut HashMap<InfoHash, Vec<StoredPeer>>) {
    for values in peers.values_mut() {
        values.retain(|peer| peer.seen_at.elapsed() <= DHT_PEER_TTL);
    }
    peers.retain(|_, values| !values.is_empty());
}

fn local_torrent_dht_blocked(state: &SharedState, info_hash: InfoHash) -> bool {
    let hex = info_hash.to_hex();
    let jobs = lock_or_err!(state.torrent_jobs);
    jobs.values().any(|job| {
        job.task.engine_id.eq_ignore_ascii_case(&hex)
            && (job.private || job.requires_reauth)
    })
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn bucket_index(local: DhtNodeId, remote: DhtNodeId) -> Option<usize> {
    let distance = xor_node_distance(local, remote);
    if distance.iter().all(|byte| *byte == 0) {
        return None;
    }
    let leading = distance
        .iter()
        .take_while(|byte| **byte == 0)
        .count()
        .saturating_mul(8)
        + distance
            .iter()
            .find(|byte| **byte != 0)
            .map(|byte| byte.leading_zeros() as usize)
            .unwrap_or(0);
    Some(leading.min(DHT_BUCKET_COUNT - 1))
}

fn xor_node_distance(left: DhtNodeId, right: DhtNodeId) -> [u8; 20] {
    let mut distance = [0u8; 20];
    for (index, output) in distance.iter_mut().enumerate() {
        *output = left.as_bytes()[index] ^ right.as_bytes()[index];
    }
    distance
}

#[derive(Clone, Debug)]
struct Candidate {
    id: Option<DhtNodeId>,
    address: SocketAddr,
}

fn candidate_cmp(left: &Candidate, right: &Candidate, target: InfoHash) -> std::cmp::Ordering {
    match (left.id, right.id) {
        (Some(left_id), Some(right_id)) => left_id
            .xor_distance(target)
            .cmp(&right_id.xor_distance(target))
            .then_with(|| left.address.cmp(&right.address)),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, None) => left.address.cmp(&right.address),
    }
}

fn transaction_id() -> Vec<u8> {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    bytes[..4].to_vec()
}

pub fn generate_dht_node_id() -> DhtNodeId {
    let first = *uuid::Uuid::new_v4().as_bytes();
    let second = *uuid::Uuid::new_v4().as_bytes();
    let mut bytes = [0u8; 20];
    bytes[..16].copy_from_slice(&first);
    bytes[16..].copy_from_slice(&second[..4]);
    DhtNodeId::new(bytes)
}

fn is_unspecified_or_broadcast(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_unspecified() || ip.is_broadcast(),
        IpAddr::V6(ip) => ip.is_unspecified(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UdpSocket;

    fn id(byte: u8) -> DhtNodeId {
        DhtNodeId::new([byte; 20])
    }

    async fn recv_query(socket: &UdpSocket) -> (SocketAddr, Vec<u8>, DhtQuery) {
        let mut buffer = vec![0u8; MAX_DHT_PACKET_BYTES];
        let (length, peer) = socket.recv_from(&mut buffer).await.unwrap();
        buffer.truncate(length);
        let message = DhtMessage::parse(&buffer).unwrap();
        match message {
            DhtMessage::Query {
                transaction_id,
                query,
            } => (peer, transaction_id, query),
            other => panic!("expected DHT query, got {other:?}"),
        }
    }

    #[test]
    fn dht_service_get_peers_token_allows_announce() {
        let root = std::env::temp_dir().join(format!(
            "nova-dht-service-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let service = DhtService::for_tests(id(9), root.join(DHT_STATE_FILE_NAME));
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &root.display().to_string(),
        ));
        let source: SocketAddr = "8.8.8.8:50000".parse().unwrap();
        let hash = InfoHash::new([0x44; 20]);

        let request = DhtMessage::Query {
            transaction_id: b"gp".to_vec(),
            query: DhtQuery::GetPeers {
                id: id(3),
                info_hash: hash,
            },
        };
        let response = service
            .handle_packet(&state, source, &request.encode().unwrap())
            .unwrap();
        let token = match response {
            DhtMessage::Response { response, .. } => response.token.unwrap(),
            other => panic!("expected response, got {other:?}"),
        };

        let announce = DhtMessage::Query {
            transaction_id: b"ap".to_vec(),
            query: DhtQuery::AnnouncePeer {
                id: id(3),
                info_hash: hash,
                port: 51413,
                token,
                implied_port: false,
            },
        };
        assert!(matches!(
            service.handle_packet(&state, source, &announce.encode().unwrap()),
            Some(DhtMessage::Response { .. })
        ));
        assert_eq!(
            service.peers_for(hash),
            vec!["8.8.8.8:51413".parse::<SocketAddr>().unwrap()]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn private_torrent_get_peers_does_not_issue_announce_token() {
        use crate::daemon::engine::bandwidth::BandwidthManager;
        use crate::daemon::torrent_task::restore_torrent_job;
        use crate::daemon::types::{Task, TaskState};

        let root = std::env::temp_dir().join(format!(
            "nova-dht-private-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let service = DhtService::for_tests(id(9), root.join(DHT_STATE_FILE_NAME));
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(
            &root.display().to_string(),
        ));
        let hash = InfoHash::new([0x55; 20]);
        let source_uri = format!("magnet:?xt=urn:btih:{}", hash.to_hex());
        let task = Task {
            id: "private-dht".to_owned(),
            name: "private.bin".to_owned(),
            url: source_uri.clone(),
            file_type: "torrent".to_owned(),
            status: TaskState::Paused.as_status().to_owned(),
            size_bytes: 1,
            downloaded_bytes: 0,
            speed_bytes_per_sec: 0,
            time_left_seconds: 0,
            elapsed_seconds: 0,
            date_added: "2026-09-25T00:00:00Z".to_owned(),
            category: "torrent".to_owned(),
            queue_id: "main".to_owned(),
            connections: 1,
            resumable: true,
            save_path: root.join("payload").display().to_string(),
            description: "private dht test".to_owned(),
            segments: Vec::new(),
            referer: None,
            engine: nova_torrent_core::ENGINE_ID.to_owned(),
            engine_id: hash.to_hex(),
            engine_status: None,
            error_message: None,
        };
        let mut job = restore_torrent_job(
            task,
            Some(source_uri),
            false,
            BandwidthManager::default(),
            None,
        )
        .unwrap();
        job.private = true;
        state
            .torrent_jobs
            .lock()
            .unwrap()
            .insert("private-dht".to_owned(), job);

        let request = DhtMessage::Query {
            transaction_id: b"pr".to_vec(),
            query: DhtQuery::GetPeers {
                id: id(3),
                info_hash: hash,
            },
        };
        let response = service
            .handle_packet(
                &state,
                "8.8.8.8:50000".parse().unwrap(),
                &request.encode().unwrap(),
            )
            .unwrap();
        match response {
            DhtMessage::Response { response, .. } => {
                assert!(response.token.is_none());
                assert!(response.peers.is_empty());
            }
            other => panic!("expected response, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rotating_tokens_are_bound_to_ip() {
        let mut tokens = DhtTokenState::new();
        let ip_a: IpAddr = "8.8.8.8".parse().unwrap();
        let ip_b: IpAddr = "1.1.1.1".parse().unwrap();
        let token = tokens.issue(ip_a);
        assert!(tokens.validate(ip_a, &token));
        assert!(!tokens.validate(ip_b, &token));
    }

    #[test]
    fn dht_state_round_trip_preserves_node_id_and_routing() {
        let root = std::env::temp_dir().join(format!(
            "nova-dht-state-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(DHT_STATE_FILE_NAME);
        let service = DhtService::for_tests(id(4), path.clone());
        service.engine.record_node(nova_torrent_core::DhtNode {
            id: id(5),
            address: "8.8.8.8:6881".parse().unwrap(),
        });
        service.save_state().unwrap();

        let loaded = load_dht_state(&path).unwrap();
        assert_eq!(parse_node_id_hex(&loaded.node_id), Some(id(4)));
        assert_eq!(loaded.nodes.len(), 1);
        assert_eq!(loaded.nodes[0].address, "8.8.8.8:6881");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn routing_table_is_bucket_bounded_and_lru_refreshed() {
        let local = id(0);
        let mut table = DhtRoutingTable::new(local);
        for value in 1u8..=20 {
            table.record_at(
                nova_torrent_core::DhtNode {
                    id: DhtNodeId::new([value; 20]),
                    address: SocketAddr::from(([8, 8, 8, value], 6000 + u16::from(value))),
                },
                u64::from(value),
            );
        }
        assert!(table.snapshot().len() <= DHT_BUCKET_COUNT * DHT_BUCKET_SIZE);
        for bucket in &table.buckets {
            assert!(bucket.len() <= DHT_BUCKET_SIZE);
        }
    }

    #[test]
    fn routing_snapshot_restores_recent_nodes_only() {
        let now = unix_now();
        let recent = DhtRoutingSnapshotEntry {
            node: nova_torrent_core::DhtNode {
                id: id(2),
                address: "8.8.8.8:6881".parse().unwrap(),
            },
            last_seen_unix: now,
        };
        let stale = DhtRoutingSnapshotEntry {
            node: nova_torrent_core::DhtNode {
                id: id(3),
                address: "1.1.1.1:6881".parse().unwrap(),
            },
            last_seen_unix: now.saturating_sub(DHT_ROUTING_MAX_AGE_SECS + 1),
        };
        let table = DhtRoutingTable::restore(id(1), &[recent, stale]);
        let snapshot = table.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].node, recent.node);
    }

    #[tokio::test]
    async fn shared_transport_uses_long_lived_listener_port() {
        let remote = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let remote_address = remote.local_addr().unwrap();
        let local = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let local_address = local.local_addr().unwrap();
        let engine = DhtEngine::for_tests(
            id(7),
            DhtConfig {
                query_timeout: Duration::from_secs(2),
                ..DhtConfig::default()
            },
        );
        engine.attach_socket(Some(local.clone())).await;

        let server_engine = engine.clone();
        let receiver = tokio::spawn(async move {
            let mut buffer = vec![0u8; MAX_DHT_PACKET_BYTES];
            let (length, source) = remote.recv_from(&mut buffer).await.unwrap();
            assert_eq!(source.port(), local_address.port());
            let query = DhtMessage::parse(&buffer[..length]).unwrap();
            let transaction_id = match query {
                DhtMessage::Query { transaction_id, .. } => transaction_id,
                other => panic!("expected query, got {other:?}"),
            };
            let response = DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: id(8),
                    token: Some(vec![1, 2, 3]),
                    nodes: Vec::new(),
                    peers: Vec::new(),
                },
            };
            remote
                .send_to(&response.encode().unwrap(), source)
                .await
                .unwrap();
        });

        let demux_engine = server_engine.clone();
        let demux_socket = local.clone();
        let demux = tokio::spawn(async move {
            let mut buffer = vec![0u8; MAX_DHT_PACKET_BYTES];
            let (length, source) = demux_socket.recv_from(&mut buffer).await.unwrap();
            let message = DhtMessage::parse(&buffer[..length]).unwrap();
            assert!(demux_engine.deliver_shared_response(source, message).await);
        });

        let response = server_engine
            .query_get_peers(
                remote_address,
                InfoHash::new([3u8; 20]),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.id, id(8));
        receiver.await.unwrap();
        demux.await.unwrap();
    }

    #[tokio::test]
    async fn dht_iterative_lookup_reaches_second_node_and_discovers_peer() {
        let bootstrap_socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let bootstrap_address = bootstrap_socket.local_addr().unwrap();
        let second_socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let second_address = second_socket.local_addr().unwrap();
        let target = InfoHash::new([9u8; 20]);

        let bootstrap_task = tokio::spawn(async move {
            let (peer, transaction_id, query) = recv_query(&bootstrap_socket).await;
            assert!(matches!(
                query,
                DhtQuery::GetPeers { info_hash, .. } if info_hash == target
            ));
            let response = DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: id(1),
                    token: Some(vec![1, 2, 3]),
                    nodes: vec![DhtNode {
                        id: id(8),
                        address: second_address,
                    }],
                    peers: Vec::new(),
                },
            };
            bootstrap_socket
                .send_to(&response.encode().unwrap(), peer)
                .await
                .unwrap();
        });

        let second_task = tokio::spawn(async move {
            let (peer, transaction_id, query) = recv_query(&second_socket).await;
            assert!(matches!(query, DhtQuery::GetPeers { .. }));
            let response = DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: id(8),
                    token: Some(vec![4, 5, 6]),
                    nodes: Vec::new(),
                    peers: vec!["127.0.0.1:51413".parse().unwrap()],
                },
            };
            second_socket
                .send_to(&response.encode().unwrap(), peer)
                .await
                .unwrap();
        });

        let engine = DhtEngine::for_tests(
            id(7),
            DhtConfig {
                bootstrap: vec![bootstrap_address.to_string()],
                query_timeout: Duration::from_secs(2),
                bootstrap_timeout: Duration::from_secs(2),
                alpha: 1,
                max_queries: 4,
                max_candidates: 16,
                max_peers: 16,
            },
        );
        let discovery = engine
            .discover_peers(target, &CancellationToken::new())
            .await
            .expect("discover peers");

        assert_eq!(discovery.peers, vec!["127.0.0.1:51413".parse().unwrap()]);
        assert_eq!(discovery.responding_nodes, 2);
        assert_eq!(discovery.announce_targets.len(), 2);
        bootstrap_task.await.unwrap();
        second_task.await.unwrap();
    }

    #[tokio::test]
    async fn dht_announce_peer_uses_returned_token() {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let info_hash = InfoHash::new([3u8; 20]);

        let server = tokio::spawn(async move {
            let (peer, transaction_id, query) = recv_query(&socket).await;
            assert!(matches!(
                query,
                DhtQuery::AnnouncePeer {
                    info_hash: hash,
                    port: 6881,
                    ref token,
                    ..
                } if hash == info_hash && token == &[7, 8, 9]
            ));
            let response = DhtMessage::Response {
                transaction_id,
                response: DhtResponse {
                    id: id(4),
                    token: None,
                    nodes: Vec::new(),
                    peers: Vec::new(),
                },
            };
            socket
                .send_to(&response.encode().unwrap(), peer)
                .await
                .unwrap();
        });

        let engine = DhtEngine::for_tests(
            id(2),
            DhtConfig {
                bootstrap: Vec::new(),
                ..DhtConfig::default()
            },
        );
        engine
            .announce_peer(
                &DhtAnnounceTarget {
                    address,
                    token: vec![7, 8, 9],
                },
                info_hash,
                6881,
                &CancellationToken::new(),
            )
            .await
            .expect("announce");
        server.await.unwrap();
    }

    #[test]
    fn production_policy_rejects_internal_dht_targets() {
        let mut engine = DhtEngine::production_default();
        engine.allow_private_network = false;
        assert!(!engine.address_allowed("127.0.0.1:6881".parse().unwrap()));
        assert!(engine.address_allowed("1.1.1.1:6881".parse().unwrap()));
    }
}
