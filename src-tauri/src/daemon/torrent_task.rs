use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use nova_torrent_core::{
    AllocationMode, FilePriority, InfoHash, MagnetLink, RecheckMode, TorrentMetainfo,
    TorrentSelection,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::daemon::engine::bandwidth::BandwidthManager;
use crate::daemon::engine::priority_queue::{DownloadPriority, QueueEntry};
use crate::daemon::state::SharedState;
use crate::daemon::torrent_bandwidth::TorrentBandwidthLimiter;
use crate::daemon::torrent_magnet::{MagnetResolution, MagnetResolver};
use crate::daemon::torrent_peer::{generate_peer_id, PeerEngine};
use crate::daemon::torrent_seeding::{
    TorrentSeedingControl, TorrentSeedingPolicy, TorrentSeedingSnapshot,
    MAX_SEED_RATIO_MILLI,
};
use crate::daemon::torrent_storage::{TorrentStorageProgress, TorrentStorageSession};
use crate::daemon::torrent_transfer::{TorrentTransferConfig, TorrentTransferCoordinator};
use crate::daemon::types::{restart_task_state, transition_task_state, Task, TaskState};
use crate::lock_or_err;

pub const MAX_PENDING_TORRENT_ANALYSES: usize = 32;
pub const TORRENT_ANALYSIS_TTL: Duration = Duration::from_secs(15 * 60);
const TORRENT_ENGINE_ID: &str = nova_torrent_core::ENGINE_ID;
const MAX_TORRENT_CONNECTIONS: u32 = 32;

#[derive(Clone, Debug)]
pub struct PendingTorrentAnalysis {
    pub id: String,
    pub source_uri: String,
    pub resolution: MagnetResolution,
    pub created_at: Instant,
}

#[derive(Clone)]
pub struct TorrentJob {
    pub task: Task,
    /// Full in-memory source. It may contain tracker credentials and is never
    /// written verbatim to downloads-state.json.
    pub source_uri: Option<String>,
    pub storage: Arc<tokio::sync::Mutex<Option<TorrentStorageSession>>>,
    pub candidates: Vec<SocketAddr>,
    pub local_peer_id: [u8; 20],
    pub cancel_token: CancellationToken,
    pub run_generation: Arc<AtomicU64>,
    pub start_time: Instant,
    pub allocated_kbps: Arc<AtomicU64>,
    pub upload_limiter: Arc<TorrentBandwidthLimiter>,
    pub seeding: TorrentSeedingControl,
    pub seed_cancel_token: CancellationToken,
    pub uploaded_bytes: Arc<AtomicU64>,
    pub active_seed_connections: Arc<AtomicU64>,
    pub active_slot: Arc<AtomicBool>,
    pub priority: DownloadPriority,
    pub requires_reauth: bool,
    pub private: bool,
    pub tracker_peer_count: usize,
    pub dht_peer_count: usize,
    pub pex_peer_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeTorrentBody {
    pub magnet_uri: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTorrentBody {
    pub analysis_id: String,
    pub save_path: String,
    #[serde(default)]
    pub start_immediately: Option<bool>,
    #[serde(default)]
    pub file_priorities: Option<Vec<FilePriority>>,
    #[serde(default)]
    pub connections: Option<u32>,
    #[serde(default)]
    pub seeding: Option<UpdateTorrentSeedingBody>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTorrentFilesBody {
    pub file_priorities: Vec<FilePriority>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTorrentSeedingBody {
    pub enabled: bool,
    #[serde(default)]
    pub ratio_limit: Option<f64>,
    #[serde(default)]
    pub time_limit_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReauthorizeTorrentBody {
    pub magnet_uri: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFileView {
    pub index: usize,
    pub path: String,
    pub length: u64,
    pub priority: FilePriority,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentAnalysisView {
    pub analysis_id: String,
    pub info_hash: String,
    pub name: String,
    pub total_length: u64,
    pub piece_length: u64,
    pub piece_count: usize,
    pub files: Vec<TorrentFileView>,
    pub private: bool,
    pub tracker_count: usize,
    pub peer_count: usize,
    pub used_dht: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentTaskDetails {
    pub task: Task,
    pub info_hash: String,
    pub private: bool,
    pub files: Vec<TorrentFileView>,
    pub piece_count: usize,
    pub verified_pieces: usize,
    pub selected_completed_bytes: u64,
    pub selected_total_bytes: u64,
    pub tracker_peer_count: usize,
    pub dht_peer_count: usize,
    pub pex_peer_count: usize,
    pub candidate_peer_count: usize,
    pub uploaded_bytes: u64,
    pub active_seed_connections: u64,
    pub seeding_enabled: bool,
    pub seeding_active: bool,
    pub seed_ratio_limit: Option<f64>,
    pub seed_time_limit_seconds: Option<u64>,
    pub seeded_seconds: u64,
    pub seed_ratio: f64,
    pub seed_limit_reached: bool,
    pub requires_reauth: bool,
}

pub async fn analyze_magnet(
    state: &SharedState,
    magnet_uri: &str,
) -> Result<TorrentAnalysisView, String> {
    let magnet_uri = magnet_uri.trim();
    if magnet_uri.is_empty() {
        return Err("Magnet URI cannot be empty".to_owned());
    }
    MagnetLink::parse(magnet_uri).map_err(|error| format!("Invalid magnet URI: {error}"))?;

    let cancel = CancellationToken::new();
    let resolver = MagnetResolver::production_default();
    let resolution = tokio::time::timeout(
        Duration::from_secs(90),
        resolver.resolve_uri(magnet_uri, &cancel),
    )
    .await
    .map_err(|_| "Torrent metadata analysis timed out after 90 seconds".to_owned())??;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let view = analysis_view(&id, &resolution);
    let pending = PendingTorrentAnalysis {
        id: id.clone(),
        source_uri: magnet_uri.to_owned(),
        resolution,
        created_at: Instant::now(),
    };

    let mut analyses = lock_or_err!(state.torrent_analyses);
    analyses.retain(|_, item| item.created_at.elapsed() <= TORRENT_ANALYSIS_TTL);
    if analyses.len() >= MAX_PENDING_TORRENT_ANALYSES {
        if let Some(oldest) = analyses
            .iter()
            .min_by_key(|(_, item)| item.created_at)
            .map(|(key, _)| key.clone())
        {
            analyses.remove(&oldest);
        }
    }
    analyses.insert(id, pending);
    Ok(view)
}

pub async fn analyze_metainfo(
    state: &SharedState,
    bytes: &[u8],
) -> Result<TorrentAnalysisView, String> {
    let metainfo = TorrentMetainfo::parse(bytes)
        .map_err(|error| format!("Invalid torrent metadata file: {error}"))?;
    let source_uri = discovery_source_from_metainfo(&metainfo);

    let cancel = CancellationToken::new();
    let resolver = MagnetResolver::production_default();
    let resolution = tokio::time::timeout(
        Duration::from_secs(45),
        resolver.discover_metainfo(metainfo, &cancel),
    )
    .await
    .map_err(|_| "Torrent peer discovery timed out after 45 seconds".to_owned())??;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let view = analysis_view(&id, &resolution);
    let pending = PendingTorrentAnalysis {
        id: id.clone(),
        source_uri,
        resolution,
        created_at: Instant::now(),
    };

    let mut analyses = lock_or_err!(state.torrent_analyses);
    analyses.retain(|_, item| item.created_at.elapsed() <= TORRENT_ANALYSIS_TTL);
    if analyses.len() >= MAX_PENDING_TORRENT_ANALYSES {
        if let Some(oldest) = analyses
            .iter()
            .min_by_key(|(_, item)| item.created_at)
            .map(|(key, _)| key.clone())
        {
            analyses.remove(&oldest);
        }
    }
    analyses.insert(id, pending);
    Ok(view)
}

pub async fn create_torrent_task(
    state: &SharedState,
    body: CreateTorrentBody,
) -> Result<Task, String> {
    let analysis = {
        let mut analyses = lock_or_err!(state.torrent_analyses);
        analyses.retain(|_, item| item.created_at.elapsed() <= TORRENT_ANALYSIS_TTL);
        analyses
            .remove(body.analysis_id.trim())
            .ok_or_else(|| "Torrent analysis expired or was not found".to_owned())?
    };

    let root = body.save_path.trim();
    if root.is_empty() {
        return Err("Torrent destination directory cannot be empty".to_owned());
    }

    let metainfo = analysis.resolution.metainfo.clone();
    let seeding_policy = body
        .seeding
        .as_ref()
        .map(seeding_policy_from_body)
        .transpose()?
        .unwrap_or_default();
    let selection = match body.file_priorities {
        Some(priorities) => TorrentSelection::new(&metainfo, priorities)
            .map_err(|error| format!("Invalid torrent file selection: {error}"))?,
        None => TorrentSelection::all(&metainfo),
    };
    let selected_bytes = selection
        .selected_bytes(&metainfo)
        .map_err(|error| format!("Invalid torrent selection: {error}"))?;

    let storage = TorrentStorageSession::create(
        PathBuf::from(root),
        metainfo.clone(),
        selection,
        AllocationMode::Sparse,
    )
    .await
    .map_err(|error| format!("Could not prepare torrent storage: {error}"))?;

    let (persisted_source, _source_requires_reauth) =
        persistable_magnet_source(&analysis.source_uri, metainfo.private)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let upload_limiter = Arc::new(TorrentBandwidthLimiter::for_bandwidth_task(
        id.clone(),
        state.bandwidth_manager.clone(),
    ));
    let seeding = TorrentSeedingControl::from_snapshot(TorrentSeedingSnapshot {
        policy: seeding_policy,
        ..TorrentSeedingSnapshot::default()
    });
    let uploaded_bytes = seeding.uploaded_counter();
    let connections = body
        .connections
        .unwrap_or(8)
        .clamp(1, MAX_TORRENT_CONNECTIONS);
    let task = Task {
        id: id.clone(),
        name: metainfo.name.clone(),
        url: persisted_source,
        file_type: "torrent".to_owned(),
        status: TaskState::Queued.as_status().to_owned(),
        size_bytes: selected_bytes,
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: chrono::Utc::now().to_rfc3339(),
        category: "torrent".to_owned(),
        queue_id: "main".to_owned(),
        connections,
        resumable: true,
        save_path: root.to_owned(),
        description: format!(
            "BitTorrent v1 · {} file{}",
            metainfo.files.len(),
            if metainfo.files.len() == 1 { "" } else { "s" }
        ),
        segments: Vec::new(),
        referer: None,
        engine: TORRENT_ENGINE_ID.to_owned(),
        engine_id: metainfo.info_hash.to_hex(),
        engine_status: Some("queued".to_owned()),
        error_message: None,
    };

    let candidates = resolution_candidates(&analysis.resolution);
    let allocated_kbps = Arc::new(AtomicU64::new(0));
    let job = TorrentJob {
        task: task.clone(),
        source_uri: Some(analysis.source_uri),
        storage: Arc::new(tokio::sync::Mutex::new(Some(storage))),
        candidates,
        local_peer_id: analysis.resolution.local_peer_id,
        cancel_token: CancellationToken::new(),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
        allocated_kbps: allocated_kbps.clone(),
        upload_limiter,
        seeding,
        seed_cancel_token: CancellationToken::new(),
        uploaded_bytes,
        active_seed_connections: Arc::new(AtomicU64::new(0)),
        active_slot: Arc::new(AtomicBool::new(false)),
        priority: DownloadPriority::Normal,
        requires_reauth: false,
        private: metainfo.private,
        tracker_peer_count: analysis.resolution.tracker_peers.len(),
        dht_peer_count: analysis.resolution.dht_peers.len(),
        pex_peer_count: analysis.resolution.pex_peers.len(),
    };

    {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        if jobs.contains_key(&id) {
            return Err("Torrent task id collision".to_owned());
        }
        jobs.insert(id.clone(), job);
    }
    lock_or_err!(state.task_snapshot).insert(id.clone(), task.clone());
    ensure_torrent_queue_entry(state, &task, allocated_kbps, DownloadPriority::Normal);
    state.mark_dirty();

    if body.start_immediately.unwrap_or(true) {
        start_torrent_process(state, &id)?;
    }

    get_torrent_task(state, &id).ok_or_else(|| "Torrent task disappeared after creation".to_owned())
}

pub fn restore_torrent_job(
    task: Task,
    source_uri: Option<String>,
    requires_reauth: bool,
    bandwidth: BandwidthManager,
    seeding_snapshot: Option<TorrentSeedingSnapshot>,
) -> Result<TorrentJob, String> {
    let info_hash = info_hash_from_hex(&task.engine_id)?;
    let parsed_source = source_uri
        .as_deref()
        .or(Some(task.url.as_str()))
        .filter(|value| !value.trim().is_empty());

    if let Some(source) = parsed_source {
        let magnet = MagnetLink::parse(source)
            .map_err(|error| format!("Persisted torrent source is invalid: {error}"))?;
        if magnet.info_hash != info_hash {
            return Err("Persisted torrent source does not match task info hash".to_owned());
        }
    }

    let restored_source = parsed_source.map(str::to_owned);
    let upload_limiter = Arc::new(TorrentBandwidthLimiter::for_bandwidth_task(
        task.id.clone(),
        bandwidth,
    ));
    let seeding = TorrentSeedingControl::from_snapshot(seeding_snapshot.unwrap_or_default());
    let uploaded_bytes = seeding.uploaded_counter();
    let seed_cancel_token = CancellationToken::new();
    if !seeding.policy().enabled {
        seed_cancel_token.cancel();
    }
    Ok(TorrentJob {
        private: false,
        task,
        source_uri: restored_source,
        storage: Arc::new(tokio::sync::Mutex::new(None)),
        candidates: Vec::new(),
        local_peer_id: generate_peer_id(),
        cancel_token: CancellationToken::new(),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
        allocated_kbps: Arc::new(AtomicU64::new(0)),
        upload_limiter,
        seeding,
        seed_cancel_token,
        uploaded_bytes,
        active_seed_connections: Arc::new(AtomicU64::new(0)),
        active_slot: Arc::new(AtomicBool::new(false)),
        priority: DownloadPriority::Normal,
        requires_reauth,
        tracker_peer_count: 0,
        dht_peer_count: 0,
        pex_peer_count: 0,
    })
}

pub fn get_torrent_task(state: &SharedState, id: &str) -> Option<Task> {
    lock_or_err!(state.torrent_jobs)
        .get(id)
        .map(|job| job.task.clone())
}

pub async fn torrent_task_details(
    state: &SharedState,
    id: &str,
) -> Result<TorrentTaskDetails, String> {
    let (job, storage_slot) = {
        let jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        (job.clone(), job.storage.clone())
    };
    let storage = ensure_storage_session(&job, storage_slot).await?;
    let plan = storage
        .transfer_plan()
        .await
        .map_err(|error| format!("Could not read torrent storage plan: {error}"))?;
    let progress = storage
        .progress()
        .await
        .map_err(|error| format!("Could not read torrent progress: {error}"))?;

    let files = plan
        .metainfo
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| TorrentFileView {
            index,
            path: file.path.clone(),
            length: file.length,
            priority: plan
                .file_priorities
                .get(index)
                .copied()
                .unwrap_or(FilePriority::Normal),
        })
        .collect();

    let seeding_policy = job.seeding.policy();
    let seed_limit_state = job.seeding.limit_state(progress.selected_total_bytes);
    let task_state = TaskState::from_status(&job.task.status);
    let task_completed = task_state == Some(TaskState::Completed);
    let seeding_active = !job.requires_reauth
        && task_state.is_some_and(|state| state == TaskState::Completed || state.is_active())
        && job
            .seeding
            .upload_allowed(task_completed, progress.selected_total_bytes)
        && !job.seed_cancel_token.is_cancelled();

    Ok(TorrentTaskDetails {
        task: job.task,
        info_hash: plan.metainfo.info_hash.to_hex(),
        private: plan.metainfo.private,
        files,
        piece_count: plan.metainfo.piece_count(),
        verified_pieces: progress.verified_pieces,
        selected_completed_bytes: progress.selected_completed_bytes,
        selected_total_bytes: progress.selected_total_bytes,
        tracker_peer_count: job.tracker_peer_count,
        dht_peer_count: job.dht_peer_count,
        pex_peer_count: job.pex_peer_count,
        candidate_peer_count: job.candidates.len(),
        uploaded_bytes: job.uploaded_bytes.load(Ordering::Relaxed),
        active_seed_connections: job.active_seed_connections.load(Ordering::Relaxed),
        seeding_enabled: seeding_policy.enabled,
        seeding_active,
        seed_ratio_limit: seeding_policy.ratio_limit(),
        seed_time_limit_seconds: seeding_policy.time_limit_seconds,
        seeded_seconds: job.seeding.effective_seeded_seconds(),
        seed_ratio: job.seeding.ratio(progress.selected_total_bytes),
        seed_limit_reached: task_completed && seed_limit_state.reached(),
        requires_reauth: job.requires_reauth,
    })
}

pub async fn update_torrent_file_priorities(
    state: &SharedState,
    id: &str,
    priorities: Vec<FilePriority>,
) -> Result<TorrentTaskDetails, String> {
    let (job, storage_slot) = {
        let jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        if TaskState::from_status(&job.task.status).is_some_and(TaskState::is_active) {
            return Err("Pause the torrent before changing file priorities".to_owned());
        }
        (job.clone(), job.storage.clone())
    };

    let storage = ensure_storage_session(&job, storage_slot).await?;
    let plan = storage.transfer_plan().await.map_err(|error| error.to_string())?;
    let selection = TorrentSelection::new(&plan.metainfo, priorities)
        .map_err(|error| format!("Invalid torrent file priorities: {error}"))?;
    storage
        .update_selection(selection)
        .await
        .map_err(|error| format!("Could not update torrent selection: {error}"))?;
    let progress = storage.progress().await.map_err(|error| error.to_string())?;

    {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        if let Some(current) = jobs.get_mut(id) {
            current.task.size_bytes = progress.selected_total_bytes;
            current.task.downloaded_bytes = progress.selected_completed_bytes;
            current.task.error_message = None;
            let task = current.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        }
    }
    state.priority_queue.update_size(id, progress.selected_total_bytes);
    state.mark_dirty();
    torrent_task_details(state, id).await
}

pub async fn update_torrent_seeding_policy(
    state: &SharedState,
    id: &str,
    body: UpdateTorrentSeedingBody,
) -> Result<TorrentTaskDetails, String> {
    let policy = seeding_policy_from_body(&body)?;
    let (job_snapshot, should_start) = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| "Torrent task not found".to_owned())?;

        job.seed_cancel_token.cancel();
        job.seeding.stop_timer();
        job.seeding.replace_policy(policy)?;
        job.seed_cancel_token = CancellationToken::new();

        let task_state = TaskState::from_status(&job.task.status)
            .ok_or_else(|| format!("Torrent task has unknown state '{}'", job.task.status))?;
        let completed = task_state == TaskState::Completed;
        if policy.enabled && completed {
            job.seeding.start_timer();
        }

        let eligible = policy.enabled
            && !job.requires_reauth
            && (completed || task_state.is_active())
            && (!completed || !job.seeding.limit_state(job.task.size_bytes).reached());
        if !eligible {
            job.seed_cancel_token.cancel();
        }
        (job.clone(), eligible)
    };
    state.mark_dirty();

    if should_start {
        let storage = ensure_storage_session(&job_snapshot, job_snapshot.storage.clone()).await?;
        start_torrent_seed_services(state, id, storage);
    }

    torrent_task_details(state, id).await
}

fn seeding_policy_from_body(
    body: &UpdateTorrentSeedingBody,
) -> Result<TorrentSeedingPolicy, String> {
    let ratio_limit_milli = match body.ratio_limit {
        Some(ratio) => {
            if !ratio.is_finite() || ratio < 0.0 {
                return Err("Torrent seed ratio limit must be a finite non-negative number".to_owned());
            }
            let maximum = f64::from(MAX_SEED_RATIO_MILLI) / 1000.0;
            if ratio > maximum {
                return Err(format!(
                    "Torrent seed ratio limit exceeds maximum {maximum:.3}"
                ));
            }
            Some((ratio * 1000.0).round() as u32)
        }
        None => None,
    };

    TorrentSeedingPolicy {
        enabled: body.enabled,
        ratio_limit_milli,
        time_limit_seconds: body.time_limit_seconds,
    }
    .validate()
}

pub async fn reauthorize_torrent_task(
    state: &SharedState,
    id: &str,
    magnet_uri: &str,
) -> Result<Task, String> {
    let magnet = MagnetLink::parse(magnet_uri.trim())
        .map_err(|error| format!("Invalid magnet URI: {error}"))?;
    let (expected, private_torrent) = {
        let jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        (info_hash_from_hex(&job.task.engine_id)?, job.private)
    };
    if magnet.info_hash != expected {
        return Err("Replacement magnet belongs to a different torrent".to_owned());
    }

    let (persisted, _removed_sensitive) = persistable_magnet_source(magnet_uri, private_torrent)?;
    let task = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get_mut(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        job.source_uri = Some(magnet_uri.trim().to_owned());
        job.requires_reauth = false;
        job.task.url = persisted;
        job.task.error_message = None;
        if TaskState::from_status(&job.task.status) == Some(TaskState::Failed) {
            restart_task_state(&mut job.task, "reauthorized")?;
        } else {
            job.task.engine_status = Some("reauthorized".to_owned());
        }
        job.task.clone()
    };
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task.clone());
    state.mark_dirty();

    let seed_job = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        jobs.get_mut(id).map(|job| {
            job.seed_cancel_token.cancel();
            job.seed_cancel_token = CancellationToken::new();
            if !job.seeding.policy().enabled {
                job.seed_cancel_token.cancel();
            }
            job.clone()
        })
    };
    if let Some(seed_job) = seed_job {
        let task_state = TaskState::from_status(&seed_job.task.status);
        if seed_job.seeding.policy().enabled
            && task_state.is_some_and(|state| {
                state == TaskState::Completed || state.is_active()
            })
        {
            if let Ok(storage) =
                ensure_storage_session(&seed_job, seed_job.storage.clone()).await
            {
                if task_state == Some(TaskState::Completed) {
                    seed_job.seeding.start_timer();
                }
                start_torrent_seed_services(state, id, storage);
            }
        }
    }

    Ok(task)
}

pub fn start_torrent_process(state: &SharedState, id: &str) -> Result<(), String> {
    let (
        generation,
        cancel,
        storage_slot,
        candidates,
        local_peer_id,
        source_uri,
        allocated_kbps,
        active_slot,
        priority,
        size_bytes,
    ) = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| "Torrent task not found".to_owned())?;

        if job.requires_reauth {
            return Err(
                "Torrent tracker authorization is required before this task can resume".to_owned(),
            );
        }
        let current = TaskState::from_status(&job.task.status)
            .ok_or_else(|| format!("Torrent task has unknown state '{}'", job.task.status))?;
        if current == TaskState::Completed {
            return Err("Completed torrent cannot be resumed; use redownload".to_owned());
        }
        if current.is_active() {
            return Err(format!("Torrent task is already active in state '{}'", current.as_status()));
        }
        if current != TaskState::Queued {
            transition_task_state(&mut job.task, TaskState::Queued, "start-requested")?;
        }
        transition_task_state(&mut job.task, TaskState::Preparing, "starting-torrent")?;

        job.cancel_token.cancel();
        job.cancel_token = CancellationToken::new();
        job.seed_cancel_token.cancel();
        job.seed_cancel_token = CancellationToken::new();
        job.seeding.stop_timer();
        if !job.seeding.policy().enabled {
            job.seed_cancel_token.cancel();
        }
        let generation = job.run_generation.fetch_add(1, Ordering::AcqRel) + 1;
        job.start_time = Instant::now();
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.error_message = None;
        let task = job.task.clone();
        let out = (
            generation,
            job.cancel_token.clone(),
            job.storage.clone(),
            job.candidates.clone(),
            job.local_peer_id,
            job.source_uri.clone(),
            job.allocated_kbps.clone(),
            job.active_slot.clone(),
            job.priority,
            job.task.size_bytes,
        );
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        out
    };

    ensure_torrent_queue_entry(
        state,
        &get_torrent_task(state, id).ok_or_else(|| "Torrent task not found".to_owned())?,
        allocated_kbps.clone(),
        priority,
    );
    state.priority_queue.start_download();
    active_slot.store(true, Ordering::Release);
    state.mark_dirty();

    let state = state.clone();
    let id = id.to_owned();
    tokio::spawn(async move {
        run_torrent_worker(
            state,
            id,
            generation,
            cancel,
            storage_slot,
            candidates,
            local_peer_id,
            source_uri,
            allocated_kbps,
            active_slot,
            priority,
            size_bytes,
        )
        .await;
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_torrent_worker(
    state: SharedState,
    id: String,
    generation: u64,
    cancel: CancellationToken,
    storage_slot: Arc<tokio::sync::Mutex<Option<TorrentStorageSession>>>,
    mut candidates: Vec<SocketAddr>,
    mut local_peer_id: [u8; 20],
    source_uri: Option<String>,
    allocated_kbps: Arc<AtomicU64>,
    active_slot: Arc<AtomicBool>,
    _priority: DownloadPriority,
    _size_bytes: u64,
) {
    if !torrent_generation_current(&state, &id, generation) {
        release_queue_slot(&state, &id, &active_slot, false);
        return;
    }

    if let Err(error) = transition_torrent_task(
        &state,
        &id,
        generation,
        TaskState::Probing,
        "rechecking-torrent",
    ) {
        fail_torrent_task(&state, &id, generation, error, &active_slot);
        return;
    }

    let job_snapshot = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.get(&id).cloned()
    };
    let Some(job_snapshot) = job_snapshot else {
        release_queue_slot(&state, &id, &active_slot, false);
        return;
    };

    let storage = match ensure_storage_session(&job_snapshot, storage_slot.clone()).await {
        Ok(storage) => storage,
        Err(error) => {
            fail_torrent_task(&state, &id, generation, error, &active_slot);
            return;
        }
    };

    match storage.startup_recheck(RecheckMode::CheckpointOnly).await {
        Ok(_) => update_torrent_progress_once(&state, &id, generation, &storage, &mut None).await,
        Err(error) => {
            fail_torrent_task(
                &state,
                &id,
                generation,
                format!("Torrent startup recheck failed: {error}"),
                &active_slot,
            );
            return;
        }
    }

    if cancel.is_cancelled() || !torrent_generation_current(&state, &id, generation) {
        finish_torrent_cancelled(&state, &id, generation, &active_slot);
        return;
    }

    if candidates.is_empty() {
        let mut metainfo = match storage.transfer_plan().await {
            Ok(plan) => plan.metainfo,
            Err(error) => {
                fail_torrent_task(
                    &state,
                    &id,
                    generation,
                    format!("Could not read torrent metadata for peer discovery: {error}"),
                    &active_slot,
                );
                return;
            }
        };

        if let Some(source) = source_uri.as_deref() {
            let magnet = match MagnetLink::parse(source) {
                Ok(magnet) => magnet,
                Err(error) => {
                    fail_torrent_task(
                        &state,
                        &id,
                        generation,
                        format!("Persisted torrent discovery source is invalid: {error}"),
                        &active_slot,
                    );
                    return;
                }
            };
            if magnet.info_hash != metainfo.info_hash {
                fail_torrent_task(
                    &state,
                    &id,
                    generation,
                    "Persisted torrent discovery source does not match storage metadata".to_owned(),
                    &active_slot,
                );
                return;
            }
            // Storage manifests deliberately redact tracker URLs. Rehydrate
            // only the in-memory discovery copy from the sanitized/full source.
            metainfo.trackers = magnet.trackers.clone();
            metainfo.tracker_tiers = magnet
                .trackers
                .iter()
                .cloned()
                .map(|tracker| vec![tracker])
                .collect();
        }

        if metainfo.private && metainfo.trackers.is_empty() {
            fail_torrent_task(
                &state,
                &id,
                generation,
                "Private torrent tracker authorization is unavailable; re-authorize the torrent source"
                    .to_owned(),
                &active_slot,
            );
            return;
        }

        match MagnetResolver::production_default()
            .discover_metainfo(metainfo, &cancel)
            .await
        {
            Ok(resolution) => {
                candidates = resolution_candidates(&resolution);
                local_peer_id = resolution.local_peer_id;
                let mut jobs = lock_or_err!(state.torrent_jobs);
                if let Some(job) = jobs.get_mut(&id) {
                    if job.run_generation.load(Ordering::Acquire) == generation {
                        job.candidates = candidates.clone();
                        job.local_peer_id = local_peer_id;
                        job.private = resolution.metainfo.private;
                        job.tracker_peer_count = resolution.tracker_peers.len();
                        job.dht_peer_count = resolution.dht_peers.len();
                        job.pex_peer_count = resolution.pex_peers.len();
                    }
                }
            }
            Err(error) => {
                fail_torrent_task(
                    &state,
                    &id,
                    generation,
                    format!("Torrent peer discovery failed: {error}"),
                    &active_slot,
                );
                return;
            }
        }

        if candidates.is_empty() {
            fail_torrent_task(
                &state,
                &id,
                generation,
                "Torrent peer discovery returned no usable peers".to_owned(),
                &active_slot,
            );
            return;
        }
    }

    if let Err(error) = transition_torrent_task(
        &state,
        &id,
        generation,
        TaskState::Downloading,
        "downloading-torrent",
    ) {
        fail_torrent_task(&state, &id, generation, error, &active_slot);
        return;
    }
    start_torrent_seed_services(&state, &id, storage.clone());

    let limiter = Arc::new(TorrentBandwidthLimiter::for_nova_task(
        id.clone(),
        allocated_kbps,
        state.bandwidth_manager.clone(),
    ));
    let peers = PeerEngine::production_default().with_download_limiter(limiter);
    let coordinator = TorrentTransferCoordinator::new(
        peers,
        TorrentTransferConfig {
            max_parallel_pieces: get_torrent_task(&state, &id)
                .map(|task| task.connections as usize)
                .unwrap_or(4)
                .clamp(1, 32),
            max_candidate_peers: 512,
        },
    );

    let progress_cancel = CancellationToken::new();
    let progress_worker_cancel = progress_cancel.clone();
    let progress_state = state.clone();
    let progress_id = id.clone();
    let progress_storage = storage.clone();
    let progress_task = tokio::spawn(async move {
        let mut previous = None;
        while !progress_worker_cancel.is_cancelled() {
            update_torrent_progress_once(
                &progress_state,
                &progress_id,
                generation,
                &progress_storage,
                &mut previous,
            )
            .await;
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });

    let result = coordinator
        .download_selected(&storage, &candidates, local_peer_id, &cancel)
        .await;
    progress_cancel.cancel();
    let _ = progress_task.await;

    if !torrent_generation_current(&state, &id, generation) {
        release_queue_slot(&state, &id, &active_slot, false);
        return;
    }

    match result {
        Ok(_) => {
            update_torrent_progress_once(&state, &id, generation, &storage, &mut None).await;
            if transition_torrent_task(
                &state,
                &id,
                generation,
                TaskState::Verifying,
                "verifying-torrent",
            )
            .and_then(|_| {
                transition_torrent_task(
                    &state,
                    &id,
                    generation,
                    TaskState::Finalizing,
                    "finalizing-torrent",
                )
            })
            .and_then(|_| {
                transition_torrent_task(
                    &state,
                    &id,
                    generation,
                    TaskState::Completed,
                    "completed",
                )
            })
            .is_err()
            {
                fail_torrent_task(
                    &state,
                    &id,
                    generation,
                    "Torrent completed but task lifecycle finalization failed".to_owned(),
                    &active_slot,
                );
                return;
            }
            {
                let mut jobs = lock_or_err!(state.torrent_jobs);
                if let Some(job) = jobs.get_mut(&id) {
                    job.seeding.start_timer();
                    if job.seeding.limit_state(job.task.size_bytes).reached() {
                        job.seed_cancel_token.cancel();
                    }
                }
            }
            let completed_bytes = get_torrent_task(&state, &id)
                .map(|task| task.downloaded_bytes)
                .unwrap_or(0);
            release_queue_slot(&state, &id, &active_slot, true);
            if let Ok(mut stats) = state.download_stats.lock() {
                stats.total_completed = stats.total_completed.saturating_add(1);
                stats.total_downloaded_bytes =
                    stats.total_downloaded_bytes.saturating_add(completed_bytes);
            }
            state.mark_dirty();
        }
        Err(error) if cancel.is_cancelled() => {
            finish_torrent_cancelled(&state, &id, generation, &active_slot);
        }
        Err(error) => {
            fail_torrent_task(&state, &id, generation, error.to_string(), &active_slot);
        }
    }
}

fn start_torrent_seed_services(
    state: &SharedState,
    id: &str,
    storage: TorrentStorageSession,
) {
    let job = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.get(id).cloned()
    };
    let Some(job) = job else {
        return;
    };
    let task_state = TaskState::from_status(&job.task.status);
    if job.requires_reauth
        || !job.seeding.policy().enabled
        || !task_state.is_some_and(|state| state == TaskState::Completed || state.is_active())
        || job.seed_cancel_token.is_cancelled()
    {
        return;
    }
    if task_state == Some(TaskState::Completed)
        && job.seeding.limit_state(job.task.size_bytes).reached()
    {
        job.seed_cancel_token.cancel();
        return;
    }

    let tracker_state = state.clone();
    let tracker_id = id.to_owned();
    let tracker_storage = storage.clone();
    let tracker_source = job.source_uri.clone();
    let tracker_peer_id = job.local_peer_id;
    let tracker_cancel = job.seed_cancel_token.clone();
    tokio::spawn(async move {
        crate::daemon::torrent_tracker::run_tracker_lifecycle(
            tracker_state,
            tracker_id,
            tracker_storage,
            tracker_source,
            tracker_peer_id,
            tracker_cancel,
        )
        .await;
    });

    let watch_state = state.clone();
    let watch_id = id.to_owned();
    let watch_control = job.seeding.clone();
    let watch_cancel = job.seed_cancel_token.clone();
    tokio::spawn(async move {
        let mut dirty_ticks = 0u8;
        loop {
            tokio::select! {
                _ = watch_cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }

            let (task_state, total_bytes, still_exists) = {
                let jobs = lock_or_err!(watch_state.torrent_jobs);
                match jobs.get(&watch_id) {
                    Some(current) => (
                        TaskState::from_status(&current.task.status),
                        current.task.size_bytes,
                        true,
                    ),
                    None => (None, 0, false),
                }
            };
            if !still_exists
                || !watch_control.policy().enabled
                || !task_state.is_some_and(|state| {
                    state == TaskState::Completed || state.is_active()
                })
            {
                watch_cancel.cancel();
                break;
            }

            if task_state == Some(TaskState::Completed) {
                watch_control.start_timer();
                if watch_control.limit_state(total_bytes).reached() {
                    watch_cancel.cancel();
                    watch_state.mark_dirty();
                    break;
                }
                dirty_ticks = dirty_ticks.saturating_add(1);
                if dirty_ticks >= 6 {
                    dirty_ticks = 0;
                    watch_state.mark_dirty();
                }
            }
        }
    });
}

async fn update_torrent_progress_once(
    state: &SharedState,
    id: &str,
    generation: u64,
    storage: &TorrentStorageSession,
    previous: &mut Option<(Instant, u64)>,
) {
    if !torrent_generation_current(state, id, generation) {
        return;
    }
    let Ok(progress) = storage.progress().await else {
        return;
    };
    let now = Instant::now();
    let speed = previous
        .as_ref()
        .map(|(then, bytes)| {
            let elapsed = now.saturating_duration_since(*then).as_secs_f64();
            if elapsed > 0.0 {
                ((progress.selected_completed_bytes.saturating_sub(*bytes)) as f64 / elapsed) as u64
            } else {
                0
            }
        })
        .unwrap_or(0);
    *previous = Some((now, progress.selected_completed_bytes));

    let task = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        job.task.downloaded_bytes = progress.selected_completed_bytes;
        job.task.size_bytes = progress.selected_total_bytes;
        job.task.speed_bytes_per_sec = speed;
        job.task.elapsed_seconds = job.start_time.elapsed().as_secs();
        let remaining = progress
            .selected_total_bytes
            .saturating_sub(progress.selected_completed_bytes);
        job.task.time_left_seconds = if speed > 0 {
            remaining.div_ceil(speed)
        } else {
            0
        };
        job.task.clone()
    };
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
}

pub async fn recheck_restored_completed_torrents(state: &SharedState) {
    let jobs = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.iter()
            .filter_map(|(id, job)| {
                (TaskState::from_status(&job.task.status) == Some(TaskState::Completed))
                    .then_some((id.clone(), job.clone()))
            })
            .collect::<Vec<_>>()
    };

    for (id, job) in jobs {
        let validation = async {
            let storage = ensure_storage_session(&job, job.storage.clone()).await?;
            storage
                .startup_recheck(RecheckMode::CheckpointOnly)
                .await
                .map_err(|error| format!("Torrent completion recheck failed: {error}"))?;
            let progress = storage
                .progress()
                .await
                .map_err(|error| format!("Could not read rechecked torrent progress: {error}"))?;
            if progress.selected_total_bytes == 0
                || progress.selected_completed_bytes != progress.selected_total_bytes
            {
                return Err(format!(
                    "Completed torrent changed on disk: verified {} of {} selected bytes",
                    progress.selected_completed_bytes, progress.selected_total_bytes
                ));
            }
            Ok::<(TorrentStorageProgress, TorrentStorageSession), String>((progress, storage))
        }
        .await;

        let mut tracker_storage = None;
        let task = {
            let mut torrent_jobs = lock_or_err!(state.torrent_jobs);
            let Some(current) = torrent_jobs.get_mut(&id) else {
                continue;
            };
            if TaskState::from_status(&current.task.status) != Some(TaskState::Completed) {
                continue;
            }

            match validation {
                Ok((progress, storage)) => {
                    current.task.downloaded_bytes = progress.selected_completed_bytes;
                    current.task.size_bytes = progress.selected_total_bytes;
                    current.task.engine_status = Some("completed-verified".to_owned());
                    current.task.error_message = None;
                    if !current.requires_reauth && current.seeding.policy().enabled {
                        current.seeding.start_timer();
                        if current.seeding.limit_state(progress.selected_total_bytes).reached() {
                            current.seed_cancel_token.cancel();
                        } else {
                            tracker_storage = Some(storage);
                        }
                    }
                }
                Err(error) => {
                    current.cancel_token.cancel();
                    current.task.status = TaskState::Failed.as_status().to_owned();
                    current.task.engine_status = Some("completion-invalid".to_owned());
                    current.task.error_message = Some(limit_error(&error));
                    current.task.speed_bytes_per_sec = 0;
                    current.task.time_left_seconds = 0;
                }
            }
            current.task.clone()
        };
        lock_or_err!(state.task_snapshot).insert(id.clone(), task);
        state.mark_dirty();

        if let Some(storage) = tracker_storage {
            start_torrent_seed_services(state, &id, storage);
        }
    }
}

pub async fn shutdown_torrent_tasks(state: &SharedState) {
    let pending = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let mut pending = Vec::new();
        for (id, job) in jobs.iter_mut() {
            let current = TaskState::from_status(&job.task.status);
            job.cancel_token.cancel();
            job.seed_cancel_token.cancel();
            job.seeding.stop_timer();
            if current == Some(TaskState::Completed) {
                continue;
            }
            job.run_generation.fetch_add(1, Ordering::AcqRel);
            if current != Some(TaskState::Paused) {
                if let Some(current) = current {
                    if current.can_transition_to(TaskState::Paused) {
                        let _ = transition_task_state(&mut job.task, TaskState::Paused, "shutdown");
                    } else {
                        job.task.status = TaskState::Paused.as_status().to_owned();
                        job.task.engine_status = Some("shutdown".to_owned());
                    }
                } else {
                    job.task.status = TaskState::Paused.as_status().to_owned();
                    job.task.engine_status = Some("shutdown".to_owned());
                }
            }
            job.task.speed_bytes_per_sec = 0;
            job.task.time_left_seconds = 0;
            pending.push((
                id.clone(),
                job.task.clone(),
                job.storage.clone(),
                job.active_slot.clone(),
            ));
        }
        pending
    };

    for (id, task, storage_slot, active_slot) in pending {
        if let Some(storage) = storage_slot.lock().await.clone() {
            let _ = storage.pause().await;
        }
        release_queue_slot(state, &id, &active_slot, false);
        lock_or_err!(state.task_snapshot).insert(id, task);
    }
    if !lock_or_err!(state.torrent_jobs).is_empty() {
        state.mark_dirty();
    }
}

pub async fn pause_torrent_task(state: &SharedState, id: &str) -> Result<Task, String> {
    let (storage_slot, generation, active) = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get_mut(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        let current = TaskState::from_status(&job.task.status)
            .ok_or_else(|| format!("Torrent task has unknown state '{}'", job.task.status))?;
        if current == TaskState::Completed {
            return Err("Completed torrent cannot be paused".to_owned());
        }
        let active = current.is_active();
        let next = if active {
            TaskState::Pausing
        } else {
            TaskState::Paused
        };
        transition_task_state(
            &mut job.task,
            next,
            if active { "pausing" } else { "paused" },
        )?;
        job.cancel_token.cancel();
        job.seed_cancel_token.cancel();
        job.seeding.stop_timer();
        job.task.speed_bytes_per_sec = 0;
        let task = job.task.clone();
        let out = (
            job.storage.clone(),
            job.run_generation.load(Ordering::Acquire),
            active,
        );
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
        out
    };
    state.mark_dirty();

    if active {
        if let Some(storage) = storage_slot.lock().await.clone() {
            let _ = storage.pause().await;
        }
        let task = {
            let mut jobs = lock_or_err!(state.torrent_jobs);
            let job = jobs.get_mut(id).ok_or_else(|| "Torrent task not found".to_owned())?;
            if job.run_generation.load(Ordering::Acquire) == generation
                && TaskState::from_status(&job.task.status) == Some(TaskState::Pausing)
            {
                transition_task_state(&mut job.task, TaskState::Paused, "paused")?;
            }
            job.task.clone()
        };
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task.clone());
        state.mark_dirty();
        Ok(task)
    } else {
        get_torrent_task(state, id).ok_or_else(|| "Torrent task not found".to_owned())
    }
}

