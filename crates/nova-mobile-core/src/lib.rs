//! Android-safe mobile facade over NOVA's shared download core.
//!
//! Android owns lifecycle and secure intent persistence. Transfer bytes,
//! segmentation, validation, pause/cancel control and resumable artifacts are
//! owned by the platform-neutral Rust core.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use nova_download_core::HttpRequestContext;
use nova_media_processing_core::{
    transcode_local_media, MediaProcessingControl, MediaProcessingPhase, MediaProcessingProgress,
    NativeMediaTranscodeJob, NativeMediaTranscodeResult,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MobileTransferOutcome {
    pub final_bytes: u64,
    pub total_bytes: Option<u64>,
    pub resumed_from: u64,
    pub effective_url: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MobileTransferProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MobileMediaProcessingProgress {
    pub phase: u8,
    pub completed_units: u64,
    pub total_units: u64,
    pub fraction: f32,
    pub has_fraction: bool,
    pub active: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MobileMediaTranscodeOptions {
    pub input_container: String,
    pub source_video_codec: Option<String>,
    pub source_audio_codec: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub video_bitrate_bps: Option<u64>,
    pub audio_bitrate_bps: Option<u64>,
    pub quality_crf: Option<u8>,
    pub preset: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate_milli: Option<u32>,
    pub audio_sample_rate_hz: Option<u32>,
    pub audio_channels: Option<u8>,
    pub threads: Option<u8>,
    pub include_video: bool,
    pub include_audio: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum MobileTransferError {
    #[error("invalid app-private relative destination")]
    InvalidRelativeDestination,
    #[error("app-private destination escaped its configured root")]
    DestinationEscapedRoot,
    #[error("shared NOVA transfer paused")]
    Paused,
    #[error("shared NOVA transfer cancelled")]
    Cancelled,
    #[error("shared NOVA transfer failed: {message}")]
    TransferFailed { message: String },
}

#[derive(Debug, thiserror::Error)]
pub enum MobileMediaProcessingError {
    #[error("invalid app-private relative media path")]
    InvalidRelativePath,
    #[error("app-private media path escaped its configured root")]
    PathEscapedRoot,
    #[error("native media processing is paused")]
    Paused,
    #[error("native media processing was cancelled")]
    Cancelled,
    #[error("native media processing failed: {message}")]
    ProcessingFailed { message: String },
}

const CONTROL_CONTINUE: u8 = 0;
const CONTROL_PAUSE: u8 = 1;
const CONTROL_CANCEL: u8 = 2;
const PROCESSING_PHASE_PLANNING: u8 = 0;
const PROCESSING_PHASE_PROBING: u8 = 1;
const PROCESSING_PHASE_DEMUXING: u8 = 2;
const PROCESSING_PHASE_DECODING: u8 = 3;
const PROCESSING_PHASE_FILTERING: u8 = 4;
const PROCESSING_PHASE_ENCODING: u8 = 5;
const PROCESSING_PHASE_MUXING: u8 = 6;
const PROCESSING_PHASE_FINALIZING: u8 = 7;
const PROCESSING_PHASE_COMPLETED: u8 = 8;
pub const DEFAULT_MOBILE_CONNECTIONS: u32 = 4;

struct MediaProcessingSession {
    control: AtomicU8,
    progress: Mutex<MobileMediaProcessingProgress>,
}

impl MediaProcessingSession {
    fn new() -> Self {
        Self {
            control: AtomicU8::new(CONTROL_CONTINUE),
            progress: Mutex::new(MobileMediaProcessingProgress {
                active: true,
                ..MobileMediaProcessingProgress::default()
            }),
        }
    }

    fn snapshot(&self) -> MobileMediaProcessingProgress {
        self.progress
            .lock()
            .map(|progress| *progress)
            .unwrap_or_default()
    }

    fn update(&self, update: &MediaProcessingProgress) {
        if let Ok(mut progress) = self.progress.lock() {
            progress.phase = match update.phase {
                MediaProcessingPhase::Planning => PROCESSING_PHASE_PLANNING,
                MediaProcessingPhase::Probing => PROCESSING_PHASE_PROBING,
                MediaProcessingPhase::Demuxing => PROCESSING_PHASE_DEMUXING,
                MediaProcessingPhase::Decoding => PROCESSING_PHASE_DECODING,
                MediaProcessingPhase::Filtering => PROCESSING_PHASE_FILTERING,
                MediaProcessingPhase::Encoding => PROCESSING_PHASE_ENCODING,
                MediaProcessingPhase::Muxing => PROCESSING_PHASE_MUXING,
                MediaProcessingPhase::Finalizing => PROCESSING_PHASE_FINALIZING,
                MediaProcessingPhase::Completed => PROCESSING_PHASE_COMPLETED,
            };
            progress.completed_units = update.completed_units;
            progress.total_units = update.total_units.unwrap_or(0);
            progress.fraction = update.fraction.unwrap_or(0.0).clamp(0.0, 1.0);
            progress.has_fraction = update.fraction.is_some();
        }
    }
}

struct SessionState {
    control: AtomicU8,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
}

impl SessionState {
    fn new() -> Self {
        Self {
            control: AtomicU8::new(CONTROL_CONTINUE),
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
        }
    }

    fn progress(&self) -> MobileTransferProgress {
        MobileTransferProgress {
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Acquire),
            total_bytes: self.total_bytes.load(Ordering::Acquire),
        }
    }

    fn update_progress(&self, downloaded_bytes: u64, total_bytes: Option<u64>) {
        self.downloaded_bytes
            .store(downloaded_bytes, Ordering::Release);
        if let Some(total_bytes) = total_bytes {
            self.total_bytes.store(total_bytes, Ordering::Release);
        }
    }
}

/// Registered mobile transfer state shared with native media orchestration.
/// Dropping the handle snapshots progress and unregisters the task.
pub struct MobileTransferSession {
    task_id: String,
    state: Arc<SessionState>,
    finished: bool,
}

impl MobileTransferSession {
    pub fn control(&self) -> nova_download_core::TransferControl {
        match self.state.control.load(Ordering::Acquire) {
            CONTROL_PAUSE => nova_download_core::TransferControl::Pause,
            CONTROL_CANCEL => nova_download_core::TransferControl::Cancel,
            _ => nova_download_core::TransferControl::Continue,
        }
    }

    pub fn update_progress(&self, downloaded_bytes: u64, total_bytes: Option<u64>) {
        self.state.update_progress(downloaded_bytes, total_bytes);
    }

    pub fn finish(mut self) {
        self.finalize();
        self.finished = true;
    }

    fn finalize(&self) {
        if let Ok(mut progress) = last_progress().lock() {
            progress.insert(self.task_id.clone(), self.state.progress());
        }
        if let Ok(mut sessions) = sessions().lock() {
            sessions.remove(&self.task_id);
        }
    }
}

impl Drop for MobileTransferSession {
    fn drop(&mut self) {
        if !self.finished {
            self.finalize();
            self.finished = true;
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<SessionState>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<SessionState>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn media_processing_sessions() -> &'static Mutex<HashMap<String, Arc<MediaProcessingSession>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<MediaProcessingSession>>>> =
        OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn last_media_processing_progress() -> &'static Mutex<HashMap<String, MobileMediaProcessingProgress>>
{
    static PROGRESS: OnceLock<Mutex<HashMap<String, MobileMediaProcessingProgress>>> =
        OnceLock::new();
    PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validated_app_private_media_path(
    app_private_root: &Path,
    relative_path: &Path,
) -> Result<PathBuf, MobileMediaProcessingError> {
    if relative_path.as_os_str().is_empty() || relative_path.is_absolute() {
        return Err(MobileMediaProcessingError::InvalidRelativePath);
    }
    for component in relative_path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(MobileMediaProcessingError::InvalidRelativePath);
            }
        }
    }
    let root = app_private_root.canonicalize().map_err(|error| {
        MobileMediaProcessingError::ProcessingFailed {
            message: error.to_string(),
        }
    })?;
    let candidate = root.join(relative_path);
    if !candidate.starts_with(&root) {
        return Err(MobileMediaProcessingError::PathEscapedRoot);
    }
    Ok(candidate)
}

fn validate_media_source_inside_root(
    root: &Path,
    source: &Path,
) -> Result<PathBuf, MobileMediaProcessingError> {
    let root =
        root.canonicalize()
            .map_err(|error| MobileMediaProcessingError::ProcessingFailed {
                message: error.to_string(),
            })?;
    let source =
        source
            .canonicalize()
            .map_err(|error| MobileMediaProcessingError::ProcessingFailed {
                message: error.to_string(),
            })?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err(MobileMediaProcessingError::PathEscapedRoot);
    }
    Ok(source)
}

fn prepare_media_destination_inside_root(
    root: &Path,
    destination: &Path,
) -> Result<PathBuf, MobileMediaProcessingError> {
    let root =
        root.canonicalize()
            .map_err(|error| MobileMediaProcessingError::ProcessingFailed {
                message: error.to_string(),
            })?;
    let parent = destination
        .parent()
        .ok_or(MobileMediaProcessingError::InvalidRelativePath)?;
    std::fs::create_dir_all(parent).map_err(|error| {
        MobileMediaProcessingError::ProcessingFailed {
            message: error.to_string(),
        }
    })?;
    let parent =
        parent
            .canonicalize()
            .map_err(|error| MobileMediaProcessingError::ProcessingFailed {
                message: error.to_string(),
            })?;
    if !parent.starts_with(&root) {
        return Err(MobileMediaProcessingError::PathEscapedRoot);
    }
    let file_name = destination
        .file_name()
        .ok_or(MobileMediaProcessingError::InvalidRelativePath)?;
    let destination = parent.join(file_name);
    if destination.exists() {
        let existing = destination.canonicalize().map_err(|error| {
            MobileMediaProcessingError::ProcessingFailed {
                message: error.to_string(),
            }
        })?;
        if !existing.starts_with(&root) {
            return Err(MobileMediaProcessingError::PathEscapedRoot);
        }
    }
    Ok(destination)
}

fn map_processing_control(control: u8) -> MediaProcessingControl {
    match control {
        CONTROL_PAUSE => MediaProcessingControl::Pause,
        CONTROL_CANCEL => MediaProcessingControl::Cancel,
        _ => MediaProcessingControl::Continue,
    }
}

/// Converts one user-selected local media file using the codecs linked into
/// NOVA. Both paths are constrained to Android's private files root; public
/// document URIs remain under Android/Kotlin ownership.
pub fn transcode_media_in_app_private(
    task_id: &str,
    app_private_root: &Path,
    source_relative_path: &Path,
    destination_relative_path: &Path,
    options: &MobileMediaTranscodeOptions,
) -> Result<NativeMediaTranscodeResult, MobileMediaProcessingError> {
    if task_id.trim().is_empty() {
        return Err(MobileMediaProcessingError::ProcessingFailed {
            message: "missing media processing task id".to_owned(),
        });
    }
    if options.input_container.trim().is_empty()
        || (!options.include_video && !options.include_audio)
    {
        return Err(MobileMediaProcessingError::ProcessingFailed {
            message: "select a source container and at least one media track".to_owned(),
        });
    }
    let source = validated_app_private_media_path(app_private_root, source_relative_path)?;
    let destination =
        validated_app_private_media_path(app_private_root, destination_relative_path)?;
    let source = validate_media_source_inside_root(app_private_root, &source)?;
    let destination = prepare_media_destination_inside_root(app_private_root, &destination)?;
    if source == destination {
        return Err(MobileMediaProcessingError::InvalidRelativePath);
    }

    let session = Arc::new(MediaProcessingSession::new());
    {
        let mut sessions = media_processing_sessions().lock().map_err(|_| {
            MobileMediaProcessingError::ProcessingFailed {
                message: "native media session registry is unavailable".to_owned(),
            }
        })?;
        if sessions.contains_key(task_id) || is_transfer_active(task_id) {
            return Err(MobileMediaProcessingError::ProcessingFailed {
                message: "native task id is already active".to_owned(),
            });
        }
        sessions.insert(task_id.to_owned(), Arc::clone(&session));
    }
    forget_media_processing_progress(task_id);

    let job = NativeMediaTranscodeJob {
        source,
        destination,
        input_container: options.input_container.clone(),
        source_video_codec: options.source_video_codec.clone(),
        source_audio_codec: options.source_audio_codec.clone(),
        video_codec: options.video_codec.clone(),
        audio_codec: options.audio_codec.clone(),
        video_bitrate_bps: options.video_bitrate_bps,
        audio_bitrate_bps: options.audio_bitrate_bps,
        quality_crf: options.quality_crf,
        preset: options.preset.clone(),
        width: options.width,
        height: options.height,
        frame_rate_milli: options.frame_rate_milli,
        audio_sample_rate_hz: options.audio_sample_rate_hz,
        audio_channels: options.audio_channels,
        threads: options.threads,
        include_video: options.include_video,
        include_audio: options.include_audio,
    };
    let control_session = Arc::clone(&session);
    let progress_session = Arc::clone(&session);
    let result = transcode_local_media(
        &job,
        &move || map_processing_control(control_session.control.load(Ordering::Acquire)),
        &move |progress: &MediaProcessingProgress| progress_session.update(progress),
    );

    let mut final_progress = session.snapshot();
    final_progress.active = false;
    if let Ok(mut progress) = last_media_processing_progress().lock() {
        progress.insert(task_id.to_owned(), final_progress);
    }
    if let Ok(mut sessions) = media_processing_sessions().lock() {
        sessions.remove(task_id);
    }
    result.map_err(|error| match error {
        nova_media_processing_core::MediaProcessingError::Paused => {
            MobileMediaProcessingError::Paused
        }
        nova_media_processing_core::MediaProcessingError::Cancelled => {
            MobileMediaProcessingError::Cancelled
        }
        other => MobileMediaProcessingError::ProcessingFailed {
            message: other.to_string(),
        },
    })
}

fn set_media_processing_control(task_id: &str, control: u8) -> bool {
    media_processing_sessions()
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(task_id).cloned())
        .is_some_and(|session| {
            session.control.store(control, Ordering::Release);
            true
        })
}

pub fn pause_media_processing(task_id: &str) -> bool {
    set_media_processing_control(task_id, CONTROL_PAUSE)
}

pub fn resume_media_processing(task_id: &str) -> bool {
    set_media_processing_control(task_id, CONTROL_CONTINUE)
}

pub fn cancel_media_processing(task_id: &str) -> bool {
    set_media_processing_control(task_id, CONTROL_CANCEL)
}

pub fn media_processing_progress(task_id: &str) -> Option<MobileMediaProcessingProgress> {
    if let Some(session) = media_processing_sessions()
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(task_id).cloned())
    {
        return Some(session.snapshot());
    }
    last_media_processing_progress()
        .lock()
        .ok()
        .and_then(|progress| progress.get(task_id).copied())
}

pub fn forget_media_processing_progress(task_id: &str) {
    if let Ok(mut progress) = last_media_processing_progress().lock() {
        progress.remove(task_id);
    }
}

fn last_progress() -> &'static Mutex<HashMap<String, MobileTransferProgress>> {
    static LAST_PROGRESS: OnceLock<Mutex<HashMap<String, MobileTransferProgress>>> =
        OnceLock::new();
    LAST_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_session_control(task_id: &str, control: u8) -> bool {
    sessions()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).cloned())
        .is_some_and(|state| {
            state.control.store(control, Ordering::Release);
            true
        })
}

