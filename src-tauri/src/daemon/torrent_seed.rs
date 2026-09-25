use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;

use nova_torrent_core::{
    ExtendedHandshake, InfoHash, MetadataMessage, PeerExchange, PeerHandshake, PeerMessage,
    EXTENSION_HANDSHAKE_ID, LOCAL_UT_METADATA_ID, LOCAL_UT_PEX_ID, MAX_PEER_FRAME_BYTES,
    METADATA_PIECE_SIZE, PEER_HANDSHAKE_LEN,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::daemon::state::SharedState;
use crate::daemon::torrent_bandwidth::TorrentBandwidthLimiter;
use crate::daemon::torrent_seeding::TorrentSeedingControl;
use crate::daemon::torrent_storage::TorrentStorageSession;
use crate::daemon::torrent_task::ensure_storage_session;
use crate::daemon::types::TaskState;
use crate::daemon::utils::{is_internal_ip, private_network_allowed};
use crate::lock_or_err;

pub const DEFAULT_TORRENT_SEED_PORT: u16 = 6881;
const MAX_SEED_CONTROL_FRAME_BYTES: usize = 64 * 1024;
const MAX_INBOUND_SEED_CONNECTIONS: usize = 64;
const MAX_METADATA_REQUESTS_PER_SESSION: u64 = 1_024;
const MAX_PEX_PEERS_PER_MESSAGE: usize = 50;
static ACTIVE_TORRENT_SEED_PORT: AtomicU16 = AtomicU16::new(0);

pub fn active_seed_port() -> Option<u16> {
    let port = ACTIVE_TORRENT_SEED_PORT.load(Ordering::Acquire);
    (port != 0).then_some(port)
}

pub fn configured_seed_port() -> u16 {
    std::env::var("NOVA_TORRENT_SEED_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port >= 1024)
        .unwrap_or(DEFAULT_TORRENT_SEED_PORT)
}

fn seed_listener_disabled() -> bool {
    std::env::var("NOVA_DISABLE_TORRENT_SEED")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

pub async fn run_inbound_seed_listener(
    state: SharedState,
    cancel: CancellationToken,
) -> Result<u16, String> {
    if seed_listener_disabled() {
        log::info!("Native torrent inbound seeding listener is disabled by environment.");
        return Ok(0);
    }

    let port = configured_seed_port();
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|error| format!("Could not bind native torrent seed listener on port {port}: {error}"))?;
    let local = listener
        .local_addr()
        .map_err(|error| format!("Could not read native torrent seed listener address: {error}"))?;
    ACTIVE_TORRENT_SEED_PORT.store(local.port(), Ordering::Release);
    log::info!("Native torrent inbound seeding listener started on {local}");

    let slots = Arc::new(Semaphore::new(MAX_INBOUND_SEED_CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            _ = cancel.cancelled() => break,
            result = listener.accept() => result,
        };
        let (stream, address) = match accepted {
            Ok(value) => value,
            Err(error) => {
                log::warn!("Native torrent seed listener accept failed: {error}");
                continue;
            }
        };

        if is_internal_ip(address.ip()) && !private_network_allowed() {
            log::debug!("Rejected inbound torrent peer on internal address {address}");
            continue;
        }

        let permit = match slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                log::debug!("Rejected inbound torrent peer {address}: connection limit reached");
                continue;
            }
        };

        let child_state = state.clone();
        let child_cancel = cancel.child_token();
        tokio::spawn(async move {
            let _permit = permit;
            let result = serve_state_peer(stream, address, child_state, &child_cancel).await;
            if let Err(error) = result {
                if !child_cancel.is_cancelled() {
                    log::debug!("Inbound torrent peer {address} ended: {error}");
                }
            }
        });
    }

    ACTIVE_TORRENT_SEED_PORT.store(0, Ordering::Release);
    Ok(port)
}