pub async fn resume_torrent_task(state: &SharedState, id: &str) -> Result<Task, String> {
    {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get_mut(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        if job.requires_reauth {
            return Err(
                "Torrent tracker authorization is required. Re-authorize the magnet link first."
                    .to_owned(),
            );
        }
        let current = TaskState::from_status(&job.task.status)
            .ok_or_else(|| format!("Torrent task has unknown state '{}'", job.task.status))?;
        if current == TaskState::Completed {
            return Err("Completed torrent cannot be resumed".to_owned());
        }
        if current.is_active() {
            return Err(format!("Torrent task is still active in '{}'", current.as_status()));
        }
        if current == TaskState::Failed {
            restart_task_state(&mut job.task, "resume-requested")?;
        } else if current != TaskState::Queued {
            transition_task_state(&mut job.task, TaskState::Queued, "resume-requested")?;
        } else {
            job.task.engine_status = Some("resume-requested".to_owned());
        }
        job.task.error_message = None;
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    }
    state.mark_dirty();
    start_torrent_process(state, id)?;
    get_torrent_task(state, id).ok_or_else(|| "Torrent task not found".to_owned())
}

pub async fn delete_torrent_task(
    state: &SharedState,
    id: &str,
    delete_files: bool,
) -> Result<(), String> {
    let job = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| "Torrent task not found".to_owned())?;
        job.cancel_token.cancel();
        job.seed_cancel_token.cancel();
        job.seeding.stop_timer();
        job.run_generation.fetch_add(1, Ordering::AcqRel);

        let current = TaskState::from_status(&job.task.status);
        if current != Some(TaskState::Completed) && current != Some(TaskState::Paused) {
            if current.is_some_and(|state| state.can_transition_to(TaskState::Paused)) {
                transition_task_state(&mut job.task, TaskState::Paused, "delete-requested")?;
            } else {
                job.task.status = TaskState::Paused.as_status().to_owned();
                job.task.engine_status = Some("delete-requested".to_owned());
            }
            job.task.speed_bytes_per_sec = 0;
            job.task.time_left_seconds = 0;
        }
        let snapshot = job.task.clone();
        let cloned = job.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), snapshot);
        cloned
    };

    release_queue_slot(state, id, &job.active_slot, true);
    state.bandwidth_manager.remove_task_limit(id);
    state.mark_dirty();

    match ensure_storage_session(&job, job.storage.clone()).await {
        Ok(storage) => {
            if delete_files {
                storage
                    .delete_owned_payload_and_state()
                    .await
                    .map_err(|error| {
                        format!(
                            "Could not safely delete NOVA-owned torrent payload; task was kept: {error}"
                        )
                    })?;
            } else if let Err(error) = storage.remove_resume_state().await {
                log::warn!(
                    "Torrent task {id} was removed but its resume state could not be cleaned: {error}"
                );
            }
        }
        Err(error) if delete_files => {
            return Err(format!(
                "Could not verify NOVA-owned torrent payload before deletion; task was kept: {error}"
            ));
        }
        Err(error) => {
            log::warn!(
                "Torrent task {id} was removed without resume-state cleanup because storage could not be restored: {error}"
            );
        }
    }

    lock_or_err!(state.torrent_jobs).remove(id);
    lock_or_err!(state.task_snapshot).remove(id);
    state.mark_dirty();
    Ok(())
}

