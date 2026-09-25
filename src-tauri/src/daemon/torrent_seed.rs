use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use nova_torrent_core::{
    InfoHash, PeerHandshake, PeerMessage, MAX_PEER_FRAME_BYTES, PEER_HANDSHAKE_LEN,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::daemon::state::SharedState;
use crate::daemon::torrent_storage::TorrentStorageSession;
use crate::daemon::torrent_task::ensure_storage_session;
use crate::daemon::utils::{is_internal_ip, private_network_allowed};
use crate::lock_or_err;

pub const DEFAULT_TORRENT_SEED_PORT: u16 = 6881;
const MAX_SEED_CONTROL_FRAME_BYTES: usize = 64 * 1024;
const MAX_INBOUND_SEED_CONNECTIONS: usize = 64;

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

    Ok(port)
}

async fn serve_state_peer(
    mut stream: TcpStream,
    _address: SocketAddr,
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
                job.task.engine_id.eq_ignore_ascii_case(&info_hash_hex)
                    && job.task.status != "error"
                    && !job.requires_reauth
            })
            .cloned()
    }
    .ok_or_else(|| "Inbound peer requested a torrent that is not seed-eligible".to_owned())?;

    let storage = ensure_storage_session(&job, job.storage.clone()).await?;
    serve_inbound_seed_session_after_handshake(
        stream,
        remote,
        storage,
        job.local_peer_id,
        SeedSessionConfig::default(),
        cancel,
    )
    .await
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
    config: SeedSessionConfig,
    cancel: &CancellationToken,
) -> Result<SeedSessionStats, String> {
    if remote.peer_id == local_peer_id {
        return Err("Inbound peer used NOVA's own peer id".to_owned());
    }
    let expected_info_hash = remote.info_hash;

    let local = PeerHandshake::new(expected_info_hash, local_peer_id);
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
                stats.requests_served = stats.requests_served.saturating_add(1);
                stats.uploaded_bytes = next_uploaded;
            }
            PeerMessage::Cancel { .. } => {
                // Requests are serviced synchronously and each block is capped at
                // 16 KiB by storage, so a cancel cannot race a queued large read.
            }
            PeerMessage::Choke
            | PeerMessage::Unchoke
            | PeerMessage::Have(_)
            | PeerMessage::Bitfield(_)
            | PeerMessage::Port(_)
            | PeerMessage::Extended { .. }
            | PeerMessage::Piece { .. } => {
                // NOVA does not advertise extension, DHT-port, or download
                // interests from this upload-only session. Ignore unrelated
                // legal control frames instead of expanding the attack surface.
            }
        }
    }
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

    #[test]
    fn verified_bitfield_uses_network_bit_order() {
        assert_eq!(
            verified_bitfield(&[true, false, true, false, false, false, false, true, true]),
            vec![0b1010_0001, 0b1000_0000]
        );
    }
}