async fn serve_state_peer(
    mut stream: TcpStream,
    address: SocketAddr,
    state: SharedState,
    cancel: &CancellationToken,
) -> Result<SeedSessionStats, String> {
    let _ = stream.set_nodelay(true);
    let remote = read_inbound_handshake(
        &mut stream,
        SeedSessionConfig::default().handshake_timeout,
        cancel,
    )
    .await?;

    let info_hash_hex = remote.info_hash.to_hex();
    let job = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.values()
            .find(|job| {
                let task_state = TaskState::from_status(&job.task.status);
                job.task.engine_id.eq_ignore_ascii_case(&info_hash_hex)
                    && task_state.is_some_and(|task_state| {
                        task_state == TaskState::Completed || task_state.is_active()
                    })
                    && job.seeding.policy().enabled
                    && !job.requires_reauth
            })
            .cloned()
    }
    .ok_or_else(|| "Inbound peer requested a torrent that is not seed-eligible".to_owned())?;

    let storage = ensure_storage_session(&job, job.storage.clone()).await?;
    let extension_service = SeedExtensionService {
        metadata_info: storage.metadata_info_bytes(),
        pex_peers: if job.private {
            Vec::new()
        } else {
            build_pex_peers(&job.candidates, address)
        },
        allow_pex: !job.private,
    };
    let progress = storage
        .progress()
        .await
        .map_err(|error| format!("Could not read torrent seed progress: {error}"))?;
    let completed =
        TaskState::from_status(&job.task.status) == Some(TaskState::Completed);
    if !job
        .seeding
        .upload_allowed(completed, progress.selected_total_bytes)
    {
        return Err("Inbound torrent seeding is disabled or its configured limit was reached".to_owned());
    }

    job.active_seed_connections
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let session_cancel = CancellationToken::new();
    let cancellation_bridge = {
        let linked = session_cancel.clone();
        let daemon_cancel = cancel.clone();
        let seed_cancel = job.seed_cancel_token.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = daemon_cancel.cancelled() => linked.cancel(),
                _ = seed_cancel.cancelled() => linked.cancel(),
            }
        })
    };

    let result = serve_inbound_seed_session_after_handshake(
        stream,
        remote,
        storage,
        job.local_peer_id,
        Some(job.upload_limiter.clone()),
        Some(job.seeding.clone()),
        Some(job.seed_cancel_token.clone()),
        Some(state.clone()),
        completed,
        progress.selected_total_bytes,
        extension_service,
        SeedSessionConfig::default(),
        &session_cancel,
    )
    .await;
    cancellation_bridge.abort();
    job.active_seed_connections
        .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    result
}

#[derive(Clone, Debug, Default)]
struct SeedExtensionService {
    metadata_info: Option<Arc<Vec<u8>>>,
    pex_peers: Vec<SocketAddr>,
    allow_pex: bool,
}

impl SeedExtensionService {
    fn enabled(&self) -> bool {
        self.metadata_info.is_some() || self.allow_pex
    }

    fn local_handshake(&self) -> ExtendedHandshake {
        let mut handshake = ExtendedHandshake::local(
            self.metadata_info.as_ref().map(|bytes| bytes.len()),
        );
        if self.metadata_info.is_none() {
            handshake.ut_metadata = None;
        }
        if !self.allow_pex {
            handshake.ut_pex = None;
        }
        handshake
    }
}

#[derive(Clone, Debug)]
pub struct SeedSessionConfig {
    pub handshake_timeout: Duration,
    pub frame_timeout: Duration,
    pub max_requests: u64,
    pub max_uploaded_bytes: u64,
}

