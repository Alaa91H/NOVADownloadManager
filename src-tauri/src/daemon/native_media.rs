use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use nova_download_core::{
    discard_http_download_artifacts, download_http_to_path_segmented_controlled_with_context,
    HttpRequestContext, TransferControl, TransportError,
};
use nova_media_core::{
    processing::{
        mux_demuxers_to_mp4_controlled, MediaDemuxer, MediaProcessingControl,
        MediaProcessingError, Mp4Demuxer,
    },
    resolve_youtube_pending_formats, select_youtube_download_plan, youtube_video_id,
    ExtractRequest, MediaDescriptor, MediaProtocol, MediaStream, YouTubeDownloadPlan,
    YouTubeExtractor, YouTubePlayerScriptSolver, YouTubeSelectionPolicy,
};
use serde_json::Value;

use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};
use crate::daemon::state::SharedState;
use crate::daemon::types::{
    transition_task_state, CreateDownloadBody, MediaDownloadOptions, NativeMediaJob, Task,
    TaskState,
};
use crate::lock_or_err;
use uuid::Uuid;

pub struct NativeMediaExtractor;

/// Media options that are executed by the first-party native task path today.
/// Keep this list intentionally narrow: capability advertisement and request
/// validation both consume it so unsupported options cannot be silently ignored.
pub const NATIVE_MEDIA_OPTION_KEYS: &[&str] = &[
    "mode",
    "quality",
    "outputTemplate",
    "cookies",
    "userAgent",
    "referer",
    "headers",
];

impl Extractor for NativeMediaExtractor {
    fn id(&self) -> &'static str {
        "nova-media-engine"
    }

    fn can_handle(&self, url: &str, has_media_options: bool) -> bool {
        has_media_options
            && (url.starts_with("http://") || url.starts_with("https://"))
    }

    fn validate(&self, body: &CreateDownloadBody) -> Result<(), ValidateError> {
        let url = body.url.as_deref().unwrap_or("").trim();
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| ValidateError("Invalid media URL".to_owned()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ValidateError("Native media requires HTTP(S)".to_owned()));
        }

        let options = body
            .media_options
            .as_ref()
            .ok_or_else(|| ValidateError("Missing media options".to_owned()))?;
        validate_native_options(options).map_err(ValidateError)
    }

    fn allow_validation_fallback(&self) -> bool {
        false
    }

    fn engine_status(&self, _state: &SharedState) -> EngineStatus {
        EngineStatus {
            id: "nova-media-engine".to_owned(),
            name: "NOVA Media Engine".to_owned(),
            available: true,
            version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            features: vec![
                "native-resolution".to_owned(),
                "native-format-selection".to_owned(),
                "direct-media-handoff".to_owned(),
                "request-context".to_owned(),
            ],
        }
    }
}

#[derive(Debug)]
pub enum NativeMediaTaskError {
    Worker(String),
    InvalidRequest(String),
    Resolution(String),
    UnsupportedFeature(String),
    Transfer(String),
}

impl std::fmt::Display for NativeMediaTaskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Worker(message) => write!(f, "native media worker failed: {message}"),
            Self::InvalidRequest(message) => write!(f, "invalid native media request: {message}"),
            Self::Resolution(message) => write!(f, "native media resolution failed: {message}"),
            Self::UnsupportedFeature(message) => {
                write!(f, "native media feature is not supported yet: {message}")
            }
            Self::Transfer(message) => write!(f, "native media transfer failed: {message}"),
        }
    }
}

impl std::error::Error for NativeMediaTaskError {}

#[derive(Clone, Debug)]
struct ResolvedDirectMedia {
    url: String,
    title: String,
    container: Option<String>,
    content_length: Option<u64>,
    context: HttpRequestContext,
}

#[derive(Clone, Debug)]
struct ResolvedTrackTransfer {
    url: String,
    content_length: Option<u64>,
    context: HttpRequestContext,
}

#[derive(Clone, Debug)]
struct ResolvedSeparateMedia {
    title: String,
    video: ResolvedTrackTransfer,
    audio: ResolvedTrackTransfer,
}

#[derive(Clone, Debug)]
enum ResolvedNativeExecution {
    Direct(ResolvedDirectMedia),
    Separate(ResolvedSeparateMedia),
}

