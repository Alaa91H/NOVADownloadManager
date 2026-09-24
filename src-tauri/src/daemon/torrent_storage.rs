use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use nova_torrent_core::{
    AllocationMode, InfoHash, PieceCommit, PieceLayout, PieceScheduler, RecheckMode,
    RecheckReport, StorageError, TorrentMetainfo, TorrentSelection, TorrentStorage,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub struct TorrentRunLease {
    generation: u64,
    cancel: CancellationToken,
}

impl TorrentRunLease {
    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TorrentStorageProgress {
    pub selected_completed_bytes: u64,
    pub selected_total_bytes: u64,
    pub verified_pieces: usize,
    pub piece_count: usize,
    pub generation: u64,
    pub had_trackers: bool,
}

#[derive(Clone)]
pub struct TorrentStorageSession {
    storage: Arc<Mutex<TorrentStorage>>,
    generation: Arc<AtomicU64>,
    current_cancel: Arc<Mutex<CancellationToken>>,
    lifecycle: Arc<Mutex<()>>,
}

impl TorrentStorageSession {
    pub async fn create(
        root: PathBuf,
        meta: TorrentMetainfo,
        selection: TorrentSelection,
        allocation: AllocationMode,
    ) -> Result<Self, TorrentSessionError> {
        let storage = tokio::task::spawn_blocking(move || {
            TorrentStorage::create(root, meta, selection, allocation)
        })
        .await
        .map_err(join_error)??;
        Ok(Self::from_storage(storage))
    }

    pub async fn open_or_create(
        root: PathBuf,
        meta: TorrentMetainfo,
        selection: TorrentSelection,
        allocation: AllocationMode,
    ) -> Result<Self, TorrentSessionError> {
        let storage = tokio::task::spawn_blocking(move || {
            TorrentStorage::open_or_create(root, meta, selection, allocation)
        })
        .await
        .map_err(join_error)??;
        Ok(Self::from_storage(storage))
    }

    pub async fn resume_from_manifest(
        root: PathBuf,
        info_hash: InfoHash,
    ) -> Result<Self, TorrentSessionError> {
        let storage = tokio::task::spawn_blocking(move || {
            TorrentStorage::resume_from_manifest(root, info_hash)
        })
        .await
        .map_err(join_error)??;
        Ok(Self::from_storage(storage))
    }

    fn from_storage(storage: TorrentStorage) -> Self {
        let generation = storage.checkpoint().generation;
        Self {
            storage: Arc::new(Mutex::new(storage)),
            generation: Arc::new(AtomicU64::new(generation)),
            current_cancel: Arc::new(Mutex::new(CancellationToken::new())),
            lifecycle: Arc::new(Mutex::new(())),
        }
    }

    pub async fn begin_run(&self) -> Result<TorrentRunLease, TorrentSessionError> {
        let storage = self.storage.clone();
        let generation = self.generation.clone();
        let current_cancel = self.current_cancel.clone();
        let lifecycle = self.lifecycle.clone();

        let (run_generation, token) = tokio::task::spawn_blocking(move || {
            let _lifecycle = lifecycle
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("lifecycle"))?;
            let mut storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            let run_generation = storage.begin_run()?;
            generation.store(run_generation, Ordering::Release);

            let token = CancellationToken::new();
            let mut current = current_cancel
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("cancel token"))?;
            current.cancel();
            *current = token.clone();
            Ok::<_, TorrentSessionError>((run_generation, token))
        })
        .await
        .map_err(join_error)??;

        Ok(TorrentRunLease {
            generation: run_generation,
            cancel: token,
        })
    }

    pub async fn pause(&self) -> Result<u64, TorrentSessionError> {
        self.invalidate_current_run().await
    }

    pub async fn cancel(&self) -> Result<u64, TorrentSessionError> {
        self.invalidate_current_run().await
    }

    async fn invalidate_current_run(&self) -> Result<u64, TorrentSessionError> {
        if let Ok(current) = self.current_cancel.lock() {
            current.cancel();
        }

        let storage = self.storage.clone();
        let generation = self.generation.clone();
        let lifecycle = self.lifecycle.clone();
        tokio::task::spawn_blocking(move || {
            let _lifecycle = lifecycle
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("lifecycle"))?;
            let mut storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            let next = storage.invalidate_run()?;
            generation.store(next, Ordering::Release);
            Ok::<_, TorrentSessionError>(next)
        })
        .await
        .map_err(join_error)?
    }

    pub async fn update_selection(
        &self,
        selection: TorrentSelection,
    ) -> Result<u64, TorrentSessionError> {
        if let Ok(current) = self.current_cancel.lock() {
            current.cancel();
        }

        let storage = self.storage.clone();
        let generation = self.generation.clone();
        let lifecycle = self.lifecycle.clone();
        tokio::task::spawn_blocking(move || {
            let _lifecycle = lifecycle
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("lifecycle"))?;
            let mut storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            let next = storage.update_selection(selection)?;
            generation.store(next, Ordering::Release);
            Ok::<_, TorrentSessionError>(next)
        })
        .await
        .map_err(join_error)?
    }

    pub async fn commit_piece(
        &self,
        lease: &TorrentRunLease,
        piece_index: usize,
        bytes: Vec<u8>,
    ) -> Result<PieceCommit, TorrentSessionError> {
        self.ensure_current(lease)?;

        let storage = self.storage.clone();
        let generation = self.generation.clone();
        let run_generation = lease.generation;
        let cancel = lease.cancel.clone();

        let result = tokio::task::spawn_blocking(move || {
            if cancel.is_cancelled()
                || generation.load(Ordering::Acquire) != run_generation
            {
                return Err(TorrentSessionError::StaleRun(run_generation));
            }
            let mut storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            if cancel.is_cancelled()
                || generation.load(Ordering::Acquire) != run_generation
            {
                return Err(TorrentSessionError::StaleRun(run_generation));
            }
            storage
                .write_verified_piece(run_generation, piece_index, &bytes)
                .map_err(TorrentSessionError::from)
        })
        .await
        .map_err(join_error)??;

        self.ensure_current(lease)?;
        Ok(result)
    }

    pub async fn startup_recheck(
        &self,
        mode: RecheckMode,
    ) -> Result<RecheckReport, TorrentSessionError> {
        let storage = self.storage.clone();
        tokio::task::spawn_blocking(move || {
            let mut storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            storage.startup_recheck(mode).map_err(TorrentSessionError::from)
        })
        .await
        .map_err(join_error)?
    }

    pub async fn progress(&self) -> Result<TorrentStorageProgress, TorrentSessionError> {
        let storage = self.storage.clone();
        tokio::task::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            Ok::<_, TorrentSessionError>(TorrentStorageProgress {
                selected_completed_bytes: storage.selected_completed_bytes()?,
                selected_total_bytes: storage.selected_total_bytes()?,
                verified_pieces: storage.checkpoint().verified.count_set(),
                piece_count: storage.metainfo().piece_count(),
                generation: storage.checkpoint().generation,
                had_trackers: storage.had_trackers(),
            })
        })
        .await
        .map_err(join_error)?
    }

    pub async fn restored_scheduler(&self) -> Result<PieceScheduler, TorrentSessionError> {
        let storage = self.storage.clone();
        tokio::task::spawn_blocking(move || {
            let storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            let meta = storage.metainfo();
            let layout = PieceLayout::new(meta.total_length, meta.piece_length)
                .map_err(|error| TorrentSessionError::Scheduler(error.to_string()))?;
            let mut scheduler = PieceScheduler::new(layout);
            let priorities = storage.selection().piece_priorities(meta)?;
            scheduler
                .set_piece_priorities(&priorities)
                .map_err(|error| TorrentSessionError::Scheduler(error.to_string()))?;
            scheduler
                .restore_completed(&storage.checkpoint().verified.to_bools())
                .map_err(|error| TorrentSessionError::Scheduler(error.to_string()))?;
            Ok::<_, TorrentSessionError>(scheduler)
        })
        .await
        .map_err(join_error)?
    }

    pub async fn finalize_selected(
        &self,
        lease: &TorrentRunLease,
    ) -> Result<(), TorrentSessionError> {
        self.ensure_current(lease)?;
        let storage = self.storage.clone();
        let generation = lease.generation;
        tokio::task::spawn_blocking(move || {
            let mut storage = storage
                .lock()
                .map_err(|_| TorrentSessionError::LockPoisoned("storage"))?;
            storage
                .finalize_selected(generation)
                .map_err(TorrentSessionError::from)
        })
        .await
        .map_err(join_error)??;
        self.ensure_current(lease)
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn ensure_current(&self, lease: &TorrentRunLease) -> Result<(), TorrentSessionError> {
        if lease.cancel.is_cancelled()
            || self.generation.load(Ordering::Acquire) != lease.generation
        {
            Err(TorrentSessionError::StaleRun(lease.generation))
        } else {
            Ok(())
        }
    }
}