pub async fn redownload_torrent_task(state: &SharedState, id: &str) -> Result<Task, String> {
    let job = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.get(id).cloned().ok_or_else(|| "Torrent task not found".to_owned())?
    };
    if TaskState::from_status(&job.task.status).is_some_and(TaskState::is_active) {
        let _ = pause_torrent_task(state, id).await?;
    }

    let storage = ensure_storage_session(&job, job.storage.clone()).await?;
    let plan = storage.transfer_plan().await.map_err(|error| error.to_string())?;
    let selection = TorrentSelection::new(
        &plan.metainfo,
        plan.file_priorities.clone(),
    )
    .map_err(|error| error.to_string())?;
    storage
        .delete_owned_payload_and_state()
        .await
        .map_err(|error| error.to_string())?;

    let replacement = TorrentStorageSession::create(
        PathBuf::from(&job.task.save_path),
        plan.metainfo,
        selection,
        AllocationMode::Sparse,
    )
    .await
    .map_err(|error| error.to_string())?;

    {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let current = jobs.get_mut(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        restart_task_state(&mut current.task, "redownload-requested")?;
        current.task.downloaded_bytes = 0;
        current.task.speed_bytes_per_sec = 0;
        current.task.time_left_seconds = 0;
        current.task.error_message = None;
        current.storage = Arc::new(tokio::sync::Mutex::new(Some(replacement)));
        current.cancel_token = CancellationToken::new();
        current.seed_cancel_token.cancel();
        current.seed_cancel_token = CancellationToken::new();
        current.seeding.reset_statistics();
        current.active_slot.store(false, Ordering::Release);
        current.run_generation.fetch_add(1, Ordering::AcqRel);
        let task = current.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    }
    state.mark_dirty();
    start_torrent_process(state, id)?;
    get_torrent_task(state, id).ok_or_else(|| "Torrent task not found".to_owned())
}