pub async fn create_native_media_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, NativeMediaTaskError> {
    let owned = body.clone();
    let resolved = tokio::task::spawn_blocking(move || resolve_native_execution(&owned))
        .await
        .map_err(|error| NativeMediaTaskError::Worker(error.to_string()))??;

    match resolved {
        ResolvedNativeExecution::Direct(resolved) => {
            let mut direct = body.clone();
            direct.url = Some(resolved.url);
            direct.media_options = None;
            if direct.name.as_deref().map_or(true, |name| name.trim().is_empty()) {
                direct.name = Some(resolved.title);
            }
            if direct.file_type.as_deref().map_or(true, |kind| kind.trim().is_empty()) {
                direct.file_type = resolved.container;
            }
            if direct.size_bytes.unwrap_or(0) == 0 {
                direct.size_bytes = resolved.content_length;
            }

            let mut options = direct.direct_options.take().unwrap_or_default();
            if let Some(user_agent) = resolved.context.user_agent {
                options.insert("userAgent".to_owned(), Value::String(user_agent));
            }
            if let Some(referer) = resolved.context.referer {
                direct.referer = Some(referer.clone());
                options.insert("referer".to_owned(), Value::String(referer));
            }
            if let Some(cookies) = resolved.context.cookie_header {
                options.insert("cookies".to_owned(), Value::String(cookies));
            }
            if !resolved.context.headers.is_empty() {
                let headers = resolved
                    .context
                    .headers
                    .into_iter()
                    .map(|(name, value)| format!("{name}: {value}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                options.insert("headers".to_owned(), Value::String(headers));
            }
            direct.direct_options = Some(options);

            log::info!(
                "NOVA Media Engine resolved media to native direct transport: {}",
                direct.url.as_deref().unwrap_or_default()
            );
            crate::daemon::curl::create_curl_task(state, &direct)
                .await
                .map_err(NativeMediaTaskError::Transfer)
        }
        ResolvedNativeExecution::Separate(resolved) => {
            create_native_separate_task(state, body, &resolved)
        }
    }
}

fn create_native_separate_task(
    state: &SharedState,
    body: &CreateDownloadBody,
    resolved: &ResolvedSeparateMedia,
) -> Result<Task, NativeMediaTaskError> {
    let mut normalized = body.clone();
    if normalized.name.as_deref().map_or(true, |name| name.trim().is_empty()) {
        normalized.name = Some(format!("{}.mp4", resolved.title));
    }
    normalized.file_type = Some("video".to_owned());
    normalized.size_bytes = match (
        resolved.video.content_length,
        resolved.audio.content_length,
    ) {
        (Some(video), Some(audio)) => video.checked_add(audio),
        _ => None,
    };

    let (name, output_path) =
        crate::daemon::curl::destination_from_body(&normalized, body.url.as_deref().unwrap_or(""));
    crate::daemon::direct::FileWriter::ensure_parent(&output_path)
        .map_err(NativeMediaTaskError::Transfer)?;

    let id = Uuid::new_v4().to_string();
    let connections = body.connections.unwrap_or(4).clamp(1, 128);
    let size_bytes = normalized.size_bytes.unwrap_or(0);
    let task = Task {
        id: id.clone(),
        name,
        url: body.url.clone().unwrap_or_default(),
        file_type: "video".to_owned(),
        status: TaskState::Queued.as_status().to_owned(),
        size_bytes,
        downloaded_bytes: native_staged_bytes(&output_path),
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: chrono::Utc::now().to_rfc3339(),
        category: body.category.clone().unwrap_or_else(|| "video".to_owned()),
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_owned()),
        connections,
        resumable: true,
        save_path: output_path.to_string_lossy().to_string(),
        description: body.description.clone().unwrap_or_else(|| {
            "Native multi-track media download and MP4 mux".to_owned()
        }),
        segments: crate::daemon::utils::build_segments(
            connections,
            size_bytes,
            native_staged_bytes(&output_path),
            0,
        ),
        referer: body.referer.clone(),
        engine: "nova-media-engine".to_owned(),
        engine_id: id.clone(),
        engine_status: Some("queued".to_owned()),
        error_message: None,
    };

    let job = NativeMediaJob {
        task: task.clone(),
        request: body.clone(),
        cancel_token: Arc::new(AtomicBool::new(false)),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
    };

    {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        let mut snapshot = lock_or_err!(state.task_snapshot);
        if snapshot.len() >= 10_000 {
            return Err(NativeMediaTaskError::Transfer(
                "Maximum number of tasks reached".to_owned(),
            ));
        }
        jobs.insert(id.clone(), job);
        snapshot.insert(id.clone(), task.clone());
    }
    state.mark_dirty();

    if body.start_immediately.unwrap_or(true) {
        start_native_media_process(state, &id);
    }
    Ok(task)
}

fn native_staging_paths(destination: &Path) -> (PathBuf, PathBuf) {
    (
        append_suffix(destination, ".nova-video.part"),
        append_suffix(destination, ".nova-audio.part"),
    )
}

fn native_staged_bytes(destination: &Path) -> u64 {
    let (video, audio) = native_staging_paths(destination);
    [video, audio]
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok().map(|meta| meta.len()))
        .sum()
}