pub fn begin_mobile_transfer_session(
    task_id: &str,
) -> Result<MobileTransferSession, MobileTransferError> {
    if task_id.trim().is_empty() {
        return Err(MobileTransferError::TransferFailed {
            message: "missing native task id".to_owned(),
        });
    }
    if is_media_processing_active(task_id) {
        return Err(MobileTransferError::TransferFailed {
            message: "native task session is already active".to_owned(),
        });
    }
    let state = Arc::new(SessionState::new());
    {
        let mut map = sessions()
            .lock()
            .map_err(|_| MobileTransferError::TransferFailed {
                message: "native transfer session registry is unavailable".to_owned(),
            })?;
        if map.contains_key(task_id) {
            return Err(MobileTransferError::TransferFailed {
                message: "native transfer session is already active".to_owned(),
            });
        }
        map.insert(task_id.to_owned(), Arc::clone(&state));
    }
    forget_transfer_progress(task_id);
    Ok(MobileTransferSession {
        task_id: task_id.to_owned(),
        state,
        finished: false,
    })
}

fn is_media_processing_active(task_id: &str) -> bool {
    media_processing_sessions()
        .lock()
        .ok()
        .is_some_and(|sessions| sessions.contains_key(task_id))
}

pub fn pause_transfer(task_id: &str) -> bool {
    set_session_control(task_id, CONTROL_PAUSE)
}