pub(crate) async fn ensure_storage_session(
    job: &TorrentJob,
    slot: Arc<tokio::sync::Mutex<Option<TorrentStorageSession>>>,
) -> Result<TorrentStorageSession, String> {
    let mut guard = slot.lock().await;
    if let Some(storage) = guard.as_ref() {
        return Ok(storage.clone());
    }
    let info_hash = info_hash_from_hex(&job.task.engine_id)?;
    let storage = TorrentStorageSession::resume_from_manifest(
        PathBuf::from(&job.task.save_path),
        info_hash,
    )
    .await
    .map_err(|error| format!("Could not restore torrent storage: {error}"))?;
    *guard = Some(storage.clone());
    Ok(storage)
}

fn transition_torrent_task(
    state: &SharedState,
    id: &str,
    generation: u64,
    next: TaskState,
    engine_status: &str,
) -> Result<(), String> {
    let task = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let job = jobs.get_mut(id).ok_or_else(|| "Torrent task not found".to_owned())?;
        if job.run_generation.load(Ordering::Acquire) != generation {
            return Err("Torrent worker generation is stale".to_owned());
        }
        transition_task_state(&mut job.task, next, engine_status)?;
        job.task.clone()
    };
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
    Ok(())
}

fn torrent_generation_current(state: &SharedState, id: &str, generation: u64) -> bool {
    lock_or_err!(state.torrent_jobs)
        .get(id)
        .is_some_and(|job| job.run_generation.load(Ordering::Acquire) == generation)
}