fn join_error(error: tokio::task::JoinError) -> TorrentSessionError {
    TorrentSessionError::Worker(error.to_string())
}

#[derive(Debug, thiserror::Error)]
pub enum TorrentSessionError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Selection(#[from] nova_torrent_core::SelectionError),
    #[error("torrent storage session run {0} is stale or cancelled")]
    StaleRun(u64),
    #[error("torrent storage session lock poisoned: {0}")]
    LockPoisoned(&'static str),
    #[error("torrent storage worker failed: {0}")]
    Worker(String),
    #[error("torrent scheduler restore failed: {0}")]
    Scheduler(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_torrent_core::{FilePriority, TorrentFile, TorrentMetainfo};
    use sha1::{Digest, Sha1};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "nova-torrent-session-{}-{stamp}-{name}",
            std::process::id()
        ))
    }

    fn piece_hash(bytes: &[u8]) -> [u8; 20] {
        let digest = Sha1::digest(bytes);
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&digest);
        hash
    }

    fn meta() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([5u8; 20]),
            name: "data.bin".to_owned(),
            piece_length: 4,
            piece_hashes: vec![piece_hash(b"abcd"), piece_hash(b"efgh")],
            files: vec![TorrentFile {
                path: "data.bin".to_owned(),
                length: 8,
                offset: 0,
            }],
            total_length: 8,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        }
    }

    #[tokio::test]
    async fn pause_invalidates_old_piece_commit_generation() {
        let root = temp_root("pause");
        let meta = meta();
        let session = TorrentStorageSession::create(
            root.clone(),
            meta.clone(),
            TorrentSelection::all(&meta),
            AllocationMode::Sparse,
        )
        .await
        .unwrap();

        let lease = session.begin_run().await.unwrap();
        session.pause().await.unwrap();
        assert!(matches!(
            session.commit_piece(&lease, 0, b"abcd".to_vec()).await,
            Err(TorrentSessionError::StaleRun(_))
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn committed_piece_restores_into_scheduler_after_restart() {
        let root = temp_root("scheduler");
        let meta = meta();
        let session = TorrentStorageSession::create(
            root.clone(),
            meta.clone(),
            TorrentSelection::all(&meta),
            AllocationMode::Sparse,
        )
        .await
        .unwrap();
        let lease = session.begin_run().await.unwrap();
        session
            .commit_piece(&lease, 0, b"abcd".to_vec())
            .await
            .unwrap();
        drop(session);

        let resumed = TorrentStorageSession::resume_from_manifest(root.clone(), meta.info_hash)
            .await
            .unwrap();
        let report = resumed
            .startup_recheck(RecheckMode::CheckpointOnly)
            .await
            .unwrap();
        assert_eq!(report.valid_pieces, 1);

        let mut scheduler = resumed.restored_scheduler().await.unwrap();
        scheduler.peer_connected(&[0b1100_0000]).unwrap();
        assert_eq!(scheduler.select_rarest(&[0b1100_0000]), Some(1));

        let progress = resumed.progress().await.unwrap();
        assert_eq!(progress.selected_completed_bytes, 4);
        assert_eq!(progress.selected_total_bytes, 8);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn high_priority_selection_is_restored_for_scheduler() {
        let root = temp_root("priority");
        let mut meta = meta();
        meta.files = vec![
            TorrentFile {
                path: "a.bin".to_owned(),
                length: 4,
                offset: 0,
            },
            TorrentFile {
                path: "b.bin".to_owned(),
                length: 4,
                offset: 4,
            },
        ];
        let selection = TorrentSelection::new(
            &meta,
            vec![FilePriority::Normal, FilePriority::High],
        )
        .unwrap();
        let session = TorrentStorageSession::create(
            root.clone(),
            meta,
            selection,
            AllocationMode::Sparse,
        )
        .await
        .unwrap();

        let mut scheduler = session.restored_scheduler().await.unwrap();
        scheduler.peer_connected(&[0b1100_0000]).unwrap();
        assert_eq!(scheduler.select_rarest(&[0b1100_0000]), Some(1));
        let _ = std::fs::remove_dir_all(root);
    }
}