pub fn cancel_transfer(task_id: &str) -> bool {
    set_session_control(task_id, CONTROL_CANCEL)
}

pub fn is_transfer_active(task_id: &str) -> bool {
    sessions()
        .lock()
        .ok()
        .is_some_and(|map| map.contains_key(task_id))
}

/// Returns the freshest native progress snapshot.
///
/// Active sessions are read lock-free from atomics. Once an execution returns,
/// its last snapshot remains available until the Android host persists it and
/// explicitly forgets the transient native progress entry.
pub fn transfer_progress(task_id: &str) -> Option<MobileTransferProgress> {
    if let Some(state) = sessions()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).cloned())
    {
        return Some(state.progress());
    }
    last_progress()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).copied())
}

pub fn forget_transfer_progress(task_id: &str) {
    if let Ok(mut map) = last_progress().lock() {
        map.remove(task_id);
    }
}

fn validated_app_private_destination(
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<PathBuf, MobileTransferError> {
    if relative_destination.as_os_str().is_empty() || relative_destination.is_absolute() {
        return Err(MobileTransferError::InvalidRelativeDestination);
    }

    for component in relative_destination.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(MobileTransferError::InvalidRelativeDestination);
            }
        }
    }

    let destination = app_private_root.join(relative_destination);
    if !destination.starts_with(app_private_root) {
        return Err(MobileTransferError::DestinationEscapedRoot);
    }
    Ok(destination)
}