fn finish_torrent_cancelled(
    state: &SharedState,
    id: &str,
    generation: u64,
    active_slot: &Arc<AtomicBool>,
) {
    let task = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let Some(job) = jobs.get_mut(id) else {
            release_queue_slot(state, id, active_slot, false);
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            release_queue_slot(state, id, active_slot, false);
            return;
        }
        let current = TaskState::from_status(&job.task.status);
        job.seed_cancel_token.cancel();
        job.seeding.stop_timer();
        if current != Some(TaskState::Completed) {
            if current != Some(TaskState::Paused) {
                let _ = transition_task_state(&mut job.task, TaskState::Paused, "paused");
            }
            job.task.speed_bytes_per_sec = 0;
            job.task.time_left_seconds = 0;
        }
        job.task.clone()
    };
    release_queue_slot(state, id, active_slot, false);
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
}

fn fail_torrent_task(
    state: &SharedState,
    id: &str,
    generation: u64,
    error: String,
    active_slot: &Arc<AtomicBool>,
) {
    let task = {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        let Some(job) = jobs.get_mut(id) else {
            release_queue_slot(state, id, active_slot, true);
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            release_queue_slot(state, id, active_slot, false);
            return;
        }
        job.cancel_token.cancel();
        job.seed_cancel_token.cancel();
        job.seeding.stop_timer();
        let _ = transition_task_state(&mut job.task, TaskState::Failed, "error");
        job.task.error_message = Some(limit_error(&error));
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.clone()
    };
    release_queue_slot(state, id, active_slot, true);
    if let Ok(mut stats) = state.download_stats.lock() {
        stats.total_failed = stats.total_failed.saturating_add(1);
    }
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
}