pub fn discard_native_media_staging(destination: &Path) {
    let (video, audio) = native_staging_paths(destination);
    discard_http_download_artifacts(&video);
    discard_http_download_artifacts(&audio);
    let _ = std::fs::remove_file(append_suffix(destination, ".nova-mp4.tmp"));
}

pub fn discard_native_media_task_artifacts(destination: &Path, delete_final: bool) {
    discard_native_media_staging(destination);
    if delete_final {
        let _ = std::fs::remove_file(destination);
    }
}

pub fn start_native_media_process(state: &SharedState, id: &str) {
    let (request, destination, connections, token, generation, task) = {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        let Some(job) = jobs.get_mut(id) else { return; };
        let Some(current) = TaskState::from_status(&job.task.status) else { return; };
        if current == TaskState::Completed
            || (job.run_generation.load(Ordering::Acquire) > 0 && current.is_active())
        {
            return;
        }
        job.cancel_token = Arc::new(AtomicBool::new(false));
        let generation = job
            .run_generation
            .fetch_add(1, Ordering::Release)
            .saturating_add(1);
        if transition_task_state(&mut job.task, TaskState::Preparing, "resolving-media").is_err() {
            return;
        }
        job.task.error_message = None;
        job.start_time = Instant::now();
        (
            job.request.clone(),
            PathBuf::from(&job.task.save_path),
            job.task.connections.max(1),
            job.cancel_token.clone(),
            generation,
            job.task.clone(),
        )
    };
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
    state.priority_queue.start_download();

    let state = state.clone();
    let id = id.to_owned();
    std::thread::spawn(move || {
        if !native_transition(&state, &id, generation, TaskState::Downloading, "downloading-tracks") {
            return;
        }

        let execution = match resolve_native_execution(&request) {
            Ok(value) => value,
            Err(error) => {
                mark_native_media_failed(&state, &id, generation, error.to_string(), false);
                return;
            }
        };

        let result = match execution {
            ResolvedNativeExecution::Direct(direct) => {
                let progress_state = state.clone();
                let progress_id = id.clone();
                download_http_to_path_segmented_controlled_with_context(
                    &direct.url,
                    &destination,
                    connections,
                    &direct.context,
                    || {
                        if token.load(Ordering::Acquire) {
                            TransferControl::Pause
                        } else {
                            TransferControl::Continue
                        }
                    },
                    move |downloaded, total| {
                        update_native_media_progress(
                            &progress_state,
                            &progress_id,
                            generation,
                            downloaded,
                            total,
                        );
                    },
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            }
            ResolvedNativeExecution::Separate(separate) => {
                run_native_separate_transfer(
                    &state,
                    &id,
                    generation,
                    &destination,
                    connections,
                    &token,
                    separate,
                )
            }
        };

        if let Err(message) = result {
            let cancelled = token.load(Ordering::Acquire)
                || message.contains("paused")
                || message.contains("cancelled");
            mark_native_media_failed(&state, &id, generation, message, cancelled);
            return;
        }

        let final_size = std::fs::metadata(&destination).map(|m| m.len()).unwrap_or(0);
        if final_size == 0 {
            mark_native_media_failed(
                &state,
                &id,
                generation,
                "native media output is empty".to_owned(),
                false,
            );
            return;
        }
        mark_native_media_completed(&state, &id, generation, final_size);
    });
}

fn run_native_separate_transfer(
    state: &SharedState,
    id: &str,
    generation: u64,
    destination: &Path,
    connections: u32,
    token: &Arc<AtomicBool>,
    separate: ResolvedSeparateMedia,
) -> Result<(), String> {
    let (video_path, audio_path) = native_staging_paths(destination);
    let video_downloaded = Arc::new(AtomicU64::new(
        std::fs::metadata(&video_path).map(|m| m.len()).unwrap_or(0),
    ));
    let audio_downloaded = Arc::new(AtomicU64::new(
        std::fs::metadata(&audio_path).map(|m| m.len()).unwrap_or(0),
    ));
    let video_total = Arc::new(AtomicU64::new(separate.video.content_length.unwrap_or(0)));
    let audio_total = Arc::new(AtomicU64::new(separate.audio.content_length.unwrap_or(0)));

    let per_track_connections = (connections.max(2) + 1) / 2;
    let transfer_results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for (track, path, downloaded, total) in [
            (&separate.video, &video_path, &video_downloaded, &video_total),
            (&separate.audio, &audio_path, &audio_downloaded, &audio_total),
        ] {
            let state = state.clone();
            let id = id.to_owned();
            let token = token.clone();
            let other_downloaded = if Arc::ptr_eq(downloaded, &video_downloaded) {
                audio_downloaded.clone()
            } else {
                video_downloaded.clone()
            };
            let other_total = if Arc::ptr_eq(total, &video_total) {
                audio_total.clone()
            } else {
                video_total.clone()
            };
            handles.push(scope.spawn(move || {
                download_http_to_path_segmented_controlled_with_context(
                    &track.url,
                    path,
                    per_track_connections,
                    &track.context,
                    || {
                        if token.load(Ordering::Acquire) {
                            TransferControl::Pause
                        } else {
                            TransferControl::Continue
                        }
                    },
                    |bytes, discovered_total| {
                        downloaded.store(bytes, Ordering::Release);
                        if let Some(value) = discovered_total {
                            total.store(value, Ordering::Release);
                        }
                        let aggregate = bytes.saturating_add(other_downloaded.load(Ordering::Acquire));
                        let own_total = total.load(Ordering::Acquire);
                        let other_total = other_total.load(Ordering::Acquire);
                        let aggregate_total = (own_total > 0 && other_total > 0)
                            .then_some(own_total.saturating_add(other_total));
                        update_native_media_progress(
                            &state,
                            &id,
                            generation,
                            aggregate,
                            aggregate_total,
                        );
                    },
                )
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().map_err(|_| "native media transfer worker panicked".to_owned()))
            .collect::<Vec<_>>()
    });

    for result in transfer_results {
        result?.map_err(|error| error.to_string())?;
    }

    if token.load(Ordering::Acquire) {
        return Err("native transfer paused".to_owned());
    }
    if !native_transition(state, id, generation, TaskState::Verifying, "verifying-tracks") {
        return Err("native task generation changed during verification".to_owned());
    }

    let mut video = Mp4Demuxer::open(&video_path).map_err(|error| error.to_string())?;
    let mut audio = Mp4Demuxer::open(&audio_path).map_err(|error| error.to_string())?;

    if !native_transition(state, id, generation, TaskState::Finalizing, "muxing-mp4") {
        return Err("native task generation changed during finalization".to_owned());
    }

    let mut inputs: [&mut dyn MediaDemuxer; 2] = [&mut video, &mut audio];
    mux_demuxers_to_mp4_controlled(
        destination,
        &mut inputs,
        || {
            if token.load(Ordering::Acquire) {
                MediaProcessingControl::Pause
            } else {
                MediaProcessingControl::Continue
            }
        },
        |_| {},
    )
    .map_err(|error| error.to_string())?;

    discard_native_media_staging(destination);
    Ok(())
}

fn native_transition(
    state: &SharedState,
    id: &str,
    generation: u64,
    next: TaskState,
    engine_status: &str,
) -> bool {
    let task = {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        let Some(job) = jobs.get_mut(id) else { return false; };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return false;
        }
        if transition_task_state(&mut job.task, next, engine_status).is_err() {
            return false;
        }
        job.task.clone()
    };
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
    true
}

fn update_native_media_progress(
    state: &SharedState,
    id: &str,
    generation: u64,
    downloaded: u64,
    total: Option<u64>,
) {
    let task = {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        let Some(job) = jobs.get_mut(id) else { return; };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        job.task.downloaded_bytes = downloaded;
        if let Some(total) = total {
            job.task.size_bytes = total.max(downloaded);
        }
        let elapsed = job.start_time.elapsed().as_secs().max(1);
        job.task.elapsed_seconds = elapsed;
        job.task.speed_bytes_per_sec = downloaded / elapsed;
        job.task.time_left_seconds = if job.task.speed_bytes_per_sec > 0
            && job.task.size_bytes > downloaded
        {
            (job.task.size_bytes - downloaded) / job.task.speed_bytes_per_sec
        } else {
            0
        };
        job.task.clone()
    };
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
}

fn mark_native_media_failed(
    state: &SharedState,
    id: &str,
    generation: u64,
    message: String,
    cancelled: bool,
) {
    let task = {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        let Some(job) = jobs.get_mut(id) else { return; };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let next = if cancelled { TaskState::Paused } else { TaskState::Failed };
        let status = if cancelled { "paused" } else { "failed" };
        if transition_task_state(&mut job.task, next, status).is_err() {
            return;
        }
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.error_message = (!cancelled).then_some(message);
        job.task.clone()
    };
    if cancelled {
        state.priority_queue.release_active_slot();
    } else {
        state.priority_queue.stop_download(id);
        if let Ok(mut stats) = state.download_stats.lock() {
            stats.total_failed += 1;
        }
    }
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
    crate::daemon::persist::save_now(state.as_ref());
}

fn mark_native_media_completed(
    state: &SharedState,
    id: &str,
    generation: u64,
    final_size: u64,
) {
    let task = {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        let Some(job) = jobs.get_mut(id) else { return; };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let current = TaskState::from_status(&job.task.status);
        if current != Some(TaskState::Finalizing) && current != Some(TaskState::Downloading) {
            return;
        }
        if current == Some(TaskState::Downloading) {
            if transition_task_state(&mut job.task, TaskState::Verifying, "verifying-output").is_err()
                || transition_task_state(&mut job.task, TaskState::Finalizing, "finalizing-output").is_err()
            {
                return;
            }
        }
        if transition_task_state(&mut job.task, TaskState::Completed, "completed").is_err() {
            return;
        }
        job.task.size_bytes = final_size;
        job.task.downloaded_bytes = final_size;
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.error_message = None;
        job.task.clone()
    };
    state.priority_queue.stop_download(id);
    if let Ok(mut stats) = state.download_stats.lock() {
        stats.total_completed += 1;
        stats.total_downloaded_bytes += final_size;
    }
    lock_or_err!(state.task_snapshot).insert(id.to_owned(), task);
    state.mark_dirty();
    crate::daemon::persist::save_now(state.as_ref());
}

fn validate_native_options(options: &MediaDownloadOptions) -> Result<(), String> {
    let mode = options.mode.as_deref().unwrap_or("video").trim().to_ascii_lowercase();
    if !matches!(mode.as_str(), "video" | "best" | "auto") {
        return Err(format!(
            "Native media mode '{mode}' is not migrated yet"
        ));
    }

    if let Some(template) = options.output_template.as_deref().map(str::trim) {
        if !template.is_empty() && template != "%(title)s.%(ext)s" {
            return Err("Custom media output templates are not migrated yet".to_owned());
        }
    }

    if let Some(cookies) = options.cookies.as_deref().map(str::trim) {
        if !cookies.is_empty() && (!cookies.contains('=') || cookies.ends_with(".txt")) {
            return Err("Cookie-file loading is not migrated to the native engine yet".to_owned());
        }
    }

    let serialized = serde_json::to_value(options)
        .map_err(|error| format!("Could not inspect media options: {error}"))?;
    let object = serialized
        .as_object()
        .ok_or_else(|| "Invalid media options".to_owned())?;
    for (key, value) in object {
        if option_is_configured(value) && !NATIVE_MEDIA_OPTION_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "Media option '{key}' is not migrated to the native engine yet"
            ));
        }
    }

    Ok(())
}

