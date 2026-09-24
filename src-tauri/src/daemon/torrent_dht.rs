use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use nova_torrent_core::{
    DhtMessage, DhtNodeId, DhtQuery, DhtResponse, InfoHash, MAX_DHT_PACKET_BYTES,
    MAX_DHT_PEERS,
};
use tokio::net::{lookup_host, UdpSocket};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::daemon::utils::{is_internal_ip, private_network_allowed};

const DEFAULT_BOOTSTRAP: &[&str] = &[
    "router.bittorrent.com:6881",
    "dht.transmissionbt.com:6881",
    "router.utorrent.com:6881",
];

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
}

impl DhtEngine {
    pub fn new(node_id: DhtNodeId, config: DhtConfig) -> Self {
        Self {
            node_id,
            config,
            allow_private_network: private_network_allowed(),
        }
    }

    pub fn production_default() -> Self {
        Self::new(generate_dht_node_id(), DhtConfig::default())
    }

    pub const fn node_id(&self) -> DhtNodeId {
        self.node_id
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

        let mut candidates = bootstrap
            .into_iter()
            .map(|address| Candidate { id: None, address })
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
                    if known_addresses.len() >= max_candidates {
                        break;
                    }
                    if node.address.port() == 0 || !self.address_allowed(node.address) {
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

        let packet = query
            .encode()
            .map_err(|error| format!("Could not encode DHT query: {error}"))?;
        tokio::select! {
            _ = cancel.cancelled() => return Err("DHT query cancelled".to_owned()),
            result = timeout(self.config.query_timeout, socket.send(&packet)) => {
                let sent = result
                    .map_err(|_| format!("DHT send to {address} timed out"))?
                    .map_err(|error| format!("DHT send to {address} failed: {error}"))?;
                if sent != packet.len() {
                    return Err(format!(
                        "DHT datagram to {address} was truncated: {sent}/{} bytes",
                        packet.len()
                    ));
                }
            }
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
        let mut resolved = Vec::new();
        for bootstrap in &self.config.bootstrap {
            let lookup = tokio::select! {
                _ = cancel.cancelled() => return Err("DHT bootstrap resolution cancelled".to_owned()),
                result = timeout(self.config.bootstrap_timeout, lookup_host(bootstrap)) => {
                    match result {
                        Ok(Ok(addresses)) => addresses.collect::<Vec<_>>(),
                        Ok(Err(_)) | Err(_) => Vec::new(),
                    }
                }
            };

            for address in lookup {
                if self.address_allowed(address) && !resolved.contains(&address) {
                    resolved.push(address);
                }
            }
        }
        Ok(resolved)
    }

    fn address_allowed(&self, address: SocketAddr) -> bool {
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
        }
    }
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