fn release_queue_slot(
    state: &SharedState,
    id: &str,
    active_slot: &Arc<AtomicBool>,
    remove_entry: bool,
) {
    if active_slot.swap(false, Ordering::AcqRel) {
        if remove_entry {
            state.priority_queue.stop_download(id);
        } else {
            state.priority_queue.release_active_slot();
        }
    } else if remove_entry {
        state.priority_queue.remove(id);
    }
}

fn ensure_torrent_queue_entry(
    state: &SharedState,
    task: &Task,
    allocation: Arc<AtomicU64>,
    priority: DownloadPriority,
) {
    if state
        .priority_queue
        .entries()
        .iter()
        .any(|entry| entry.task_id == task.id)
    {
        return;
    }
    state.priority_queue.enqueue(QueueEntry {
        task_id: task.id.clone(),
        priority,
        added_at: Instant::now(),
        size_bytes: task.size_bytes,
        bandwidth_kbps: allocation,
    });
}

fn analysis_view(id: &str, resolution: &MagnetResolution) -> TorrentAnalysisView {
    TorrentAnalysisView {
        analysis_id: id.to_owned(),
        info_hash: resolution.metainfo.info_hash.to_hex(),
        name: resolution.metainfo.name.clone(),
        total_length: resolution.metainfo.total_length,
        piece_length: resolution.metainfo.piece_length,
        piece_count: resolution.metainfo.piece_count(),
        files: resolution
            .metainfo
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| TorrentFileView {
                index,
                path: file.path.clone(),
                length: file.length,
                priority: FilePriority::Normal,
            })
            .collect(),
        private: resolution.metainfo.private,
        tracker_count: resolution.metainfo.trackers.len(),
        peer_count: resolution_candidates(resolution).len(),
        used_dht: resolution.used_dht,
    }
}