fn option_is_configured(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.trim().is_empty(),
        Value::Number(value) => value.as_u64().map_or(true, |number| number != 0),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

fn resolve_native_execution(
    body: &CreateDownloadBody,
) -> Result<ResolvedNativeExecution, NativeMediaTaskError> {
    let request = build_extract_request(body)?;
    let parsed = request
        .parsed_url()
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
    let max_height = body
        .media_options
        .as_ref()
        .and_then(|options| options.quality.as_deref())
        .and_then(parse_quality_height);

    if youtube_video_id(&parsed).is_some() {
        let extractor = YouTubeExtractor;
        let mut extraction = extractor
            .extract_native(&request)
            .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;

        if !extraction.pending_formats.is_empty() {
            if let Ok(context) = request.request_context() {
                let solver = YouTubePlayerScriptSolver;
                let _ = resolve_youtube_pending_formats(&mut extraction, &context, &solver);
            }
        }

        let preferred = select_youtube_download_plan(
            &extraction,
            YouTubeSelectionPolicy {
                max_height,
                prefer_separate_tracks: true,
            },
        )
        .ok_or_else(|| {
            NativeMediaTaskError::UnsupportedFeature(
                "no native-ready media stream was found after challenge resolution".to_owned(),
            )
        })?;

        if let YouTubeDownloadPlan::SeparateTracks {
            video_stream_id,
            audio_stream_id,
        } = &preferred
        {
            let video = find_descriptor_stream(&extraction.descriptor, video_stream_id)?;
            let audio = find_descriptor_stream(&extraction.descriptor, audio_stream_id)?;
            if stream_is_mp4_muxable(video) && stream_is_mp4_muxable(audio) {
                return Ok(ResolvedNativeExecution::Separate(ResolvedSeparateMedia {
                    title: extraction.descriptor.metadata.title.clone(),
                    video: resolved_track_from_descriptor(&extraction.descriptor, video)?,
                    audio: resolved_track_from_descriptor(&extraction.descriptor, audio)?,
                }));
            }
        }

        let fallback = select_youtube_download_plan(
            &extraction,
            YouTubeSelectionPolicy {
                max_height,
                prefer_separate_tracks: false,
            },
        )
        .ok_or_else(|| {
            NativeMediaTaskError::UnsupportedFeature(
                "no MP4-muxable or combined native media stream is available".to_owned(),
            )
        })?;

        return match fallback {
            YouTubeDownloadPlan::SingleStream { stream_id } => {
                let stream = find_descriptor_stream(&extraction.descriptor, &stream_id)?;
                resolved_direct_from_descriptor(&extraction.descriptor, stream)
                    .map(ResolvedNativeExecution::Direct)
            }
            YouTubeDownloadPlan::SeparateTracks { .. } => Err(
                NativeMediaTaskError::UnsupportedFeature(
                    "the selected separate tracks require a container muxer not implemented yet"
                        .to_owned(),
                ),
            ),
        };
    }

    let registry = nova_media_core::ExtractorRegistry::with_native_defaults();
    let descriptor = registry
        .resolve(&request)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let stream = descriptor
        .playable_streams()
        .filter(|stream| matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https))
        .max_by_key(|stream| {
            (
                stream.height.unwrap_or(0),
                stream.bitrate_bps.unwrap_or(0),
                stream.content_length.unwrap_or(0),
            )
        })
        .ok_or_else(|| {
            NativeMediaTaskError::UnsupportedFeature(
                "the selected result requires HLS/DASH task execution".to_owned(),
            )
        })?;

    resolved_direct_from_descriptor(&descriptor, stream).map(ResolvedNativeExecution::Direct)
}

