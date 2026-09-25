use std::collections::{HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use nova_torrent_core::{FilePriority, TorrentMetainfo};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::daemon::engine::bandwidth::BandwidthManager;
use crate::daemon::engine::priority_queue::{DownloadPriority, PriorityBandwidthQueue};
use crate::daemon::torrent_peer::PeerEngine;
use crate::daemon::torrent_policy::TorrentNovaPolicyLease;
use crate::daemon::torrent_storage::{
    TorrentRunLease, TorrentSessionError, TorrentStorageProgress, TorrentStorageSession,
};

#[derive(Clone, Debug)]
pub struct TorrentTransferConfig {
    pub max_parallel_pieces: usize,
    pub max_candidate_peers: usize,
}

impl Default for TorrentTransferConfig {
    fn default() -> Self {
        Self {
            max_parallel_pieces: 4,
            max_candidate_peers: 512,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TorrentTransferReport {
    pub resumed_verified_pieces: usize,
    pub pieces_committed_this_run: usize,
    pub selected_bytes_committed_this_run: u64,
    pub progress: TorrentStorageProgress,
    pub elapsed: Duration,
}

#[derive(Clone, Debug)]
pub struct TorrentTransferCoordinator {
    peers: PeerEngine,
    config: TorrentTransferConfig,
}

impl TorrentTransferCoordinator {
    pub fn new(peers: PeerEngine, config: TorrentTransferConfig) -> Self {
        Self { peers, config }
    }

    pub fn production_default() -> Self {
        Self::new(PeerEngine::production_default(), TorrentTransferConfig::default())
    }

    pub async fn download_selected_with_nova_policy(
        &self,
        storage: &TorrentStorageSession,
        candidates: &[SocketAddr],
        local_peer_id: [u8; 20],
        task_id: String,
        priority: DownloadPriority,
        priority_queue: PriorityBandwidthQueue,
        bandwidth_manager: BandwidthManager,
        external_cancel: &CancellationToken,
    ) -> Result<TorrentTransferReport, TorrentTransferError> {
        let selected_size = storage.progress().await?.selected_total_bytes;

        let policy = TorrentNovaPolicyLease::start(
            task_id,
            priority,
            selected_size,
            priority_queue,
            bandwidth_manager,
        )
        .map_err(TorrentTransferError::Policy)?;
        let policy_peers = self.peers.with_download_limiter(policy.limiter());
        let coordinator = Self::new(policy_peers, self.config.clone());
        let result = coordinator
            .download_selected(storage, candidates, local_peer_id, external_cancel)
            .await;
        drop(policy);
        result
    }

    pub async fn download_selected(
        &self,
        storage: &TorrentStorageSession,
        candidates: &[SocketAddr],
        local_peer_id: [u8; 20],
        external_cancel: &CancellationToken,
    ) -> Result<TorrentTransferReport, TorrentTransferError> {
        let candidates = bounded_candidates(candidates, self.config.max_candidate_peers);

        let lease = storage.begin_run().await?;
        let plan = storage.transfer_plan().await?;
        if plan.priorities.len() != plan.metainfo.piece_count()
            || plan.completed.len() != plan.metainfo.piece_count()
        {
            let _ = storage.pause().await;
            return Err(TorrentTransferError::InvalidPlan);
        }

        let resumed_verified_pieces = plan
            .priorities
            .iter()
            .zip(&plan.completed)
            .filter(|(priority, complete)| priority.is_selected() && **complete)
            .count();

        let mut pending = (0..plan.metainfo.piece_count())
            .filter(|index| plan.priorities[*index].is_selected() && !plan.completed[*index])
            .map(|index| index as u32)
            .collect::<Vec<_>>();
        pending.sort_by_key(|piece| {
            let priority = plan.priorities[*piece as usize];
            let rank = match priority {
                FilePriority::High => 0u8,
                FilePriority::Normal => 1u8,
                FilePriority::Skip => 2u8,
            };
            (rank, *piece)
        });
        let mut pending = VecDeque::from(pending);

        let started = Instant::now();
        if pending.is_empty() {
            storage.finalize_selected(&lease).await?;
            return Ok(TorrentTransferReport {
                resumed_verified_pieces,
                pieces_committed_this_run: 0,
                selected_bytes_committed_this_run: 0,
                progress: storage.progress().await?,
                elapsed: started.elapsed(),
            });
        }

        if candidates.is_empty() {
            let _ = storage.pause().await;
            return Err(TorrentTransferError::NoPeers);
        }

        let max_parallel = self.config.max_parallel_pieces.clamp(1, 64);
        let candidates = Arc::new(candidates);
        let metainfo = Arc::new(plan.metainfo);
        let mut tasks = JoinSet::new();
        let run_cancel = lease.cancellation_token();

        while tasks.len() < max_parallel {
            let Some(piece_index) = pending.pop_front() else {
                break;
            };
            spawn_piece(
                &mut tasks,
                self.peers.clone(),
                storage.clone(),
                lease.clone(),
                candidates.clone(),
                metainfo.clone(),
                piece_index,
                local_peer_id,
            );
        }

        let mut pieces_committed = 0usize;
        let mut selected_bytes_committed = 0u64;

        while !tasks.is_empty() {
            let joined = tokio::select! {
                _ = external_cancel.cancelled() => {
                    run_cancel.cancel();
                    tasks.abort_all();
                    let _ = storage.pause().await;
                    return Err(TorrentTransferError::Cancelled);
                }
                _ = run_cancel.cancelled() => {
                    tasks.abort_all();
                    return Err(TorrentTransferError::Cancelled);
                }
                joined = tasks.join_next() => joined,
            };

            let Some(joined) = joined else {
                break;
            };
            let completed = match joined {
                Ok(Ok(completed)) => completed,
                Ok(Err(error)) => {
                    run_cancel.cancel();
                    tasks.abort_all();
                    let _ = storage.pause().await;
                    return Err(error);
                }
                Err(error) => {
                    run_cancel.cancel();
                    tasks.abort_all();
                    let _ = storage.pause().await;
                    return Err(TorrentTransferError::Worker(error.to_string()));
                }
            };

            pieces_committed = pieces_committed.saturating_add(1);
            selected_bytes_committed = selected_bytes_committed
                .checked_add(completed.selected_bytes_written)
                .ok_or(TorrentTransferError::LengthOverflow)?;

            if let Some(piece_index) = pending.pop_front() {
                spawn_piece(
                    &mut tasks,
                    self.peers.clone(),
                    storage.clone(),
                    lease.clone(),
                    candidates.clone(),
                    metainfo.clone(),
                    piece_index,
                    local_peer_id,
                );
            }
        }

        storage.finalize_selected(&lease).await?;
        Ok(TorrentTransferReport {
            resumed_verified_pieces,
            pieces_committed_this_run: pieces_committed,
            selected_bytes_committed_this_run: selected_bytes_committed,
            progress: storage.progress().await?,
            elapsed: started.elapsed(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CompletedPiece {
    selected_bytes_written: u64,
}

fn spawn_piece(
    tasks: &mut JoinSet<Result<CompletedPiece, TorrentTransferError>>,
    peers: PeerEngine,
    storage: TorrentStorageSession,
    lease: TorrentRunLease,
    candidates: Arc<Vec<SocketAddr>>,
    metainfo: Arc<TorrentMetainfo>,
    piece_index: u32,
    local_peer_id: [u8; 20],
) {
    tasks.spawn(async move {
        transfer_piece(
            peers,
            storage,
            lease,
            candidates,
            metainfo,
            piece_index,
            local_peer_id,
        )
        .await
    });
}

async fn transfer_piece(
    peers: PeerEngine,
    storage: TorrentStorageSession,
    lease: TorrentRunLease,
    candidates: Arc<Vec<SocketAddr>>,
    metainfo: Arc<TorrentMetainfo>,
    piece_index: u32,
    local_peer_id: [u8; 20],
) -> Result<CompletedPiece, TorrentTransferError> {
    let cancel = lease.cancellation_token();
    let result = peers
        .download_piece_from_candidates(
            candidates.as_slice(),
            &metainfo,
            piece_index,
            local_peer_id,
            &cancel,
        )
        .await
        .map_err(TorrentTransferError::Peer)?;

    let commit = storage
        .commit_piece(&lease, piece_index as usize, result.bytes)
        .await?;
    Ok(CompletedPiece {
        selected_bytes_written: commit.selected_bytes_written,
    })
}

fn bounded_candidates(candidates: &[SocketAddr], max_candidates: usize) -> Vec<SocketAddr> {
    let limit = max_candidates.clamp(1, 4_096);
    let mut seen = HashSet::new();
    candidates
        .iter()
        .copied()
        .filter(|candidate| candidate.port() != 0 && seen.insert(*candidate))
        .take(limit)
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum TorrentTransferError {
    #[error(transparent)]
    Storage(#[from] TorrentSessionError),
    #[error("torrent transfer has no peer candidates")]
    NoPeers,
    #[error("torrent transfer storage plan is inconsistent")]
    InvalidPlan,
    #[error("torrent transfer was cancelled")]
    Cancelled,
    #[error("torrent peer transfer failed: {0}")]
    Peer(String),
    #[error("torrent transfer worker failed: {0}")]
    Worker(String),
    #[error("torrent NOVA runtime policy failed: {0}")]
    Policy(String),
    #[error("torrent transfer byte accounting overflow")]
    LengthOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::torrent_peer::{
        read_peer_frame, PeerEngineConfig, PeerSessionConfig,
    };
    use crate::daemon::torrent_storage::TorrentStorageSession;
    use nova_torrent_core::{
        AllocationMode, InfoHash, PeerHandshake, PeerMessage, TorrentFile, TorrentMetainfo,
        TorrentSelection, PEER_HANDSHAKE_LEN,
    };
    use sha1::{Digest, Sha1};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "nova-torrent-transfer-{}-{stamp}-{name}",
            std::process::id()
        ))
    }

    fn hash(bytes: &[u8]) -> [u8; 20] {
        let digest = Sha1::digest(bytes);
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&digest);
        hash
    }

    fn meta() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([8u8; 20]),
            name: "complete.bin".to_owned(),
            piece_length: 4,
            piece_hashes: vec![hash(b"abcd"), hash(b"efgh")],
            files: vec![TorrentFile {
                path: "complete.bin".to_owned(),
                length: 8,
                offset: 0,
            }],
            total_length: 8,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        }
    }

    fn peer_config() -> PeerEngineConfig {
        PeerEngineConfig {
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
                enable_pex: false,
                enable_dht: false,
            },
            max_outbound_connections: 4,
            download_rate_limit_bytes_per_sec: None,
        }
    }

    async fn serve_piece(mut stream: TcpStream, info_hash: InfoHash) {
        let mut handshake = [0u8; PEER_HANDSHAKE_LEN];
        stream.read_exact(&mut handshake).await.unwrap();
        let client = PeerHandshake::decode(&handshake).unwrap();
        assert_eq!(client.info_hash, info_hash);

        let remote = PeerHandshake::new(info_hash, *b"-NVTEST-REMOTE-00001");
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
            panic!("expected piece request");
        };
        assert_eq!(begin, 0);
        assert_eq!(length, 4);
        let payload = match piece_index {
            0 => b"abcd".to_vec(),
            1 => b"efgh".to_vec(),
            other => panic!("unexpected piece {other}"),
        };
        stream
            .write_all(
                &PeerMessage::Piece {
                    piece_index,
                    begin,
                    block: payload,
                }
                .encode()
                .unwrap(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn coordinator_downloads_commits_and_resumes_selected_torrent() {
        let root = temp_root("complete");
        let meta = meta();
        let storage = TorrentStorageSession::create(
            root.clone(),
            meta.clone(),
            TorrentSelection::all(&meta),
            AllocationMode::Sparse,
        )
        .await
        .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let info_hash = meta.info_hash;
        let server = tokio::spawn(async move {
            let mut workers = JoinSet::new();
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                workers.spawn(serve_piece(stream, info_hash));
            }
            while let Some(result) = workers.join_next().await {
                result.unwrap();
            }
        });

        let peers = PeerEngine::for_tests(peer_config());
        let coordinator = TorrentTransferCoordinator::new(
            peers,
            TorrentTransferConfig {
                max_parallel_pieces: 2,
                max_candidate_peers: 8,
            },
        );
        let report = coordinator
            .download_selected(
                &storage,
                &[address],
                *b"-NV0001-123456789012",
                &CancellationToken::new(),
            )
            .await
            .expect("complete torrent");

        assert_eq!(report.pieces_committed_this_run, 2);
        assert_eq!(report.progress.selected_completed_bytes, 8);
        assert_eq!(std::fs::read(root.join("complete.bin")).unwrap(), b"abcdefgh");
        server.await.unwrap();
        drop(storage);

        let resumed = TorrentStorageSession::resume_from_manifest(root.clone(), meta.info_hash)
            .await
            .unwrap();
        let recheck = resumed
            .startup_recheck(nova_torrent_core::RecheckMode::CheckpointOnly)
            .await
            .unwrap();
        assert_eq!(recheck.valid_pieces, 2);

        let report = TorrentTransferCoordinator::new(
            PeerEngine::for_tests(peer_config()),
            TorrentTransferConfig::default(),
        )
        .download_selected(
            &resumed,
            &[],
            *b"-NV0001-123456789012",
            &CancellationToken::new(),
        )
        .await
        .expect("already complete resume");
        assert_eq!(report.resumed_verified_pieces, 2);
        assert_eq!(report.pieces_committed_this_run, 0);

        let _ = std::fs::remove_dir_all(root);
    }
}