fn resolution_candidates(resolution: &MagnetResolution) -> Vec<SocketAddr> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for peer in resolution
        .metadata_peer
        .iter()
        .copied()
        .chain(resolution.tracker_peers.iter().copied())
        .chain(resolution.dht_peers.iter().copied())
        .chain(resolution.pex_peers.iter().copied())
    {
        if peer.port() != 0 && seen.insert(peer) {
            output.push(peer);
        }
    }
    output.truncate(2048);
    output
}

fn discovery_source_from_metainfo(metainfo: &TorrentMetainfo) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("xt", &format!("urn:btih:{}", metainfo.info_hash.to_hex()));
    query.append_pair("dn", &metainfo.name);
    query.append_pair("xl", &metainfo.total_length.to_string());
    for tracker in &metainfo.trackers {
        query.append_pair("tr", tracker);
    }
    format!("magnet:?{}", query.finish())
}

pub fn persistable_magnet_source(input: &str, private_torrent: bool) -> Result<(String, bool), String> {
    let magnet = MagnetLink::parse(input)
        .map_err(|error| format!("Invalid magnet URI: {error}"))?;
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("xt", &format!("urn:btih:{}", magnet.info_hash.to_hex()));
    if let Some(name) = magnet.display_name.as_deref() {
        query.append_pair("dn", name);
    }
    if let Some(length) = magnet.exact_length {
        query.append_pair("xl", &length.to_string());
    }

    let mut removed_sensitive = false;
    for tracker in &magnet.trackers {
        let parsed = Url::parse(tracker).map_err(|_| "Invalid tracker URL".to_owned())?;
        let sensitive = private_torrent
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some();
        if sensitive {
            removed_sensitive = true;
        } else {
            query.append_pair("tr", tracker);
        }
    }
    Ok((format!("magnet:?{}", query.finish()), removed_sensitive))
}