fn find_descriptor_stream<'a>(
    descriptor: &'a MediaDescriptor,
    stream_id: &str,
) -> Result<&'a MediaStream, NativeMediaTaskError> {
    descriptor
        .streams
        .iter()
        .find(|stream| stream.id == stream_id)
        .ok_or_else(|| {
            NativeMediaTaskError::Resolution(
                "selected native media stream disappeared".to_owned(),
            )
        })
}

fn stream_is_mp4_muxable(stream: &MediaStream) -> bool {
    matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https)
        && stream
            .container
            .as_deref()
            .is_some_and(|container| {
                matches!(
                    container.trim().to_ascii_lowercase().as_str(),
                    "mp4" | "m4a" | "m4v" | "mov"
                )
            })
}

fn resolved_track_from_descriptor(
    descriptor: &MediaDescriptor,
    stream: &MediaStream,
) -> Result<ResolvedTrackTransfer, NativeMediaTaskError> {
    if !matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https) {
        return Err(NativeMediaTaskError::UnsupportedFeature(
            "selected track requires manifest task execution".to_owned(),
        ));
    }
    let context = descriptor
        .request_context_for_stream(stream)
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
    Ok(ResolvedTrackTransfer {
        url: stream.url.clone(),
        content_length: stream.content_length,
        context,
    })
}