impl Default for SeedSessionConfig {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(8),
            frame_timeout: Duration::from_secs(30),
            max_requests: 16_384,
            max_uploaded_bytes: 512 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SeedSessionStats {
    pub requests_served: u64,
    pub uploaded_bytes: u64,
    pub metadata_requests_served: u64,
    pub metadata_bytes_served: u64,
    pub pex_messages_sent: u64,
    pub pex_peers_sent: u64,
}

pub async fn serve_inbound_seed_session(
    mut stream: TcpStream,
    expected_info_hash: InfoHash,
    storage: TorrentStorageSession,
    local_peer_id: [u8; 20],
    config: SeedSessionConfig,
    cancel: &CancellationToken,
) -> Result<SeedSessionStats, String> {
    let remote = read_inbound_handshake(&mut stream, config.handshake_timeout, cancel).await?;
    if remote.info_hash != expected_info_hash {
        return Err("Inbound peer requested a different torrent info hash".to_owned());
    }
    serve_inbound_seed_session_after_handshake(
        stream,
        remote,
        storage,
        local_peer_id,
        None,
        None,
        None,
        None,
        false,
        0,
        SeedExtensionService::default(),
        config,
        cancel,
    )
    .await
}

async fn serve_inbound_seed_session_after_handshake(
    mut stream: TcpStream,
    remote: PeerHandshake,
    storage: TorrentStorageSession,
    local_peer_id: [u8; 20],
    upload_limiter: Option<Arc<TorrentBandwidthLimiter>>,
    seeding: Option<TorrentSeedingControl>,
    seed_cancel: Option<CancellationToken>,
    dirty_state: Option<SharedState>,
    completed: bool,
    downloaded_bytes: u64,
    extensions: SeedExtensionService,
    config: SeedSessionConfig,
    cancel: &CancellationToken,
) -> Result<SeedSessionStats, String> {
    if remote.peer_id == local_peer_id {
        return Err("Inbound peer used NOVA's own peer id".to_owned());
    }
    let expected_info_hash = remote.info_hash;
    if let Some(control) = seeding.as_ref() {
        if !control.upload_allowed(completed, downloaded_bytes) {
            return Err("Inbound torrent seeding policy does not allow uploads".to_owned());
        }
    }

    let mut local = PeerHandshake::new(expected_info_hash, local_peer_id);
    if extensions.enabled() {
        local.reserved[5] |= 0x10;
    }
    write_message_bytes(
        &mut stream,
        &local.encode(),
        config.handshake_timeout,
        cancel,
        "inbound peer handshake response",
    )
    .await?;

    let plan = storage
        .transfer_plan()
        .await
        .map_err(|error| format!("Could not read torrent seed plan: {error}"))?;
    if plan.metainfo.info_hash != expected_info_hash {
        return Err("Torrent storage identity changed before seed session".to_owned());
    }

    if extensions.enabled() && remote.supports_extension_protocol() {
        let payload = extensions
            .local_handshake()
            .encode()
            .map_err(|error| format!("Could not encode inbound extended handshake: {error}"))?;
        send_message(
            &mut stream,
            &PeerMessage::Extended {
                extension_id: EXTENSION_HANDSHAKE_ID,
                payload,
            },
            config.frame_timeout,
            cancel,
        )
        .await?;
    }

    let bitfield = verified_bitfield(&plan.completed);
    if !bitfield.is_empty() {
        send_message(
            &mut stream,
            &PeerMessage::Bitfield(bitfield),
            config.frame_timeout,
            cancel,
        )
        .await?;
    }

    let mut interested = false;
    let mut unchoked = false;
    let mut remote_extensions: Option<ExtendedHandshake> = None;
    let mut pex_sent = false;
    let mut metadata_requests = 0u64;
    let mut stats = SeedSessionStats::default();

    loop {
        let message = read_peer_frame(
            &mut stream,
            config.frame_timeout,
            cancel,
        )
        .await?;

        match message {
            PeerMessage::KeepAlive => {}
            PeerMessage::Interested => {
                interested = true;
                if !unchoked {
                    send_message(
                        &mut stream,
                        &PeerMessage::Unchoke,
                        config.frame_timeout,
                        cancel,
                    )
                    .await?;
                    unchoked = true;
                }
            }
            PeerMessage::NotInterested => {
                interested = false;
                if unchoked {
                    send_message(
                        &mut stream,
                        &PeerMessage::Choke,
                        config.frame_timeout,
                        cancel,
                    )
                    .await?;
                    unchoked = false;
                }
            }
            PeerMessage::Request {
                piece_index,
                begin,
                length,
            } => {
                if !interested || !unchoked {
                    return Err("Inbound peer requested data while choked or not interested".to_owned());
                }
                if stats.requests_served >= config.max_requests {
                    return Err("Inbound peer exceeded the per-session request limit".to_owned());
                }
                if let Some(control) = seeding.as_ref() {
                    if !control.upload_allowed(completed, downloaded_bytes) {
                        if let Some(token) = seed_cancel.as_ref() {
                            token.cancel();
                        }
                        return Err("Inbound torrent seeding limit was reached".to_owned());
                    }
                }

                let block = storage
                    .read_verified_block(piece_index as usize, begin, length)
                    .await
                    .map_err(|error| {
                        format!(
                            "Inbound peer requested an unavailable or invalid verified block: {error}"
                        )
                    })?;
                let block_len = block.len() as u64;
                let next_uploaded = stats
                    .uploaded_bytes
                    .checked_add(block_len)
                    .ok_or_else(|| "Inbound upload byte accounting overflow".to_owned())?;
                if next_uploaded > config.max_uploaded_bytes {
                    return Err("Inbound peer exceeded the per-session upload byte limit".to_owned());
                }
                if let Some(limiter) = upload_limiter.as_ref() {
                    limiter.acquire(block_len, cancel).await?;
                }

                send_message(
                    &mut stream,
                    &PeerMessage::Piece {
                        piece_index,
                        begin,
                        block,
                    },
                    config.frame_timeout,
                    cancel,
                )
                .await?;
                if let Some(control) = seeding.as_ref() {
                    control.record_upload(block_len);
                    if completed && control.limit_state(downloaded_bytes).reached() {
                        control.stop_timer();
                        if let Some(token) = seed_cancel.as_ref() {
                            token.cancel();
                        }
                    }
                }
                if let Some(state) = dirty_state.as_ref() {
                    state.mark_dirty();
                }
                stats.requests_served = stats.requests_served.saturating_add(1);
                stats.uploaded_bytes = next_uploaded;
            }
            PeerMessage::Cancel { .. } => {
                // Requests are serviced synchronously and each block is capped at
                // 16 KiB by storage, so a cancel cannot race a queued large read.
            }
            PeerMessage::Extended {
                extension_id: EXTENSION_HANDSHAKE_ID,
                payload,
            } if extensions.enabled() && remote.supports_extension_protocol() => {
                let handshake = ExtendedHandshake::parse(&payload)
                    .map_err(|error| format!("Inbound peer sent invalid extended handshake: {error}"))?;
                remote_extensions = Some(handshake.clone());

                if !pex_sent && extensions.allow_pex {
                    if let Some(remote_pex_id) = handshake.ut_pex {
                        let payload = PeerExchange {
                            added: extensions.pex_peers.clone(),
                            dropped: Vec::new(),
                        }
                        .encode()
                        .map_err(|error| format!("Could not encode inbound ut_pex response: {error}"))?;
                        if let Some(limiter) = upload_limiter.as_ref() {
                            limiter.acquire(payload.len() as u64, cancel).await?;
                        }
                        send_message(
                            &mut stream,
                            &PeerMessage::Extended {
                                extension_id: remote_pex_id,
                                payload,
                            },
                            config.frame_timeout,
                            cancel,
                        )
                        .await?;
                        pex_sent = true;
                        stats.pex_messages_sent = stats.pex_messages_sent.saturating_add(1);
                        stats.pex_peers_sent = stats
                            .pex_peers_sent
                            .saturating_add(extensions.pex_peers.len() as u64);
                    }
                }
            }
            PeerMessage::Extended {
                extension_id: LOCAL_UT_METADATA_ID,
                payload,
            } if extensions.metadata_info.is_some() && remote.supports_extension_protocol() => {
                let Some(remote) = remote_extensions.as_ref() else {
                    return Err(
                        "Inbound peer requested ut_metadata before extended handshake".to_owned(),
                    );
                };
                let Some(remote_metadata_id) = remote.ut_metadata else {
                    return Err(
                        "Inbound peer requested ut_metadata without advertising a response id"
                            .to_owned(),
                    );
                };
                metadata_requests = metadata_requests.saturating_add(1);
                if metadata_requests > MAX_METADATA_REQUESTS_PER_SESSION {
                    return Err("Inbound peer exceeded the metadata request limit".to_owned());
                }

                match MetadataMessage::parse(&payload)
                    .map_err(|error| format!("Inbound peer sent invalid ut_metadata payload: {error}"))?
                {
                    MetadataMessage::Request { piece } => {
                        let info = extensions
                            .metadata_info
                            .as_ref()
                            .expect("guarded metadata info");
                        let start = (piece as usize)
                            .checked_mul(METADATA_PIECE_SIZE)
                            .ok_or_else(|| "Inbound metadata piece offset overflow".to_owned())?;
                        let response = if start >= info.len() {
                            MetadataMessage::Reject { piece }
                        } else {
                            let end = start.saturating_add(METADATA_PIECE_SIZE).min(info.len());
                            MetadataMessage::Data {
                                piece,
                                total_size: info.len(),
                                data: info[start..end].to_vec(),
                            }
                        };
                        let response_payload = response
                            .encode()
                            .map_err(|error| format!("Could not encode ut_metadata response: {error}"))?;
                        if let Some(limiter) = upload_limiter.as_ref() {
                            limiter.acquire(response_payload.len() as u64, cancel).await?;
                        }
                        send_message(
                            &mut stream,
                            &PeerMessage::Extended {
                                extension_id: remote_metadata_id,
                                payload: response_payload,
                            },
                            config.frame_timeout,
                            cancel,
                        )
                        .await?;
                        stats.metadata_requests_served =
                            stats.metadata_requests_served.saturating_add(1);
                        if start < info.len() {
                            stats.metadata_bytes_served = stats.metadata_bytes_served.saturating_add(
                                info.len()
                                    .saturating_sub(start)
                                    .min(METADATA_PIECE_SIZE) as u64,
                            );
                        }
                    }
                    MetadataMessage::Data { .. } | MetadataMessage::Reject { .. } => {
                        return Err(
                            "Inbound upload session received unsolicited ut_metadata response"
                                .to_owned(),
                        );
                    }
                }
            }
            PeerMessage::Extended { .. }
            | PeerMessage::Choke
            | PeerMessage::Unchoke
            | PeerMessage::Have(_)
            | PeerMessage::Bitfield(_)
            | PeerMessage::Port(_)
            | PeerMessage::Piece { .. } => {
                // Ignore unrelated legal control frames. DHT-port advertising
                // remains disabled until the long-lived DHT server stage.
            }
        }
    }
}

fn build_pex_peers(candidates: &[SocketAddr], remote: SocketAddr) -> Vec<SocketAddr> {
    let allow_private = private_network_allowed();
    let mut peers = candidates
        .iter()
        .copied()
        .filter(|peer| {
            peer.port() != 0
                && *peer != remote
                && (allow_private || !is_internal_ip(peer.ip()))
        })
        .collect::<Vec<_>>();
    peers.sort_unstable();
    peers.dedup();
    peers.truncate(MAX_PEX_PEERS_PER_MESSAGE);
    peers
}

async fn read_inbound_handshake(
    stream: &mut TcpStream,
    operation_timeout: Duration,
    cancel: &CancellationToken,
) -> Result<PeerHandshake, String> {
    let mut remote_bytes = [0u8; PEER_HANDSHAKE_LEN];
    read_exact_cancellable(
        stream,
        &mut remote_bytes,
        operation_timeout,
        cancel,
        "inbound peer handshake",
    )
    .await?;
    PeerHandshake::decode(&remote_bytes)
        .map_err(|error| format!("Inbound peer sent an invalid handshake: {error}"))
}

fn verified_bitfield(completed: &[bool]) -> Vec<u8> {
    if completed.is_empty() {
        return Vec::new();
    }
    let mut output = vec![0u8; completed.len().div_ceil(8)];
    for (index, verified) in completed.iter().copied().enumerate() {
        if verified {
            output[index / 8] |= 1 << (7 - (index % 8));
        }
    }
    output
}

async fn send_message(
    stream: &mut TcpStream,
    message: &PeerMessage,
    operation_timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let encoded = message
        .encode()
        .map_err(|error| format!("Could not encode inbound peer response: {error}"))?;
    write_message_bytes(
        stream,
        &encoded,
        operation_timeout,
        cancel,
        "inbound peer response",
    )
    .await
}

async fn read_peer_frame(
    stream: &mut TcpStream,
    operation_timeout: Duration,
    cancel: &CancellationToken,
) -> Result<PeerMessage, String> {
    let mut prefix = [0u8; 4];
    read_exact_cancellable(
        stream,
        &mut prefix,
        operation_timeout,
        cancel,
        "inbound peer frame length",
    )
    .await?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_PEER_FRAME_BYTES || length > MAX_SEED_CONTROL_FRAME_BYTES {
        return Err(format!(
            "Inbound peer frame exceeds the {} byte seed-session limit: {}",
            MAX_SEED_CONTROL_FRAME_BYTES, length
        ));
    }
    if length == 0 {
        return Ok(PeerMessage::KeepAlive);
    }

    let total = length
        .checked_add(4)
        .ok_or_else(|| "Inbound peer frame length overflow".to_owned())?;
    let mut frame = vec![0u8; total];
    frame[..4].copy_from_slice(&prefix);
    read_exact_cancellable(
        stream,
        &mut frame[4..],
        operation_timeout,
        cancel,
        "inbound peer frame payload",
    )
    .await?;
    PeerMessage::decode_frame(&frame)
        .map(|(message, _)| message)
        .map_err(|error| format!("Inbound peer sent an invalid frame: {error}"))
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

async fn write_message_bytes(
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
    use nova_torrent_core::{
        AllocationMode, FilePriority, TorrentFile, TorrentMetainfo, TorrentSelection,
    };
    use sha1::{Digest, Sha1};
    use std::path::PathBuf;
    use tokio::net::TcpListener;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "nova-torrent-seed-{}-{}-{name}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    fn metainfo() -> TorrentMetainfo {
        let digest = Sha1::digest(b"abcdefgh");
        let mut piece_hash = [0u8; 20];
        piece_hash.copy_from_slice(&digest);
        TorrentMetainfo {
            info_hash: InfoHash::new([0x55; 20]),
            name: "seed.bin".to_owned(),
            piece_length: 8,
            piece_hashes: vec![piece_hash],
            files: vec![TorrentFile {
                path: "seed.bin".to_owned(),
                length: 8,
                offset: 0,
            }],
            total_length: 8,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        }
    }

    fn test_config() -> SeedSessionConfig {
        SeedSessionConfig {
            handshake_timeout: Duration::from_secs(2),
            frame_timeout: Duration::from_secs(2),
            max_requests: 8,
            max_uploaded_bytes: 1024,
        }
    }

    async fn read_test_message(stream: &mut TcpStream) -> PeerMessage {
        read_peer_frame(
            stream,
            Duration::from_secs(2),
            &CancellationToken::new(),
        )
        .await
        .unwrap()
    }

    #[test]
    fn configured_seed_port_defaults_to_standard_bittorrent_port() {
        if std::env::var_os("NOVA_TORRENT_SEED_PORT").is_none() {
            assert_eq!(configured_seed_port(), DEFAULT_TORRENT_SEED_PORT);
        }
    }

    #[tokio::test]
    async fn inbound_seed_session_serves_only_verified_requested_block() {
        let root = temp_root("verified");
        let meta = metainfo();
        let storage = TorrentStorageSession::create(
            root.clone(),
            meta.clone(),
            TorrentSelection::all(&meta),
            AllocationMode::Sparse,
        )
        .await
        .unwrap();
        let lease = storage.begin_run().await.unwrap();
        storage
            .commit_piece(&lease, 0, b"abcdefgh".to_vec())
            .await
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_storage = storage.clone();
        let info_hash = meta.info_hash;
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_inbound_seed_session(
                stream,
                info_hash,
                server_storage,
                *b"-NV0001-SEEDSERVER01",
                test_config(),
                &CancellationToken::new(),
            )
            .await
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                &PeerHandshake::new(info_hash, *b"-NVTEST-SEEDCLIENT01").encode(),
            )
            .await
            .unwrap();

        let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
        client.read_exact(&mut handshake).await.unwrap();
        let response = PeerHandshake::decode(&handshake).unwrap();
        assert_eq!(response.info_hash, info_hash);

        assert_eq!(read_test_message(&mut client).await, PeerMessage::Bitfield(vec![0x80]));
        client
            .write_all(&PeerMessage::Interested.encode().unwrap())
            .await
            .unwrap();
        assert_eq!(read_test_message(&mut client).await, PeerMessage::Unchoke);

        client
            .write_all(
                &PeerMessage::Request {
                    piece_index: 0,
                    begin: 2,
                    length: 4,
                }
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            read_test_message(&mut client).await,
            PeerMessage::Piece {
                piece_index: 0,
                begin: 2,
                block: b"cdef".to_vec(),
            }
        );

        drop(client);
        let result = server.await.unwrap();
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn inbound_seed_session_rejects_unverified_piece_request() {
        let root = temp_root("unverified");
        let meta = metainfo();
        let storage = TorrentStorageSession::create(
            root.clone(),
            meta.clone(),
            TorrentSelection::new(&meta, vec![FilePriority::Normal]).unwrap(),
            AllocationMode::Sparse,
        )
        .await
        .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_storage = storage.clone();
        let info_hash = meta.info_hash;
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_inbound_seed_session(
                stream,
                info_hash,
                server_storage,
                *b"-NV0001-SEEDSERVER01",
                test_config(),
                &CancellationToken::new(),
            )
            .await
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                &PeerHandshake::new(info_hash, *b"-NVTEST-SEEDCLIENT01").encode(),
            )
            .await
            .unwrap();
        let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
        client.read_exact(&mut handshake).await.unwrap();
        assert_eq!(read_test_message(&mut client).await, PeerMessage::Bitfield(vec![0x00]));
        client
            .write_all(&PeerMessage::Interested.encode().unwrap())
            .await
            .unwrap();
        assert_eq!(read_test_message(&mut client).await, PeerMessage::Unchoke);
        client
            .write_all(
                &PeerMessage::Request {
                    piece_index: 0,
                    begin: 0,
                    length: 4,
                }
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();

        let error = server.await.unwrap().unwrap_err();
        assert!(error.contains("not verified"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn inbound_seed_session_serves_bep9_metadata_and_bep11_pex() {
        let root = temp_root("extensions");
        let piece_digest = Sha1::digest(b"abcdefgh");
        let mut info = b"d6:lengthi8e4:name8:seed.bin12:piece lengthi8e6:pieces20:".to_vec();
        info.extend_from_slice(&piece_digest);
        info.push(b'e');
        let meta = TorrentMetainfo::from_info_bytes(&info, &[]).unwrap();
        let storage = TorrentStorageSession::create_with_info_bytes(
            root.clone(),
            meta.clone(),
            TorrentSelection::all(&meta),
            AllocationMode::Sparse,
            Some(info.clone()),
        )
        .await
        .unwrap();
        let lease = storage.begin_run().await.unwrap();
        storage
            .commit_piece(&lease, 0, b"abcdefgh".to_vec())
            .await
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let info_hash = meta.info_hash;
        let server_storage = storage.clone();
        let server_info = storage.metadata_info_bytes().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _remote_addr) = listener.accept().await.unwrap();
            let remote = read_inbound_handshake(
                &mut stream,
                Duration::from_secs(2),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            serve_inbound_seed_session_after_handshake(
                stream,
                remote,
                server_storage,
                *b"-NV0001-SEEDSERVER01",
                None,
                None,
                None,
                None,
                false,
                8,
                SeedExtensionService {
                    metadata_info: Some(server_info),
                    pex_peers: vec!["8.8.8.8:6881".parse().unwrap()],
                    allow_pex: true,
                },
                test_config(),
                &CancellationToken::new(),
            )
            .await
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        let mut handshake = PeerHandshake::new(info_hash, *b"-NVTEST-SEEDCLIENT01");
        handshake.reserved[5] |= 0x10;
        client.write_all(&handshake.encode()).await.unwrap();

        let mut response_bytes = [0u8; PEER_HANDSHAKE_LEN];
        client.read_exact(&mut response_bytes).await.unwrap();
        let response = PeerHandshake::decode(&response_bytes).unwrap();
        assert!(response.supports_extension_protocol());

        let local_extensions = read_test_message(&mut client).await;
        let PeerMessage::Extended {
            extension_id: EXTENSION_HANDSHAKE_ID,
            payload,
        } = local_extensions
        else {
            panic!("expected local extended handshake");
        };
        let local = ExtendedHandshake::parse(&payload).unwrap();
        assert_eq!(local.ut_metadata, Some(LOCAL_UT_METADATA_ID));
        assert_eq!(local.ut_pex, Some(LOCAL_UT_PEX_ID));
        assert_eq!(local.metadata_size, Some(info.len()));

        assert!(matches!(
            read_test_message(&mut client).await,
            PeerMessage::Bitfield(_)
        ));

        client
            .write_all(
                &PeerMessage::Extended {
                    extension_id: EXTENSION_HANDSHAKE_ID,
                    payload: ExtendedHandshake {
                        ut_metadata: Some(7),
                        ut_pex: Some(9),
                        metadata_size: None,
                        request_queue: Some(8),
                        client_name: Some("test-client".to_owned()),
                    }
                    .encode()
                    .unwrap(),
                }
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();

        let pex = read_test_message(&mut client).await;
        let PeerMessage::Extended {
            extension_id: 9,
            payload,
        } = pex
        else {
            panic!("expected ut_pex snapshot");
        };
        let pex = PeerExchange::parse(&payload).unwrap();
        assert_eq!(pex.added, vec!["8.8.8.8:6881".parse().unwrap()]);

        client
            .write_all(
                &PeerMessage::Extended {
                    extension_id: LOCAL_UT_METADATA_ID,
                    payload: MetadataMessage::Request { piece: 0 }.encode().unwrap(),
                }
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();

        let metadata = read_test_message(&mut client).await;
        let PeerMessage::Extended {
            extension_id: 7,
            payload,
        } = metadata
        else {
            panic!("expected ut_metadata response");
        };
        assert_eq!(
            MetadataMessage::parse(&payload).unwrap(),
            MetadataMessage::Data {
                piece: 0,
                total_size: info.len(),
                data: info.clone(),
            }
        );

        drop(client);
        let result = server.await.unwrap();
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pex_builder_filters_remote_and_private_addresses_by_default() {
        if private_network_allowed() {
            return;
        }
        let remote: SocketAddr = "8.8.8.8:6881".parse().unwrap();
        let peers = build_pex_peers(
            &[
                remote,
                "1.1.1.1:6882".parse().unwrap(),
                "127.0.0.1:6883".parse().unwrap(),
            ],
            remote,
        );
        assert_eq!(peers, vec!["1.1.1.1:6882".parse().unwrap()]);
    }

    #[test]
    fn verified_bitfield_uses_network_bit_order() {
        assert_eq!(
            verified_bitfield(&[true, false, true, false, false, false, false, true, true]),
            vec![0b1010_0001, 0b1000_0000]
        );
    }
}