/// Destructively removes the staging file and every shared-core sidecar/segment.
///
/// This is intentionally separate from pause: pause preserves every durable
/// artifact required for a validated restart.
pub fn discard_app_private_transfer(
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<(), MobileTransferError> {
    let destination = validated_app_private_destination(app_private_root, relative_destination)?;
    nova_download_core::discard_http_download_artifacts(&destination);
    Ok(())
}

/// Resolve a caller-provided relative output inside the canonical app-private
/// root. Parent directories are created before their canonical path is
/// checked so a pre-existing symlink cannot redirect a native write outside
/// the application sandbox.
pub fn prepare_app_private_output_path(
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<PathBuf, MobileTransferError> {
    let lexical = validated_app_private_destination(app_private_root, relative_destination)?;
    let root =
        app_private_root
            .canonicalize()
            .map_err(|error| MobileTransferError::TransferFailed {
                message: error.to_string(),
            })?;
    let parent = lexical
        .parent()
        .ok_or(MobileTransferError::InvalidRelativeDestination)?;
    std::fs::create_dir_all(parent).map_err(|error| MobileTransferError::TransferFailed {
        message: error.to_string(),
    })?;
    let parent = parent
        .canonicalize()
        .map_err(|error| MobileTransferError::TransferFailed {
            message: error.to_string(),
        })?;
    if !parent.starts_with(&root) {
        return Err(MobileTransferError::DestinationEscapedRoot);
    }
    let file_name = lexical
        .file_name()
        .ok_or(MobileTransferError::InvalidRelativeDestination)?;
    let destination = parent.join(file_name);
    if destination.exists()
        && !destination
            .canonicalize()
            .map_err(|error| MobileTransferError::TransferFailed {
                message: error.to_string(),
            })?
            .starts_with(&root)
    {
        return Err(MobileTransferError::DestinationEscapedRoot);
    }
    Ok(destination)
}

/// Creates a task-isolated native staging directory under app-private files.
/// Task identifiers are restricted to a compact filename alphabet and the
/// canonical result is checked after creation.
pub fn prepare_app_private_media_staging_dir(
    app_private_root: &Path,
    task_id: &str,
) -> Result<PathBuf, MobileTransferError> {
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(MobileTransferError::InvalidRelativeDestination);
    }
    let root =
        app_private_root
            .canonicalize()
            .map_err(|error| MobileTransferError::TransferFailed {
                message: error.to_string(),
            })?;
    let parent = root.join("nova-media-staging");
    std::fs::create_dir_all(&parent).map_err(|error| MobileTransferError::TransferFailed {
        message: error.to_string(),
    })?;
    let parent = parent
        .canonicalize()
        .map_err(|error| MobileTransferError::TransferFailed {
            message: error.to_string(),
        })?;
    if !parent.starts_with(&root) {
        return Err(MobileTransferError::DestinationEscapedRoot);
    }
    let staging = parent.join(task_id);
    std::fs::create_dir_all(&staging).map_err(|error| MobileTransferError::TransferFailed {
        message: error.to_string(),
    })?;
    let staging = staging
        .canonicalize()
        .map_err(|error| MobileTransferError::TransferFailed {
            message: error.to_string(),
        })?;
    if !staging.starts_with(&root) {
        return Err(MobileTransferError::DestinationEscapedRoot);
    }
    Ok(staging)
}

/// Removes task-scoped media segment staging after a terminal outcome.
pub fn discard_app_private_media_staging_dir(
    app_private_root: &Path,
    task_id: &str,
) -> Result<(), MobileTransferError> {
    let staging = prepare_app_private_media_staging_dir(app_private_root, task_id)?;
    std::fs::remove_dir_all(staging).map_err(|error| MobileTransferError::TransferFailed {
        message: error.to_string(),
    })
}

pub fn download_to_app_private_path(
    task_id: &str,
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    download_to_app_private_path_with_connections(
        task_id,
        url,
        app_private_root,
        relative_destination,
        DEFAULT_MOBILE_CONNECTIONS,
    )
}

pub fn download_to_app_private_path_with_connections(
    task_id: &str,
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
    requested_connections: u32,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    download_to_app_private_path_with_context(
        task_id,
        url,
        app_private_root,
        relative_destination,
        &HttpRequestContext::default(),
        requested_connections,
    )
}

pub fn download_to_app_private_path_with_context(
    task_id: &str,
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
    request_context: &HttpRequestContext,
    requested_connections: u32,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    let destination = prepare_app_private_output_path(app_private_root, relative_destination)?;
    let session = begin_mobile_transfer_session(task_id)?;
    let transfer_result =
        nova_download_core::download_http_to_path_segmented_controlled_with_context(
            url,
            &destination,
            requested_connections.max(1),
            request_context,
            || session.control(),
            |downloaded_bytes, total_bytes| session.update_progress(downloaded_bytes, total_bytes),
        );

    if let Ok(transfer) = &transfer_result {
        session.update_progress(transfer.final_bytes, transfer.total_bytes);
    }
    session.finish();

    let transfer = match transfer_result {
        Ok(transfer) => transfer,
        Err(nova_download_core::TransportError::Paused) => return Err(MobileTransferError::Paused),
        Err(nova_download_core::TransportError::Cancelled) => {
            nova_download_core::discard_http_download_artifacts(&destination);
            return Err(MobileTransferError::Cancelled);
        }
        Err(error) => {
            return Err(MobileTransferError::TransferFailed {
                message: error.to_string(),
            })
        }
    };

    Ok(MobileTransferOutcome {
        final_bytes: transfer.final_bytes,
        total_bytes: transfer.total_bytes,
        resumed_from: transfer.resumed_from,
        effective_url: transfer.effective_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_control_returns_false_for_unknown_task() {
        assert!(!pause_transfer("missing"));
        assert!(!cancel_transfer("missing"));
        assert!(!is_transfer_active("missing"));
        assert_eq!(transfer_progress("missing"), None);
        assert!(!pause_media_processing("missing"));
        assert!(!resume_media_processing("missing"));
        assert!(!cancel_media_processing("missing"));
        assert_eq!(media_processing_progress("missing"), None);
    }

    #[test]
    fn rejects_absolute_and_parent_traversal_destinations() {
        let root = Path::new("/app/files");
        assert!(matches!(
            validated_app_private_destination(root, Path::new("../escape.part")),
            Err(MobileTransferError::InvalidRelativeDestination)
        ));
        assert!(matches!(
            validated_app_private_destination(root, Path::new("/tmp/escape.part")),
            Err(MobileTransferError::InvalidRelativeDestination)
        ));
    }

    #[test]
    fn accepts_nested_relative_staging_destination() {
        let root = Path::new("/app/files");
        let destination =
            validated_app_private_destination(root, Path::new("nova-staging/task-1.part"))
                .expect("valid app-private destination");

        assert_eq!(
            destination,
            Path::new("/app/files/nova-staging/task-1.part")
        );
    }

    #[test]
    fn app_private_media_paths_reject_absolute_and_parent_components() {
        assert!(matches!(
            validated_app_private_media_path(Path::new("/app/files"), Path::new("../outside.mkv")),
            Err(MobileMediaProcessingError::InvalidRelativePath)
        ));
        assert!(matches!(
            validated_app_private_media_path(
                Path::new("/app/files"),
                Path::new("/tmp/outside.mkv")
            ),
            Err(MobileMediaProcessingError::InvalidRelativePath)
        ));
    }

    #[test]
    fn discard_rejects_path_traversal() {
        assert!(matches!(
            discard_app_private_transfer(Path::new("/app/files"), Path::new("../outside.part"),),
            Err(MobileTransferError::InvalidRelativeDestination)
        ));
    }

    #[test]
    fn destructive_discard_removes_shared_core_sidecars_and_segments() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nova-mobile-discard-{unique}"));
        let relative = Path::new("nova-staging/task.part");
        let destination = root.join(relative);
        std::fs::create_dir_all(destination.parent().expect("staging parent"))
            .expect("create staging parent");

        for path in [
            destination.clone(),
            PathBuf::from(format!("{}.nova-identity", destination.display())),
            PathBuf::from(format!("{}.nova-segments", destination.display())),
            PathBuf::from(format!("{}.nova-seg-0000", destination.display())),
            PathBuf::from(format!("{}.nova-seg-0000.done", destination.display())),
            PathBuf::from(format!("{}.nova-merge", destination.display())),
        ] {
            std::fs::write(path, b"temporary").expect("seed transfer artifact");
        }

        discard_app_private_transfer(&root, relative).expect("discard transfer artifacts");

        assert!(!destination.exists());
        assert!(!PathBuf::from(format!("{}.nova-identity", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-segments", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-seg-0000", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-seg-0000.done", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-merge", destination.display())).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn progress_snapshot_tracks_atomic_session_state() {
        let task_id = "progress-test";
        let state = Arc::new(SessionState::new());
        state.update_progress(128, Some(1024));
        sessions()
            .lock()
            .expect("sessions")
            .insert(task_id.to_owned(), state);

        assert_eq!(
            transfer_progress(task_id),
            Some(MobileTransferProgress {
                downloaded_bytes: 128,
                total_bytes: 1024,
            })
        );

        sessions().lock().expect("sessions").remove(task_id);
        forget_transfer_progress(task_id);
    }
}