fn resolved_direct_from_descriptor(
    descriptor: &MediaDescriptor,
    stream: &MediaStream,
) -> Result<ResolvedDirectMedia, NativeMediaTaskError> {
    if !matches!(stream.protocol, MediaProtocol::Http | MediaProtocol::Https) {
        return Err(NativeMediaTaskError::UnsupportedFeature(
            "selected stream requires manifest task execution".to_owned(),
        ));
    }

    let context = descriptor
        .request_context_for_stream(stream)
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
    Ok(ResolvedDirectMedia {
        url: stream.url.clone(),
        title: descriptor.metadata.title.clone(),
        container: stream.container.clone(),
        content_length: stream.content_length,
        context,
    })
}

fn build_extract_request(
    body: &CreateDownloadBody,
) -> Result<ExtractRequest, NativeMediaTaskError> {
    let url = body.url.as_deref().unwrap_or_default().trim();
    if url.is_empty() {
        return Err(NativeMediaTaskError::InvalidRequest(
            "missing media URL".to_owned(),
        ));
    }

    let mut request = ExtractRequest::new(url);
    if let Some(referer) = body.referer.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        request.headers.insert("Referer".to_owned(), referer.to_owned());
    }

    if let Some(options) = body.media_options.as_ref() {
        if let Some(user_agent) = options
            .user_agent
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request
                .headers
                .insert("User-Agent".to_owned(), user_agent.to_owned());
        }
        if let Some(referer) = options
            .referer
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request.headers.insert("Referer".to_owned(), referer.to_owned());
        }
        if let Some(cookies) = options
            .cookies
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request.headers.insert("Cookie".to_owned(), cookies.to_owned());
        }
        if let Some(headers) = options
            .headers
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            parse_header_lines(&mut request.headers, headers)
                .map_err(NativeMediaTaskError::InvalidRequest)?;
        }
    }

    request
        .request_context()
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
    Ok(request)
}