pub fn info_hash_from_hex(value: &str) -> Result<InfoHash, String> {
    if value.len() != 40 {
        return Err("Torrent engine id is not a 40-character info hash".to_owned());
    }
    let mut bytes = [0u8; 20];
    let raw = value.as_bytes();
    for index in 0..20 {
        let high = hex_nibble(raw[index * 2])
            .ok_or_else(|| "Torrent engine id contains invalid hex".to_owned())?;
        let low = hex_nibble(raw[index * 2 + 1])
            .ok_or_else(|| "Torrent engine id contains invalid hex".to_owned())?;
        bytes[index] = (high << 4) | low;
    }
    Ok(InfoHash::new(bytes))
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn limit_error(value: &str) -> String {
    const MAX: usize = 512;
    let mut output = value.chars().take(MAX).collect::<String>();
    if value.chars().count() > MAX {
        output.push_str("...");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_policy_input_rounds_ratio_to_milli_units() {
        let policy = seeding_policy_from_body(&UpdateTorrentSeedingBody {
            enabled: true,
            ratio_limit: Some(1.2344),
            time_limit_seconds: Some(3600),
        })
        .unwrap();
        assert_eq!(policy.ratio_limit_milli, Some(1234));
        assert_eq!(policy.time_limit_seconds, Some(3600));
    }

    #[test]
    fn seeding_policy_input_rejects_invalid_ratio() {
        assert!(seeding_policy_from_body(&UpdateTorrentSeedingBody {
            enabled: true,
            ratio_limit: Some(f64::NAN),
            time_limit_seconds: None,
        })
        .is_err());
    }

    #[test]
    fn metainfo_import_builds_secret_safe_restart_source() {
        use nova_torrent_core::TorrentFile;

        let metainfo = TorrentMetainfo {
            info_hash: InfoHash::new([0x21; 20]),
            name: "imported.bin".to_owned(),
            piece_length: 4,
            piece_hashes: vec![[0x11; 20]],
            files: vec![TorrentFile {
                path: "imported.bin".to_owned(),
                length: 4,
                offset: 0,
            }],
            total_length: 4,
            trackers: vec![
                "https://tracker.example/announce".to_owned(),
                "https://tracker.example/private?passkey=secret".to_owned(),
            ],
            tracker_tiers: Vec::new(),
            private: true,
        };

        let full = discovery_source_from_metainfo(&metainfo);
        let parsed = MagnetLink::parse(&full).unwrap();
        assert_eq!(parsed.info_hash, metainfo.info_hash);
        assert_eq!(parsed.trackers.len(), 2);

        let (persisted, requires_reauth) = persistable_magnet_source(&full, true).unwrap();
        assert!(requires_reauth);
        assert!(!persisted.contains("passkey"));
        assert!(!persisted.contains("secret"));
        let sanitized = MagnetLink::parse(&persisted).unwrap();
        assert_eq!(sanitized.info_hash, metainfo.info_hash);
        assert!(sanitized.trackers.is_empty());
    }

    #[tokio::test]
    async fn completed_torrent_recheck_invalidates_changed_payload() {
        use nova_torrent_core::TorrentFile;
        use sha1::{Digest, Sha1};

        let data_dir = std::env::temp_dir().join(format!(
            "nova-torrent-completion-recheck-{}",
            uuid::Uuid::new_v4()
        ));
        let payload_root = data_dir.join("payload");
        std::fs::create_dir_all(&data_dir).unwrap();

        let digest = Sha1::digest(b"abcd");
        let mut piece_hash = [0u8; 20];
        piece_hash.copy_from_slice(&digest);
        let info_hash = InfoHash::new([0x42; 20]);
        let metainfo = TorrentMetainfo {
            info_hash,
            name: "complete.bin".to_owned(),
            piece_length: 4,
            piece_hashes: vec![piece_hash],
            files: vec![TorrentFile {
                path: "complete.bin".to_owned(),
                length: 4,
                offset: 0,
            }],
            total_length: 4,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        };

        let storage = TorrentStorageSession::create(
            payload_root.clone(),
            metainfo.clone(),
            TorrentSelection::all(&metainfo),
            AllocationMode::Sparse,
        )
        .await
        .unwrap();
        let lease = storage.begin_run().await.unwrap();
        storage
            .commit_piece(&lease, 0, b"abcd".to_vec())
            .await
            .unwrap();
        storage.finalize_selected(&lease).await.unwrap();

        let source = format!("magnet:?xt=urn:btih:{}", info_hash.to_hex());
        let task = Task {
            id: "completed-torrent".to_owned(),
            name: "complete.bin".to_owned(),
            url: source.clone(),
            file_type: "torrent".to_owned(),
            status: TaskState::Completed.as_status().to_owned(),
            size_bytes: 4,
            downloaded_bytes: 4,
            speed_bytes_per_sec: 0,
            time_left_seconds: 0,
            elapsed_seconds: 1,
            date_added: "2026-09-24T00:00:00Z".to_owned(),
            category: "torrent".to_owned(),
            queue_id: "main".to_owned(),
            connections: 1,
            resumable: true,
            save_path: payload_root.display().to_string(),
            description: "test torrent".to_owned(),
            segments: Vec::new(),
            referer: None,
            engine: TORRENT_ENGINE_ID.to_owned(),
            engine_id: info_hash.to_hex(),
            engine_status: Some("completed".to_owned()),
            error_message: None,
        };

        let mut job = restore_torrent_job(
            task.clone(),
            Some(source),
            false,
            BandwidthManager::default(),
            None,
        )
        .unwrap();
        job.storage = Arc::new(tokio::sync::Mutex::new(Some(storage)));
        let state = Arc::new(crate::daemon::persist::tests::test_state(
            &data_dir.display().to_string(),
        ));
        state
            .torrent_jobs
            .lock()
            .unwrap()
            .insert(task.id.clone(), job);
        state
            .task_snapshot
            .lock()
            .unwrap()
            .insert(task.id.clone(), task);

        recheck_restored_completed_torrents(&state).await;
        {
            let jobs = state.torrent_jobs.lock().unwrap();
            let verified = jobs.get("completed-torrent").unwrap();
            assert_eq!(verified.task.status, "completed");
            assert_eq!(
                verified.task.engine_status.as_deref(),
                Some("completed-verified")
            );
        }

        std::fs::write(payload_root.join("complete.bin"), b"xbcd").unwrap();
        recheck_restored_completed_torrents(&state).await;
        {
            let jobs = state.torrent_jobs.lock().unwrap();
            let invalid = jobs.get("completed-torrent").unwrap();
            assert_eq!(invalid.task.status, "error");
            assert_eq!(
                invalid.task.engine_status.as_deref(),
                Some("completion-invalid")
            );
        }

        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn persistence_strips_credentialed_trackers_but_keeps_safe_ones() {
        let source = "magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=test&tr=https%3A%2F%2Fsafe.example%2Fannounce&tr=https%3A%2F%2Fprivate.example%2Fannounce%3Fpasskey%3Dsecret";
        let (persisted, reauth) = persistable_magnet_source(source, false).unwrap();
        assert!(reauth);
        assert!(persisted.contains("safe.example"));
        assert!(!persisted.contains("private.example"));
        assert!(!persisted.contains("secret"));
        assert!(MagnetLink::parse(&persisted).is_ok());
    }

    #[test]
    fn info_hash_hex_round_trip() {
        let value = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(info_hash_from_hex(value).unwrap().to_hex(), value);
    }
}