fn parse_header_lines(
    target: &mut BTreeMap<String, String>,
    headers: &str,
) -> Result<(), String> {
    for line in headers.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("Invalid media header line: {line}"))?;
        if name.trim().is_empty() || value.trim().is_empty() {
            return Err(format!("Invalid media header line: {line}"));
        }
        target.insert(name.trim().to_owned(), value.trim().to_owned());
    }
    Ok(())
}

fn parse_quality_height(value: &str) -> Option<u32> {
    let normalized = value.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "" | "best" | "auto") {
        return None;
    }
    match normalized.as_str() {
        "4k" => Some(2160),
        "2k" => Some(1440),
        _ => normalized
            .trim_end_matches('p')
            .parse::<u32>()
            .ok()
            .filter(|height| *height >= 144),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(url: &str) -> CreateDownloadBody {
        CreateDownloadBody {
            url: Some(url.to_owned()),
            name: None,
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: Some(4),
            resumable: Some(true),
            save_path: None,
            description: None,
            referer: None,
            start_immediately: Some(false),
            direct_options: None,
            media_options: Some(MediaDownloadOptions {
                mode: Some("video".to_owned()),
                quality: Some("1080p".to_owned()),
                output_template: Some("%(title)s.%(ext)s".to_owned()),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn standard_video_options_use_native_path() {
        let body = body("https://cdn.test/video.mp4");
        NativeMediaExtractor
            .validate(&body)
            .expect("standard native options");
    }

    #[test]
    fn advanced_media_option_is_rejected_by_native_engine() {
        let mut body = body("https://cdn.test/video.mp4");
        body.media_options.as_mut().expect("media").subtitles = Some(true);
        assert!(NativeMediaExtractor.validate(&body).is_err());
    }

    #[test]
    fn unimplemented_execution_option_is_not_advertised_or_accepted() {
        assert!(!NATIVE_MEDIA_OPTION_KEYS.contains(&"audioFormat"));
        let mut body = body("https://cdn.test/video.mp4");
        body.media_options.as_mut().expect("media").audio_format = Some("m4a".to_owned());
        assert!(NativeMediaExtractor.validate(&body).is_err());
    }

    #[test]
    fn generic_direct_media_resolves_without_network_probe() {
        let resolved = resolve_native_direct(&body("https://cdn.test/movie.mp4"))
            .expect("native direct resolution");
        assert_eq!(resolved.url, "https://cdn.test/movie.mp4");
        assert_eq!(resolved.container.as_deref(), Some("mp4"));
    }

    #[test]
    fn parses_common_quality_limits() {
        assert_eq!(parse_quality_height("1080p"), Some(1080));
        assert_eq!(parse_quality_height("4k"), Some(2160));
        assert_eq!(parse_quality_height("best"), None);
    }
}
