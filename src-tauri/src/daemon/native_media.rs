use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use nova_download_core::{fetch_http_bytes_with_context, HttpRequestContext, TransferControl};
use nova_media_core::{
    assemble_ordered_parts, download_youtube_plan_controlled, mux_mp4_tracks_controlled,
    resolve_youtube_pending_formats, select_youtube_download_plan,
    stage_dash_representation_plan_controlled_with_progress_scoped,
    stage_hls_media_plan_controlled_with_progress_scoped, youtube_video_id, ExtractRequest,
    select_media_stream, MediaChapter, MediaDescriptor, MediaProtocol, MediaSelectionMode,
    MediaSelectionPolicy, MediaSortKey, MediaStream, NativeMuxError, YouTubeDownloadPlan,
    YouTubeExtraction,
    YouTubeExtractor, YouTubePlayerScriptSolver, YouTubeSelectionPolicy, YouTubeTransferOutput,
    YouTubeTransferProgress, DEFAULT_MANIFEST_MAX_BYTES,
};
use nova_stream_core::{
    build_dash_live_refresh, build_dash_representation_plan, build_hls_live_refresh,
    build_hls_media_plan, parse_dash, parse_hls, select_best_hls_variant, DashLiveCursor,
    DashManifest, HlsLiveCursor, HlsPlaylistKind, HlsTransferUnitKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::daemon::browser_cookies::{
    load_browser_cookie_header, validate_browser_cookie_source,
};
use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};
use crate::daemon::engine::priority_queue::{DownloadPriority, QueueEntry};
use crate::daemon::postprocess::{
    FfmpegPostProcessor, MediaMuxRequest, MediaPostProcessor, MediaSubtitleEmbedRequest,
    MediaSubtitleInput, PostProcessError, MEDIA_SUBTITLE_EMBED_OPTION,
};
use crate::daemon::state::SharedState;
use crate::daemon::types::{
    transition_task_state, CreateDownloadBody, MediaDownloadOptions, NativeMediaJob, Segment,
    Task, TaskState,
};

pub struct NativeMediaExtractor;

/// Media options that are executed by the first-party native task path today.
/// Keep this list intentionally narrow: capability advertisement and request
/// validation both consume it so unsupported options cannot be silently ignored.
pub const NATIVE_MEDIA_OPTION_KEYS: &[&str] = &[
    "mode",
    "quality",
    "formatSelector",
    "formatSort",
    "audioFormat",
    "subtitles",
    "subtitleLanguages",
    "autoSubtitles",
    "embedSubtitles",
    "writeThumbnail",
    "writeInfoJson",
    "writeDescription",
    "remuxFormat",
    "ffmpegEnabled",
    "outputTemplate",
    "cookies",
    "cookiesFromBrowser",
    "userAgent",
    "referer",
    "headers",
];

const NATIVE_COOKIE_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;

impl Extractor for NativeMediaExtractor {
    fn id(&self) -> &'static str {
        "nova-media-engine"
    }

    fn can_handle(&self, url: &str, has_media_options: bool) -> bool {
        let http = url
            .split_once(':')
            .map_or("", |(scheme, _)| scheme)
            .eq_ignore_ascii_case("http")
            || url
                .split_once(':')
                .map_or("", |(scheme, _)| scheme)
                .eq_ignore_ascii_case("https");
        http && (has_media_options || is_native_manifest_url(url))
    }

    fn validate(&self, body: &CreateDownloadBody) -> Result<(), ValidateError> {
        let url = body.url.as_deref().unwrap_or("").trim();
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| ValidateError("Invalid media URL".to_owned()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(ValidateError("Native media requires HTTP(S)".to_owned()));
        }

        if let Some(options) = body.media_options.as_ref() {
            validate_native_options(options).map_err(ValidateError)?;
        } else if !is_native_manifest_url(url) {
            return Err(ValidateError("Missing media options".to_owned()));
        }
        Ok(())
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
                "hls-vod-task".to_owned(),
                "hls-live-task".to_owned(),
                "dash-static-task".to_owned(),
                "dash-dynamic-task".to_owned(),
                "manifest-pause-resume".to_owned(),
                "parallel-av-staging".to_owned(),
                "postprocess-mux".to_owned(),
                "request-context".to_owned(),
                "cookie-file-auth".to_owned(),
                "browser-cookie-import-firefox".to_owned(),
                "direct-subtitle-embedding".to_owned(),
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

#[derive(Debug)]
struct ResolvedDirectMedia {
    url: String,
    title: String,
    container: Option<String>,
    content_length: Option<u64>,
    context: HttpRequestContext,
    descriptor: MediaDescriptor,
    chapters: Vec<MediaChapter>,
}

#[derive(Clone, Debug)]
struct ResolvedManifestMedia {
    descriptor: MediaDescriptor,
    stream: MediaStream,
    chapters: Vec<MediaChapter>,
}

#[derive(Clone, Debug)]
struct ResolvedSeparateTracks {
    extraction: YouTubeExtraction,
    video_stream_id: String,
    audio_stream_id: String,
    output_container: String,
    expected_bytes: Option<u64>,
}

#[derive(Debug)]
enum ResolvedNativeMedia {
    Direct(ResolvedDirectMedia),
    Manifest(ResolvedManifestMedia),
    SeparateTracks(ResolvedSeparateTracks),
}

fn native_mux_supports_container(container: &str) -> bool {
    nova_media_core::native_media_core_capabilities().native_mp4_multitrack_mux
        && container.eq_ignore_ascii_case("mp4")
}

fn separate_tracks_need_external_postprocessor(resolved: &ResolvedNativeMedia) -> bool {
    matches!(
        resolved,
        ResolvedNativeMedia::SeparateTracks(separate)
            if !native_mux_supports_container(&separate.output_container)
    )
}

#[derive(Debug)]
struct ManifestStageOutput {
    parts: Vec<(u64, PathBuf)>,
    staged_bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct HlsLiveTaskCheckpoint {
    cursor: HlsLiveCursor,
    next_order: u64,
    total_bytes: u64,
    last_init_identity: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct DashLiveTaskCheckpoint {
    cursor: DashLiveCursor,
    next_order: u64,
    total_bytes: u64,
}

pub async fn create_native_media_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, NativeMediaTaskError> {
    let owned = body.clone();
    let resolved = tokio::task::spawn_blocking(move || resolve_native_media(&owned))
        .await
        .map_err(|error| NativeMediaTaskError::Worker(error.to_string()))??;

    let wants_subtitle_embedding = body
        .media_options
        .as_ref()
        .and_then(|options| options.embed_subtitles)
        .unwrap_or(false);
    let needs_external_postprocessor =
        separate_tracks_need_external_postprocessor(&resolved) || wants_subtitle_embedding;
    if needs_external_postprocessor {
        let postprocessor = FfmpegPostProcessor::new(state.ffmpeg_binary());
        if !postprocessor.is_available() {
            return Err(NativeMediaTaskError::UnsupportedFeature(
                "the requested media operation requires the legacy host post-processor, but it is not available"
                    .to_owned(),
            ));
        }
    }
    if wants_subtitle_embedding && !matches!(resolved, ResolvedNativeMedia::Direct(_)) {
        return Err(NativeMediaTaskError::UnsupportedFeature(
            "subtitle embedding is currently enabled for native direct-media tasks; manifest and separate-track embedding is still migrating"
                .to_owned(),
        ));
    }

    match resolved {
        ResolvedNativeMedia::Direct(resolved) => {
            create_native_direct_task(state, body, resolved).await
        }
        ResolvedNativeMedia::Manifest(resolved) => {
            create_native_manifest_task(state, body, resolved)
        }
        ResolvedNativeMedia::SeparateTracks(resolved) => {
            create_native_separate_track_task(state, body, resolved)
        }
    }
}

async fn create_native_direct_task(
    state: &SharedState,
    body: &CreateDownloadBody,
    resolved: ResolvedDirectMedia,
) -> Result<Task, NativeMediaTaskError> {
    let descriptor = resolved.descriptor.clone();
    let chapters = resolved.chapters.clone();
    let container = resolved.container.clone();
    let mut direct = body.clone();
    direct.url = Some(resolved.url);
    direct.media_options = None;
    let base_name = direct
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            let title = resolved.title.trim();
            if title.is_empty() {
                "nova-media".to_owned()
            } else {
                title.to_owned()
            }
        });
    direct.name = Some(ensure_native_output_name(&base_name, container.as_deref()));
    if direct.file_type.as_deref().map_or(true, |kind| kind.trim().is_empty()) {
        direct.file_type = container;
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

    let source_url = direct.url.as_deref().unwrap_or_default();
    let (_, output_path) = crate::daemon::curl::destination_from_body(&direct, source_url);
    let sidecars = prepare_native_sidecars(body, &descriptor, &chapters, &output_path)?;
    if body
        .media_options
        .as_ref()
        .and_then(|options| options.embed_subtitles)
        .unwrap_or(false)
    {
        if sidecars.subtitles.is_empty() {
            return Err(NativeMediaTaskError::UnsupportedFeature(
                "subtitle embedding requested but no embeddable native subtitle was produced"
                    .to_owned(),
            ));
        }
        let cleanup_sidecars = body
            .media_options
            .as_ref()
            .is_some_and(|options| {
                options.subtitles != Some(true) && options.auto_subtitles != Some(true)
            });
        let request = MediaSubtitleEmbedRequest {
            source_path: output_path.clone(),
            subtitles: sidecars.subtitles,
            cleanup_sidecars,
        };
        let value = serde_json::to_value(request)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        direct
            .direct_options
            .get_or_insert_with(HashMap::new)
            .insert(MEDIA_SUBTITLE_EMBED_OPTION.to_owned(), value);
    }

    log::info!(
        "NOVA Media Engine resolved media to native direct transport: {}",
        direct.url.as_deref().unwrap_or_default()
    );
    crate::daemon::curl::create_curl_task(state, &direct)
        .await
        .map_err(NativeMediaTaskError::Transfer)
}

fn create_native_manifest_task(
    state: &SharedState,
    body: &CreateDownloadBody,
    resolved: ResolvedManifestMedia,
) -> Result<Task, NativeMediaTaskError> {
    let protocol = match resolved.stream.protocol {
        MediaProtocol::Hls => "hls",
        MediaProtocol::Dash => "dash",
        MediaProtocol::Http | MediaProtocol::Https => {
            return Err(NativeMediaTaskError::UnsupportedFeature(
                "manifest task creation received a direct stream".to_owned(),
            ));
        }
    };

    let extension = resolved
        .stream
        .container
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if protocol == "dash" { "mp4" } else { "ts" });
    let mut task_body = body.clone();
    let base_name = task_body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            let title = resolved.descriptor.metadata.title.trim();
            if title.is_empty() {
                format!("nova-{protocol}-media")
            } else {
                title.to_owned()
            }
        });
    task_body.name = Some(ensure_native_output_name(&base_name, Some(extension)));
    if task_body.file_type.as_deref().map_or(true, |kind| kind.trim().is_empty()) {
        task_body.file_type = Some(extension.to_owned());
    }

    let source_url = body.url.as_deref().unwrap_or_default();
    let (name, output_path) = crate::daemon::curl::destination_from_body(&task_body, source_url);
    if let Some(parent) = output_path.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }
    prepare_native_sidecars(
        body,
        &resolved.descriptor,
        &resolved.chapters,
        &output_path,
    )?;

    let id = Uuid::new_v4().to_string();
    let connections = crate::daemon::curl::requested_connections(body.connections);
    let task = Task {
        id: id.clone(),
        name,
        url: source_url.to_owned(),
        file_type: task_body.file_type.clone().unwrap_or_else(|| "video".to_owned()),
        status: if body.start_immediately.unwrap_or(true) {
            TaskState::Preparing.as_status()
        } else {
            TaskState::Queued.as_status()
        }
        .to_owned(),
        size_bytes: body.size_bytes.unwrap_or(0),
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: crate::daemon::utils::now_str(),
        category: body.category.clone().unwrap_or_else(|| "video".to_owned()),
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_owned()),
        connections,
        resumable: body.resumable.unwrap_or(true),
        save_path: output_path.to_string_lossy().to_string(),
        description: body
            .description
            .clone()
            .unwrap_or_else(|| format!("Native {} media transfer", protocol.to_ascii_uppercase())),
        segments: Vec::new(),
        referer: body.referer.clone(),
        engine: "nova-media-engine".to_owned(),
        engine_id: id.clone(),
        engine_status: Some(
            if body.start_immediately.unwrap_or(true) {
                "starting"
            } else {
                "queued"
            }
            .to_owned(),
        ),
        error_message: None,
    };
    let job = NativeMediaJob {
        task: task.clone(),
        request: body.clone(),
        protocol: protocol.to_owned(),
        cancel_token: Arc::new(AtomicBool::new(false)),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
    };

    {
        let mut jobs = state
            .native_media_jobs
            .lock()
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        let mut snapshot = state
            .task_snapshot
            .lock()
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        if snapshot.len() >= 10_000 {
            return Err(NativeMediaTaskError::Transfer(
                "Maximum number of tasks reached. Complete or delete some tasks before creating new ones."
                    .to_owned(),
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

fn create_native_separate_track_task(
    state: &SharedState,
    body: &CreateDownloadBody,
    resolved: ResolvedSeparateTracks,
) -> Result<Task, NativeMediaTaskError> {
    let video = resolved
        .extraction
        .descriptor
        .streams
        .iter()
        .find(|stream| stream.id == resolved.video_stream_id)
        .ok_or_else(|| {
            NativeMediaTaskError::Resolution(
                "selected native video track disappeared before task creation".to_owned(),
            )
        })?;
    let audio = resolved
        .extraction
        .descriptor
        .streams
        .iter()
        .find(|stream| stream.id == resolved.audio_stream_id)
        .ok_or_else(|| {
            NativeMediaTaskError::Resolution(
                "selected native audio track disappeared before task creation".to_owned(),
            )
        })?;

    let mut task_body = body.clone();
    let base_name = task_body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            let title = resolved.extraction.descriptor.metadata.title.trim();
            if title.is_empty() {
                "nova-media".to_owned()
            } else {
                title.to_owned()
            }
        });
    task_body.name = Some(ensure_native_output_name(
        &base_name,
        Some(&resolved.output_container),
    ));
    if task_body
        .file_type
        .as_deref()
        .map_or(true, |kind| kind.trim().is_empty())
    {
        task_body.file_type = Some(resolved.output_container.clone());
    }

    let source_url = body.url.as_deref().unwrap_or_default();
    let (name, output_path) =
        crate::daemon::curl::destination_from_body(&task_body, source_url);
    if let Some(parent) = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }
    prepare_native_sidecars(
        body,
        &resolved.extraction.descriptor,
        &resolved.extraction.chapters,
        &output_path,
    )?;

    let id = Uuid::new_v4().to_string();
    let connections = crate::daemon::curl::requested_connections(body.connections);
    let video_total = video.content_length.unwrap_or(0);
    let audio_total = audio.content_length.unwrap_or(0);
    let expected_bytes = resolved
        .expected_bytes
        .or_else(|| {
            (video_total > 0 && audio_total > 0)
                .then_some(video_total.saturating_add(audio_total))
        })
        .unwrap_or_else(|| body.size_bytes.unwrap_or(0));

    let segments = vec![
        Segment {
            id: 0,
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: video_total,
            active: false,
            speed: 0,
            start_byte: 0,
            end_byte: video_total.saturating_sub(1),
        },
        Segment {
            id: 1,
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: audio_total,
            active: false,
            speed: 0,
            start_byte: 0,
            end_byte: audio_total.saturating_sub(1),
        },
    ];

    let task = Task {
        id: id.clone(),
        name,
        url: source_url.to_owned(),
        file_type: task_body
            .file_type
            .clone()
            .unwrap_or_else(|| resolved.output_container.clone()),
        status: if body.start_immediately.unwrap_or(true) {
            TaskState::Preparing.as_status()
        } else {
            TaskState::Queued.as_status()
        }
        .to_owned(),
        size_bytes: expected_bytes,
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: crate::daemon::utils::now_str(),
        category: body.category.clone().unwrap_or_else(|| "video".to_owned()),
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_owned()),
        connections,
        resumable: body.resumable.unwrap_or(true),
        save_path: output_path.to_string_lossy().to_string(),
        description: body.description.clone().unwrap_or_else(|| {
            "Native separate audio/video download with NOVA post-processing".to_owned()
        }),
        segments,
        referer: body.referer.clone(),
        engine: "nova-media-engine".to_owned(),
        engine_id: id.clone(),
        engine_status: Some(
            if body.start_immediately.unwrap_or(true) {
                "starting"
            } else {
                "queued"
            }
            .to_owned(),
        ),
        error_message: None,
    };

    let job = NativeMediaJob {
        task: task.clone(),
        request: body.clone(),
        protocol: "separate-tracks".to_owned(),
        cancel_token: Arc::new(AtomicBool::new(false)),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
    };

    {
        let mut jobs = state
            .native_media_jobs
            .lock()
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        let mut snapshot = state
            .task_snapshot
            .lock()
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        if snapshot.len() >= 10_000 {
            return Err(NativeMediaTaskError::Transfer(
                "Maximum number of tasks reached. Complete or delete some tasks before creating new ones."
                    .to_owned(),
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

pub fn start_native_media_process(state: &SharedState, id: &str) {
    let prepared = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(error) => {
                log::error!("Native media jobs lock poisoned for {id}: {error}");
                return;
            }
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        let current = TaskState::from_status(&job.task.status);
        let worker_was_started = job.run_generation.load(Ordering::Acquire) > 0;
        if worker_was_started && current.is_some_and(TaskState::is_active) {
            log::debug!("Native media task {id} already has an active worker");
            return;
        }
        if current == Some(TaskState::Queued) {
            if let Err(error) =
                transition_task_state(&mut job.task, TaskState::Preparing, "starting")
            {
                log::error!("Native media task {id} could not start: {error}");
                return;
            }
        } else if current != Some(TaskState::Preparing) {
            log::warn!(
                "Native media task {id} cannot start from state {}",
                job.task.status
            );
            return;
        }
        job.cancel_token.store(false, Ordering::Release);
        let generation = job.run_generation.fetch_add(1, Ordering::AcqRel) + 1;
        job.start_time = Instant::now();
        Some((
            generation,
            job.cancel_token.clone(),
            job.run_generation.clone(),
            job.request.clone(),
            job.task.clone(),
            job.task.size_bytes,
        ))
    };

    let Some((generation, cancel_token, run_generation, request, task, size_bytes)) = prepared else {
        return;
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.priority_queue.enqueue(QueueEntry {
        task_id: id.to_owned(),
        priority: DownloadPriority::Normal,
        added_at: Instant::now(),
        size_bytes,
        bandwidth_kbps: Arc::new(AtomicU64::new(0)),
    });
    state.priority_queue.start_download();
    state.mark_dirty();

    let state = state.clone();
    let id = id.to_owned();
    std::thread::spawn(move || {
        run_native_media_worker(
            state,
            id,
            generation,
            cancel_token,
            run_generation,
            request,
        );
    });
}

fn handle_native_transition_error(
    state: &SharedState,
    id: &str,
    generation: u64,
    error: String,
    should_stop: bool,
) {
    if should_stop {
        finish_native_cancelled(state, id, generation);
    } else {
        fail_native_task(state, id, generation, error);
    }
}

fn run_native_media_worker(
    state: SharedState,
    id: String,
    generation: u64,
    cancel_token: Arc<AtomicBool>,
    run_generation: Arc<AtomicU64>,
    request: CreateDownloadBody,
) {
    let still_current = || run_generation.load(Ordering::Acquire) == generation;
    let paused_or_stale = || cancel_token.load(Ordering::Acquire) || !still_current();

    if paused_or_stale() {
        finish_native_cancelled(&state, &id, generation);
        return;
    }
    if let Err(error) =
        transition_native_task(&state, &id, generation, TaskState::Probing, "resolving-media")
    {
        handle_native_transition_error(
            &state,
            &id,
            generation,
            error,
            paused_or_stale(),
        );
        return;
    }

    let resolved = match resolve_native_media(&request) {
        Ok(resolved) => resolved,
        Err(error) => {
            fail_native_task(&state, &id, generation, error.to_string());
            return;
        }
    };

    if paused_or_stale() {
        finish_native_cancelled(&state, &id, generation);
        return;
    }
    if let Err(error) =
        transition_native_task(&state, &id, generation, TaskState::Downloading, "downloading")
    {
        handle_native_transition_error(
            &state,
            &id,
            generation,
            error,
            paused_or_stale(),
        );
        return;
    }

    let (output_path, connections) = match state.native_media_jobs.lock() {
        Ok(jobs) => match jobs.get(&id) {
            Some(job) => (
                PathBuf::from(&job.task.save_path),
                job.task.connections.max(1),
            ),
            None => return,
        },
        Err(_) => return,
    };
    let staging_dir = Path::new(&state.data_dir)
        .join("native-media")
        .join(&id)
        .join("working");

    match resolved {
        ResolvedNativeMedia::Manifest(resolved) => {
            let progress_state = state.clone();
            let progress_id = id.clone();
            let progress = |bytes: u64| {
                update_native_progress(&progress_state, &progress_id, generation, bytes);
            };

            let result = stage_manifest_transfer(
                &resolved,
                &staging_dir,
                connections,
                &paused_or_stale,
                &progress,
            );

            match result {
                Ok(staged) => {
                    if paused_or_stale() {
                        finish_native_cancelled(&state, &id, generation);
                        return;
                    }
                    update_native_progress(&state, &id, generation, staged.staged_bytes);
                    if let Err(error) = transition_native_task(
                        &state,
                        &id,
                        generation,
                        TaskState::Verifying,
                        "verifying-staged-media",
                    ) {
                        handle_native_transition_error(
                            &state,
                            &id,
                            generation,
                            error,
                            paused_or_stale(),
                        );
                        return;
                    }
                    if let Err(error) = verify_staged_parts(&staged.parts, staged.staged_bytes) {
                        fail_native_task(&state, &id, generation, error);
                        return;
                    }
                    if paused_or_stale() {
                        finish_native_cancelled(&state, &id, generation);
                        return;
                    }
                    if let Err(error) = transition_native_task(
                        &state,
                        &id,
                        generation,
                        TaskState::Finalizing,
                        "assembling-media",
                    ) {
                        handle_native_transition_error(
                            &state,
                            &id,
                            generation,
                            error,
                            paused_or_stale(),
                        );
                        return;
                    }
                    match assemble_ordered_parts(&staged.parts, &output_path) {
                        Ok(assembly) => {
                            if paused_or_stale() {
                                finish_native_cancelled(&state, &id, generation);
                                return;
                            }
                            if complete_native_task(&state, &id, generation, assembly.bytes) {
                                let _ = std::fs::remove_dir_all(&staging_dir);
                            }
                        }
                        Err(error) => {
                            fail_native_task(&state, &id, generation, error.to_string())
                        }
                    }
                }
                Err(_error) if paused_or_stale() => {
                    finish_native_cancelled(&state, &id, generation)
                }
                Err(error) => fail_native_task(&state, &id, generation, error.to_string()),
            }
        }
        ResolvedNativeMedia::SeparateTracks(resolved) => {
            run_native_separate_track_execution(
                &state,
                &id,
                generation,
                &cancel_token,
                &run_generation,
                resolved,
                &staging_dir,
                &output_path,
                connections,
            );
        }
        ResolvedNativeMedia::Direct(_) => {
            fail_native_task(
                &state,
                &id,
                generation,
                "media source changed to direct transport while resuming a native media task"
                    .to_owned(),
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_native_separate_track_execution(
    state: &SharedState,
    id: &str,
    generation: u64,
    cancel_token: &Arc<AtomicBool>,
    run_generation: &Arc<AtomicU64>,
    resolved: ResolvedSeparateTracks,
    staging_dir: &Path,
    output_path: &Path,
    connections: u32,
) {
    let use_native_mp4_mux = native_mux_supports_container(&resolved.output_container);
    if !use_native_mp4_mux {
        let postprocessor = FfmpegPostProcessor::new(state.ffmpeg_binary());
        if !postprocessor.is_available() {
            fail_native_task(
                state,
                id,
                generation,
                "The selected output container still requires the legacy host post-processor, and it is unavailable"
                    .to_owned(),
            );
            return;
        }
    }

    let control = || {
        if run_generation.load(Ordering::Acquire) != generation {
            TransferControl::Cancel
        } else if cancel_token.load(Ordering::Acquire) {
            TransferControl::Pause
        } else {
            TransferControl::Continue
        }
    };
    let should_cancel = || control() != TransferControl::Continue;

    let plan = YouTubeDownloadPlan::SeparateTracks {
        video_stream_id: resolved.video_stream_id.clone(),
        audio_stream_id: resolved.audio_stream_id.clone(),
    };
    let track_base = staging_dir.join("youtube-tracks");
    let progress_state = state.clone();
    let progress_id = id.to_owned();
    let transfer = download_youtube_plan_controlled(
        &resolved.extraction,
        &plan,
        &track_base,
        connections,
        || control(),
        |progress| {
            update_native_multitrack_progress(
                &progress_state,
                &progress_id,
                generation,
                progress,
            );
        },
    );

    let output = match transfer {
        Ok(YouTubeTransferOutput::SeparateTracks {
            video_path,
            audio_path,
            video_bytes,
            audio_bytes,
            ..
        }) => {
            update_native_multitrack_progress(
                state,
                id,
                generation,
                YouTubeTransferProgress {
                    video_downloaded: video_bytes,
                    video_total: Some(video_bytes),
                    audio_downloaded: audio_bytes,
                    audio_total: Some(audio_bytes),
                },
            );
            (video_path, audio_path, video_bytes, audio_bytes)
        }
        Ok(YouTubeTransferOutput::Single { .. }) => {
            fail_native_task(
                state,
                id,
                generation,
                "separate-track task unexpectedly produced a single stream".to_owned(),
            );
            return;
        }
        Err(_error) if should_cancel() => {
            finish_native_cancelled(state, id, generation);
            return;
        }
        Err(error) => {
            fail_native_task(state, id, generation, error.to_string());
            return;
        }
    };

    if let Err(error) = transition_native_task(
        state,
        id,
        generation,
        TaskState::Verifying,
        "verifying-audio-video-tracks",
    ) {
        handle_native_transition_error(
            state,
            id,
            generation,
            error,
            should_cancel(),
        );
        return;
    }
    if let Err(error) = verify_native_track(&output.0, output.2, "video")
        .and_then(|_| verify_native_track(&output.1, output.3, "audio"))
    {
        fail_native_task(state, id, generation, error);
        return;
    }
    set_native_track_activity(state, id, generation, false);

    if should_cancel() {
        finish_native_cancelled(state, id, generation);
        return;
    }
    if let Err(error) = transition_native_task(
        state,
        id,
        generation,
        TaskState::Finalizing,
        if use_native_mp4_mux {
            "muxing-audio-video-native"
        } else {
            "muxing-audio-video-host"
        },
    ) {
        handle_native_transition_error(
            state,
            id,
            generation,
            error,
            should_cancel(),
        );
        return;
    }

    if use_native_mp4_mux {
        match mux_mp4_tracks_controlled(&output.0, &output.1, output_path, &should_cancel) {
            Ok(result) => {
                if complete_native_task(state, id, generation, result.bytes) {
                    let _ = std::fs::remove_dir_all(staging_dir);
                }
            }
            Err(NativeMuxError::Cancelled) if should_cancel() => {
                finish_native_cancelled(state, id, generation)
            }
            Err(error) => fail_native_task(state, id, generation, error.to_string()),
        }
        return;
    }

    let postprocessor = FfmpegPostProcessor::new(state.ffmpeg_binary());
    let request = MediaMuxRequest {
        video_path: output.0,
        audio_path: output.1,
        destination: output_path.to_path_buf(),
    };
    match postprocessor.mux(&request, &should_cancel) {
        Ok(bytes) => {
            if complete_native_task(state, id, generation, bytes) {
                let _ = std::fs::remove_dir_all(staging_dir);
            }
        }
        Err(PostProcessError::Cancelled) if should_cancel() => {
            finish_native_cancelled(state, id, generation)
        }
        Err(error) => fail_native_task(state, id, generation, error.to_string()),
    }
}

fn verify_native_track(path: &Path, expected_bytes: u64, label: &str) -> Result<(), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Native {label} track is missing: {error}"))?;
    if !metadata.is_file() {
        return Err(format!(
            "Native {label} track is not a regular file: {}",
            path.display()
        ));
    }
    if metadata.len() == 0 {
        return Err(format!("Native {label} track is empty"));
    }
    if expected_bytes > 0 && metadata.len() != expected_bytes {
        return Err(format!(
            "Native {label} track size mismatch: expected {expected_bytes} bytes, found {}",
            metadata.len()
        ));
    }
    Ok(())
}

fn stage_manifest_transfer<F, P>(
    resolved: &ResolvedManifestMedia,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<ManifestStageOutput, NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    let context = resolved
        .descriptor
        .request_context_for_stream(&resolved.stream)
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;

    match resolved.stream.protocol {
        MediaProtocol::Hls => {
            let (parts, staged_bytes) = stage_hls_stream(
                &resolved.stream.url,
                &context,
                staging_dir,
                connections,
                should_cancel,
                on_progress,
            )?;
            Ok(ManifestStageOutput {
                parts,
                staged_bytes,
            })
        }
        MediaProtocol::Dash => {
            let (parts, staged_bytes) = stage_dash_stream(
                &resolved.stream.url,
                &context,
                staging_dir,
                connections,
                should_cancel,
                on_progress,
            )?;
            Ok(ManifestStageOutput {
                parts,
                staged_bytes,
            })
        }
        MediaProtocol::Http | MediaProtocol::Https => Err(
            NativeMediaTaskError::UnsupportedFeature(
                "direct stream reached manifest executor".to_owned(),
            ),
        ),
    }
}

fn verify_staged_parts(parts: &[(u64, PathBuf)], expected_bytes: u64) -> Result<(), String> {
    if parts.is_empty() {
        return Err("Native manifest staging produced no media parts".to_owned());
    }
    let mut total = 0_u64;
    for (_, path) in parts {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("Staged media part is missing: {error}"))?;
        if !metadata.is_file() {
            return Err(format!(
                "Staged media part is not a regular file: {}",
                path.display()
            ));
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| "Staged media byte count overflow".to_owned())?;
    }
    if total != expected_bytes {
        return Err(format!(
            "Staged media size mismatch: expected {expected_bytes} bytes, found {total}"
        ));
    }
    Ok(())
}

fn stage_hls_stream<F, P>(
    manifest_url: &str,
    context: &HttpRequestContext,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<(Vec<(u64, PathBuf)>, u64), NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    let response = fetch_http_bytes_with_context(
        manifest_url,
        context,
        DEFAULT_MANIFEST_MAX_BYTES,
    )
    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let mut media_url = response.effective_url.clone();
    let body = String::from_utf8(response.body)
        .map_err(|_| NativeMediaTaskError::Resolution("HLS manifest is not UTF-8".to_owned()))?;
    let mut manifest = parse_hls(&media_url, &body)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;

    if manifest.kind == HlsPlaylistKind::Master {
        let variant = select_best_hls_variant(&manifest)
            .ok_or_else(|| NativeMediaTaskError::Resolution("HLS master has no variants".to_owned()))?;
        let variant_context = nova_media_core::scope_http_request_context(
            context,
            manifest_url,
            &variant.uri,
        );
        let response = fetch_http_bytes_with_context(
            &variant.uri,
            &variant_context,
            DEFAULT_MANIFEST_MAX_BYTES,
        )
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        let body = String::from_utf8(response.body)
            .map_err(|_| NativeMediaTaskError::Resolution("HLS media playlist is not UTF-8".to_owned()))?;
        media_url = response.effective_url.clone();
        manifest = parse_hls(&media_url, &body)
            .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    }

    let media_context = nova_media_core::scope_http_request_context(
        context,
        manifest_url,
        &media_url,
    );

    if !manifest.end_list {
        return stage_hls_live_stream(
            &media_url,
            manifest,
            &media_context,
            staging_dir,
            connections,
            should_cancel,
            on_progress,
        );
    }
    let plan = build_hls_media_plan(&manifest)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let staged = stage_hls_media_plan_controlled_with_progress_scoped(
        &plan,
        &media_context,
        Some(&media_url),
        staging_dir,
        connections,
        || should_cancel(),
        |bytes| on_progress(bytes),
    )
    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let total_bytes = staged.total_bytes;
    let parts = staged
        .files
        .into_iter()
        .map(|file| (file.order, file.path))
        .collect();
    Ok((parts, total_bytes))
}

fn stage_dash_stream<F, P>(
    manifest_url: &str,
    context: &HttpRequestContext,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<(Vec<(u64, PathBuf)>, u64), NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    let response = fetch_http_bytes_with_context(
        manifest_url,
        context,
        DEFAULT_MANIFEST_MAX_BYTES,
    )
    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let body = String::from_utf8(response.body)
        .map_err(|_| NativeMediaTaskError::Resolution("DASH manifest is not UTF-8".to_owned()))?;
    let manifest = parse_dash(&body)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let (period, adaptation, representation) = best_dash_representation_indices(&manifest)
        .ok_or_else(|| NativeMediaTaskError::Resolution("DASH manifest has no representations".to_owned()))?;
    let manifest_context = nova_media_core::scope_http_request_context(
        context,
        manifest_url,
        &response.effective_url,
    );
    if manifest.is_dynamic {
        return stage_dash_live_stream(
            &response.effective_url,
            manifest,
            period,
            adaptation,
            representation,
            &manifest_context,
            staging_dir,
            connections,
            should_cancel,
            on_progress,
        );
    }
    let plan = build_dash_representation_plan(
        &manifest,
        &response.effective_url,
        period,
        adaptation,
        representation,
    )
    .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let staged = stage_dash_representation_plan_controlled_with_progress_scoped(
        &plan,
        &manifest_context,
        Some(&response.effective_url),
        staging_dir,
        connections,
        || should_cancel(),
        |bytes| on_progress(bytes),
    )
    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let total_bytes = staged.total_bytes;
    let parts = staged
        .files
        .into_iter()
        .map(|file| (file.order, file.path))
        .collect();
    Ok((parts, total_bytes))
}


fn stage_hls_live_stream<F, P>(
    media_url: &str,
    initial_manifest: nova_stream_core::HlsManifest,
    context: &HttpRequestContext,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<(Vec<(u64, PathBuf)>, u64), NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    let checkpoint_path = staging_dir.join("hls-live-checkpoint.json");
    let mut checkpoint: HlsLiveTaskCheckpoint =
        read_live_checkpoint(&checkpoint_path).unwrap_or_default();
    let mut current_manifest = Some(initial_manifest);
    let mut tick = 0_u64;

    loop {
        if should_cancel() {
            return Err(NativeMediaTaskError::Transfer(
                "native HLS live staging was cancelled".to_owned(),
            ));
        }

        let manifest = if let Some(manifest) = current_manifest.take() {
            manifest
        } else {
            let response = fetch_http_bytes_with_context(
                media_url,
                context,
                DEFAULT_MANIFEST_MAX_BYTES,
            )
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
            let body = String::from_utf8(response.body).map_err(|_| {
                NativeMediaTaskError::Resolution("HLS live manifest is not UTF-8".to_owned())
            })?;
            parse_hls(&response.effective_url, &body)
                .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?
        };

        let mut refresh = build_hls_live_refresh(&manifest, checkpoint.cursor)
            .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;

        if let Some(mut plan) = refresh.plan.take() {
            let mut last_init = checkpoint.last_init_identity.clone();
            plan.units.retain(|unit| {
                if unit.kind != HlsTransferUnitKind::Initialization {
                    return true;
                }
                let identity = format!(
                    "{}|{:?}",
                    unit.uri,
                    unit.byte_range
                );
                if last_init.as_deref() == Some(identity.as_str()) {
                    return false;
                }
                last_init = Some(identity);
                true
            });

            if !plan.units.is_empty() {
                let tick_dir = staging_dir.join(format!("hls-tick-{tick:08}"));
                let base = checkpoint.total_bytes;
                let staged = stage_hls_media_plan_controlled_with_progress_scoped(
                    &plan,
                    context,
                    Some(media_url),
                    &tick_dir,
                    connections,
                    || should_cancel(),
                    |bytes| on_progress(base.saturating_add(bytes)),
                )
                .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;

                let files = staged
                    .files
                    .into_iter()
                    .map(|file| (file.order, file.path))
                    .collect::<Vec<_>>();
                commit_live_parts(staging_dir, &files, &mut checkpoint.next_order)?;
                checkpoint.total_bytes =
                    checkpoint.total_bytes.saturating_add(staged.total_bytes);
                checkpoint.last_init_identity = last_init;
                let _ = std::fs::remove_dir_all(tick_dir);
            }
        }

        checkpoint.cursor = refresh.next_cursor;
        write_live_checkpoint(&checkpoint_path, &checkpoint)?;
        on_progress(checkpoint.total_bytes);

        if refresh.ended {
            return Ok((
                committed_live_parts(staging_dir)?,
                checkpoint.total_bytes,
            ));
        }

        tick = tick.saturating_add(1);
        sleep_live_refresh(refresh.reload_after_millis, should_cancel)?;
    }
}

#[allow(clippy::too_many_arguments)]
fn stage_dash_live_stream<F, P>(
    manifest_url: &str,
    initial_manifest: DashManifest,
    period: usize,
    adaptation: usize,
    representation: usize,
    context: &HttpRequestContext,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<(Vec<(u64, PathBuf)>, u64), NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    let checkpoint_path = staging_dir.join("dash-live-checkpoint.json");
    let mut checkpoint: DashLiveTaskCheckpoint =
        read_live_checkpoint(&checkpoint_path).unwrap_or_default();
    let mut current_manifest = Some(initial_manifest);
    let mut tick = 0_u64;

    loop {
        if should_cancel() {
            return Err(NativeMediaTaskError::Transfer(
                "native DASH live staging was cancelled".to_owned(),
            ));
        }

        let (manifest, effective_url) = if let Some(manifest) = current_manifest.take() {
            (manifest, manifest_url.to_owned())
        } else {
            let response = fetch_http_bytes_with_context(
                manifest_url,
                context,
                DEFAULT_MANIFEST_MAX_BYTES,
            )
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
            let body = String::from_utf8(response.body).map_err(|_| {
                NativeMediaTaskError::Resolution("DASH live manifest is not UTF-8".to_owned())
            })?;
            let manifest = parse_dash(&body)
                .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
            (manifest, response.effective_url)
        };

        if !manifest.is_dynamic {
            let parts = committed_live_parts(staging_dir)?;
            if parts.is_empty() {
                return Err(NativeMediaTaskError::Resolution(
                    "DASH live source ended before any media was committed".to_owned(),
                ));
            }
            return Ok((parts, checkpoint.total_bytes));
        }

        let refresh = build_dash_live_refresh(
            &manifest,
            &effective_url,
            period,
            adaptation,
            representation,
            checkpoint.cursor,
        )
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;

        if let Some(plan) = refresh.plan {
            let tick_dir = staging_dir.join(format!("dash-tick-{tick:08}"));
            let base = checkpoint.total_bytes;
            let staged = stage_dash_representation_plan_controlled_with_progress_scoped(
                &plan,
                context,
                Some(&effective_url),
                &tick_dir,
                connections,
                || should_cancel(),
                |bytes| on_progress(base.saturating_add(bytes)),
            )
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
            let files = staged
                .files
                .into_iter()
                .map(|file| (file.order, file.path))
                .collect::<Vec<_>>();
            commit_live_parts(staging_dir, &files, &mut checkpoint.next_order)?;
            checkpoint.total_bytes =
                checkpoint.total_bytes.saturating_add(staged.total_bytes);
            let _ = std::fs::remove_dir_all(tick_dir);
        }

        checkpoint.cursor = refresh.next_cursor;
        write_live_checkpoint(&checkpoint_path, &checkpoint)?;
        on_progress(checkpoint.total_bytes);
        tick = tick.saturating_add(1);
        sleep_live_refresh(refresh.reload_after_millis, should_cancel)?;
    }
}

fn live_parts_dir(staging_dir: &Path) -> PathBuf {
    staging_dir.join("live-parts")
}

fn commit_live_parts(
    staging_dir: &Path,
    parts: &[(u64, PathBuf)],
    next_order: &mut u64,
) -> Result<(), NativeMediaTaskError> {
    let destination = live_parts_dir(staging_dir);
    std::fs::create_dir_all(&destination)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let mut ordered = parts.to_vec();
    ordered.sort_by_key(|(order, _)| *order);
    for (_, source) in ordered {
        let target = destination.join(format!("{:020}.part", *next_order));
        if target.exists() {
            std::fs::remove_file(&target)
                .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        }
        std::fs::rename(&source, &target)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        *next_order = next_order.saturating_add(1);
    }
    Ok(())
}

fn committed_live_parts(
    staging_dir: &Path,
) -> Result<Vec<(u64, PathBuf)>, NativeMediaTaskError> {
    let directory = live_parts_dir(staging_dir);
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut parts = Vec::new();
    let entries = std::fs::read_dir(&directory)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(order) = stem.parse::<u64>() else {
            continue;
        };
        parts.push((order, path));
    }
    parts.sort_by_key(|(order, _)| *order);
    Ok(parts)
}

fn read_live_checkpoint<T>(path: &Path) -> Option<T>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_live_checkpoint<T>(path: &Path, checkpoint: &T) -> Result<(), NativeMediaTaskError>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }
    let payload = serde_json::to_vec(checkpoint)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, payload)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let file = std::fs::File::open(&temp)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    file.sync_all()
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    drop(file);
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }
    std::fs::rename(&temp, path)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    Ok(())
}

fn sleep_live_refresh<F>(
    millis: u64,
    should_cancel: &F,
) -> Result<(), NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
{
    let deadline = Instant::now() + std::time::Duration::from_millis(millis.max(1));
    while Instant::now() < deadline {
        if should_cancel() {
            return Err(NativeMediaTaskError::Transfer(
                "native live refresh was cancelled".to_owned(),
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(100)));
    }
    Ok(())
}

fn best_dash_representation_indices(manifest: &DashManifest) -> Option<(usize, usize, usize)> {
    let mut best: Option<((u64, u64), (usize, usize, usize))> = None;
    for (period_index, period) in manifest.periods.iter().enumerate() {
        for (adaptation_index, adaptation) in period.adaptations.iter().enumerate() {
            for (representation_index, representation) in
                adaptation.representations.iter().enumerate()
            {
                let score = (
                    u64::from(representation.width.unwrap_or(0))
                        .saturating_mul(u64::from(representation.height.unwrap_or(0))),
                    representation.bandwidth.unwrap_or(0),
                );
                if best.as_ref().map_or(true, |(current, _)| score > *current) {
                    best = Some((
                        score,
                        (period_index, adaptation_index, representation_index),
                    ));
                }
            }
        }
    }
    best.map(|(_, indices)| indices)
}

fn transition_native_task(
    state: &SharedState,
    id: &str,
    generation: u64,
    next: TaskState,
    engine_status: &str,
) -> Result<(), String> {
    let task = {
        let mut jobs = state
            .native_media_jobs
            .lock()
            .map_err(|error| error.to_string())?;
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| format!("Native media task {id} disappeared"))?;
        if job.run_generation.load(Ordering::Acquire) != generation {
            return Err(format!("Native media task {id} generation changed"));
        }
        transition_task_state(&mut job.task, next, engine_status)?;
        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.mark_dirty();
    Ok(())
}

fn update_native_progress(state: &SharedState, id: &str, generation: u64, bytes: u64) {
    let task = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => return,
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let elapsed = job.start_time.elapsed().as_secs_f64().max(0.001);
        job.task.downloaded_bytes = bytes;
        job.task.speed_bytes_per_sec = (bytes as f64 / elapsed) as u64;
        job.task.elapsed_seconds = elapsed as u64;
        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.mark_dirty();
}

fn update_native_multitrack_progress(
    state: &SharedState,
    id: &str,
    generation: u64,
    progress: YouTubeTransferProgress,
) {
    let task = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => return,
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }

        let elapsed = job.start_time.elapsed().as_secs_f64().max(0.001);
        let downloaded = progress.downloaded_bytes();
        let speed = (downloaded as f64 / elapsed) as u64;
        if let Some(total) = progress.total_bytes() {
            job.task.size_bytes = total;
            job.task.time_left_seconds = if speed > 0 {
                total
                    .saturating_sub(downloaded)
                    .saturating_div(speed.max(1))
            } else {
                0
            };
        }
        job.task.downloaded_bytes = downloaded;
        job.task.speed_bytes_per_sec = speed;
        job.task.elapsed_seconds = elapsed as u64;

        if job.task.segments.len() < 2 {
            job.task.segments = vec![
                Segment {
                    id: 0,
                    progress: 0.0,
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    active: true,
                    speed: 0,
                    start_byte: 0,
                    end_byte: 0,
                },
                Segment {
                    id: 1,
                    progress: 0.0,
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    active: true,
                    speed: 0,
                    start_byte: 0,
                    end_byte: 0,
                },
            ];
        }

        let (video_segments, audio_segments) = job.task.segments.split_at_mut(1);
        update_track_segment(
            &mut video_segments[0],
            progress.video_downloaded,
            progress.video_total,
            elapsed,
        );
        update_track_segment(
            &mut audio_segments[0],
            progress.audio_downloaded,
            progress.audio_total,
            elapsed,
        );

        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.mark_dirty();
}

fn update_track_segment(
    segment: &mut Segment,
    downloaded: u64,
    total: Option<u64>,
    elapsed: f64,
) {
    segment.downloaded_bytes = downloaded;
    if let Some(total) = total {
        segment.total_bytes = total;
        segment.end_byte = total.saturating_sub(1);
        segment.progress = if total == 0 {
            0.0
        } else {
            downloaded.min(total) as f64 / total as f64
        };
        segment.active = downloaded < total;
    } else {
        segment.progress = 0.0;
        segment.active = true;
    }
    segment.speed = (downloaded as f64 / elapsed.max(0.001)) as u64;
}

fn set_native_track_activity(
    state: &SharedState,
    id: &str,
    generation: u64,
    active: bool,
) {
    let task = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => return,
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        for segment in &mut job.task.segments {
            segment.active = active;
            if !active && segment.total_bytes > 0 {
                segment.progress =
                    segment.downloaded_bytes.min(segment.total_bytes) as f64
                        / segment.total_bytes as f64;
            }
        }
        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.mark_dirty();
}

fn assemble_live_preview(state: &SharedState, id: &str, generation: u64) {
    let (output, valid_generation) = match state.native_media_jobs.lock() {
        Ok(jobs) => jobs.get(id).map_or((PathBuf::new(), false), |job| {
            (
                PathBuf::from(&job.task.save_path),
                job.run_generation.load(Ordering::Acquire) == generation,
            )
        }),
        Err(_) => return,
    };
    if !valid_generation || output.as_os_str().is_empty() {
        return;
    }
    let staging = Path::new(&state.data_dir)
        .join("native-media")
        .join(id)
        .join("working");
    let Ok(parts) = committed_live_parts(&staging) else {
        return;
    };
    if parts.is_empty() {
        return;
    }
    if let Ok(assembly) = assemble_ordered_parts(&parts, &output) {
        update_native_progress(state, id, generation, assembly.bytes);
    }
}

fn finish_native_cancelled(state: &SharedState, id: &str, generation: u64) {
    assemble_live_preview(state, id, generation);
    let task = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => return,
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let current = TaskState::from_status(&job.task.status);
        if current != Some(TaskState::Paused) {
            let _ = transition_task_state(&mut job.task, TaskState::Paused, "paused");
        }
        job.task.speed_bytes_per_sec = 0;
        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.priority_queue.release_active_slot();
    state.mark_dirty();
    crate::daemon::persist::save_now(state.as_ref());
}

fn fail_native_task(state: &SharedState, id: &str, generation: u64, error: String) {
    let task = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => return,
        };
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let _ = transition_task_state(&mut job.task, TaskState::Failed, "failed");
        job.task.speed_bytes_per_sec = 0;
        job.task.error_message = Some(error);
        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.priority_queue.stop_download(id);
    if let Ok(mut stats) = state.download_stats.lock() {
        stats.total_failed = stats.total_failed.saturating_add(1);
    }
    state.mark_dirty();
}

fn complete_native_task(state: &SharedState, id: &str, generation: u64, bytes: u64) -> bool {
    enum Completion {
        Completed(Task),
        Paused(Task),
        Stale,
    }

    let completion = {
        let mut jobs = match state.native_media_jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => return false,
        };
        let Some(job) = jobs.get_mut(id) else {
            return false;
        };
        if job.run_generation.load(Ordering::Acquire) != generation {
            Completion::Stale
        } else {
            let current = TaskState::from_status(&job.task.status);
            if matches!(current, Some(TaskState::Pausing | TaskState::Paused)) {
                if current == Some(TaskState::Pausing) {
                    let _ = transition_task_state(&mut job.task, TaskState::Paused, "paused");
                }
                job.task.speed_bytes_per_sec = 0;
                Completion::Paused(job.task.clone())
            } else {
                job.task.size_bytes = bytes;
                job.task.downloaded_bytes = bytes;
                job.task.speed_bytes_per_sec = 0;
                job.task.time_left_seconds = 0;
                job.task.error_message = None;
                if let Err(error) =
                    transition_task_state(&mut job.task, TaskState::Completed, "completed")
                {
                    log::error!("Native media task {id}: completion transition rejected: {error}");
                    return false;
                }
                Completion::Completed(job.task.clone())
            }
        }
    };

    match completion {
        Completion::Completed(task) => {
            if let Ok(mut snapshot) = state.task_snapshot.lock() {
                snapshot.insert(id.to_owned(), task);
            }
            state.priority_queue.stop_download(id);
            if let Ok(mut stats) = state.download_stats.lock() {
                stats.total_completed = stats.total_completed.saturating_add(1);
                stats.total_downloaded_bytes =
                    stats.total_downloaded_bytes.saturating_add(bytes);
            }
            state.mark_dirty();
            true
        }
        Completion::Paused(task) => {
            if let Ok(mut snapshot) = state.task_snapshot.lock() {
                snapshot.insert(id.to_owned(), task);
            }
            state.priority_queue.release_active_slot();
            state.mark_dirty();
            crate::daemon::persist::save_now(state.as_ref());
            false
        }
        Completion::Stale => false,
    }
}

pub(crate) fn is_native_manifest_url(url: &str) -> bool {
    let path = url
        .split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    path.ends_with(".m3u8") || path.ends_with(".mpd")
}

#[derive(Clone, Debug)]
struct NativeSelectionPreferences {
    mode: MediaSelectionMode,
    preferred_container: Option<String>,
    preferred_video_codec: Option<String>,
    preferred_audio_codec: Option<String>,
    sort: Vec<MediaSortKey>,
}

fn native_selection_preferences(
    options: Option<&MediaDownloadOptions>,
) -> Result<NativeSelectionPreferences, String> {
    let mode = options
        .and_then(|options| options.mode.as_deref())
        .unwrap_or("video")
        .trim()
        .to_ascii_lowercase();
    let mode = match mode.as_str() {
        "video" | "best" | "auto" => MediaSelectionMode::Video,
        "audio" => MediaSelectionMode::Audio,
        other => return Err(format!("Native media mode '{other}' is not supported")),
    };

    let configured_audio_format = options
        .and_then(|options| options.audio_format.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if mode != MediaSelectionMode::Audio && configured_audio_format.is_some() {
        return Err("audioFormat requires native media mode 'audio'".to_owned());
    }

    let mut preferred_container = None;
    if mode == MediaSelectionMode::Audio {
        if let Some(format) = configured_audio_format {
            preferred_container = match format.to_ascii_lowercase().as_str() {
                "best" | "auto" => None,
                "m4a" | "mp4" | "aac" => Some("mp4".to_owned()),
                "webm" | "opus" | "ogg" => Some("webm".to_owned()),
                "mp3" | "flac" | "wav" | "alac" => {
                    return Err(format!(
                        "Audio format '{format}' requires transcoding; native extraction only selects an existing audio representation"
                    ));
                }
                other => {
                    return Err(format!(
                        "Native audio container preference '{other}' is not supported"
                    ));
                }
            };
        }
    }

    let mut preferred_video_codec = None;
    let mut preferred_audio_codec = None;
    let mut sort = Vec::new();
    if let Some(expression) = options
        .and_then(|options| options.format_sort.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        for raw in expression.split(',').map(str::trim).filter(|value| !value.is_empty()) {
            let lower = raw.to_ascii_lowercase();
            match lower.as_str() {
                "res" | "height" | "quality" => push_sort_key(&mut sort, MediaSortKey::Quality),
                "br" | "bitrate" | "abr" | "vbr" => {
                    push_sort_key(&mut sort, MediaSortKey::Bitrate)
                }
                "size" | "filesize" | "filesize_approx" => {
                    push_sort_key(&mut sort, MediaSortKey::Size)
                }
                _ if lower.starts_with("codec:") => {
                    let mut parts = lower.split(':');
                    let _ = parts.next();
                    if let Some(video) = parts.next().filter(|value| !value.is_empty()) {
                        preferred_video_codec = Some(normalize_codec_preference(video));
                    }
                    if let Some(audio) = parts.next().filter(|value| !value.is_empty()) {
                        preferred_audio_codec = Some(normalize_codec_preference(audio));
                    }
                    if parts.next().is_some() {
                        return Err(format!("Unsupported native format sort token '{raw}'"));
                    }
                }
                _ if lower.starts_with("ext:") || lower.starts_with("container:") => {
                    let value = lower
                        .split_once(':')
                        .map(|(_, value)| value)
                        .unwrap_or_default()
                        .trim();
                    if value.is_empty() {
                        return Err(format!("Unsupported native format sort token '{raw}'"));
                    }
                    preferred_container = Some(normalize_container_preference(value)?);
                }
                _ => return Err(format!("Unsupported native format sort token '{raw}'")),
            }
        }
    }
    if sort.is_empty() {
        sort = vec![
            MediaSortKey::Quality,
            MediaSortKey::Bitrate,
            MediaSortKey::Size,
        ];
    }

    Ok(NativeSelectionPreferences {
        mode,
        preferred_container,
        preferred_video_codec,
        preferred_audio_codec,
        sort,
    })
}

fn push_sort_key(sort: &mut Vec<MediaSortKey>, key: MediaSortKey) {
    if !sort.contains(&key) {
        sort.push(key);
    }
}

fn normalize_codec_preference(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "m4a" | "aac" => "mp4a".to_owned(),
        "h264" => "avc".to_owned(),
        "h265" | "hevc" => "hev".to_owned(),
        other => other.to_owned(),
    }
}

fn normalize_container_preference(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "mp4" | "m4a" | "aac" => Ok("mp4".to_owned()),
        "webm" | "opus" | "ogg" => Ok("webm".to_owned()),
        "mkv" | "matroska" => Ok("mkv".to_owned()),
        other => Err(format!("Native container preference '{other}' is not supported")),
    }
}

fn normalized_stream_id(value: &str) -> String {
    let value = value.trim();
    if value.starts_with("youtube-itag-") {
        value.to_owned()
    } else if value.chars().all(|character| character.is_ascii_digit()) {
        format!("youtube-itag-{value}")
    } else {
        value.to_owned()
    }
}

fn explicit_youtube_plan(
    extraction: &YouTubeExtraction,
    selector: Option<&str>,
    policy: &YouTubeSelectionPolicy,
) -> Result<Option<YouTubeDownloadPlan>, NativeMediaTaskError> {
    let Some(selector) = selector.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if matches!(selector.to_ascii_lowercase().as_str(), "best" | "auto") {
        return Ok(None);
    }

    let ids = selector
        .split('+')
        .map(normalized_stream_id)
        .collect::<Vec<_>>();
    if ids.len() > 2 {
        return Err(NativeMediaTaskError::UnsupportedFeature(format!(
            "native format selector '{selector}' is not supported"
        )));
    }
    let pending: std::collections::BTreeSet<String> = extraction
        .pending_formats
        .iter()
        .filter_map(|format| format.itag)
        .map(|itag| format!("youtube-itag-{itag}"))
        .collect();
    for id in &ids {
        if pending.contains(id) {
            return Err(NativeMediaTaskError::UnsupportedFeature(format!(
                "selected format '{id}' still requires an unresolved media challenge"
            )));
        }
        if !extraction.descriptor.streams.iter().any(|stream| stream.id == *id) {
            return Err(NativeMediaTaskError::InvalidRequest(format!(
                "native format selector references unknown stream '{id}'"
            )));
        }
    }

    match ids.as_slice() {
        [stream_id] => {
            let stream = extraction
                .descriptor
                .streams
                .iter()
                .find(|stream| stream.id == *stream_id)
                .expect("validated selected stream");
            if policy.mode == MediaSelectionMode::Audio
                && stream.kind != nova_media_core::MediaTrackKind::Audio
            {
                return Err(NativeMediaTaskError::InvalidRequest(
                    "audio mode requires an audio-only selected representation".to_owned(),
                ));
            }

            if policy.prefer_separate_tracks
                && stream.kind == nova_media_core::MediaTrackKind::Video
            {
                let mut ready_descriptor = extraction.descriptor.clone();
                ready_descriptor
                    .streams
                    .retain(|candidate| !pending.contains(&candidate.id));
                let audio = select_media_stream(
                    &ready_descriptor,
                    &MediaSelectionPolicy {
                        mode: MediaSelectionMode::Audio,
                        max_height: None,
                        preferred_container: policy.preferred_container.clone(),
                        preferred_language: policy.preferred_language.clone(),
                        preferred_video_codec: None,
                        preferred_audio_codec: policy.preferred_audio_codec.clone(),
                        sort: policy.sort.clone(),
                    },
                )
                .ok_or_else(|| {
                    NativeMediaTaskError::UnsupportedFeature(
                        "the selected video-only representation has no native-ready audio track"
                            .to_owned(),
                    )
                })?;
                return Ok(Some(YouTubeDownloadPlan::SeparateTracks {
                    video_stream_id: stream_id.clone(),
                    audio_stream_id: audio.id.clone(),
                }));
            }

            Ok(Some(YouTubeDownloadPlan::SingleStream {
                stream_id: stream_id.clone(),
            }))
        }
        [first, second] => {
            let first_stream = extraction
                .descriptor
                .streams
                .iter()
                .find(|stream| stream.id == *first)
                .expect("validated first stream");
            let second_stream = extraction
                .descriptor
                .streams
                .iter()
                .find(|stream| stream.id == *second)
                .expect("validated second stream");
            let (video, audio) = match (first_stream.kind, second_stream.kind) {
                (nova_media_core::MediaTrackKind::Video, nova_media_core::MediaTrackKind::Audio) => {
                    (first, second)
                }
                (nova_media_core::MediaTrackKind::Audio, nova_media_core::MediaTrackKind::Video) => {
                    (second, first)
                }
                _ => {
                    return Err(NativeMediaTaskError::InvalidRequest(
                        "a two-stream native format selector must contain one video-only and one audio-only representation"
                            .to_owned(),
                    ))
                }
            };
            Ok(Some(YouTubeDownloadPlan::SeparateTracks {
                video_stream_id: video.clone(),
                audio_stream_id: audio.clone(),
            }))
        }
        _ => Ok(None),
    }
}

fn validate_native_options(options: &MediaDownloadOptions) -> Result<(), String> {
    let _ = native_selection_preferences(Some(options))?;
    if let Some(selector) = options
        .format_selector
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if selector.split('+').count() > 2 {
            return Err(format!(
                "Native format selector '{selector}' is not supported"
            ));
        }
    }
    let mode = options.mode.as_deref().unwrap_or("video").trim().to_ascii_lowercase();
    if !matches!(mode.as_str(), "video" | "best" | "auto" | "audio") {
        return Err(format!(
            "Native media mode '{mode}' is not migrated yet"
        ));
    }

    if options
        .subtitle_languages
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && options.subtitles != Some(true)
        && options.auto_subtitles != Some(true)
    {
        return Err(
            "subtitleLanguages requires subtitles=true or autoSubtitles=true".to_owned(),
        );
    }

    if let Some(template) = options.output_template.as_deref().map(str::trim) {
        if !template.is_empty() && template != "%(title)s.%(ext)s" {
            return Err("Custom media output templates are not migrated yet".to_owned());
        }
    }

    if let Some(source) = options
        .cookies_from_browser
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_browser_cookie_source(source)?;
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

fn resolve_native_media(
    body: &CreateDownloadBody,
) -> Result<ResolvedNativeMedia, NativeMediaTaskError> {
    let request = build_extract_request(body)?;
    let parsed = request
        .parsed_url()
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
    let max_height = body
        .media_options
        .as_ref()
        .and_then(|options| options.quality.as_deref())
        .and_then(parse_quality_height);
    let selection = native_selection_preferences(body.media_options.as_ref())
        .map_err(NativeMediaTaskError::InvalidRequest)?;

    if youtube_video_id(&parsed).is_some() {
        let extractor = YouTubeExtractor;
        let mut extraction = extractor
            .extract_native(&request)
            .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;

        if !extraction.pending_formats.is_empty() {
            let context = request
                .request_context()
                .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
            let solver = YouTubePlayerScriptSolver;
            let challenge_resolution =
                resolve_youtube_pending_formats(&mut extraction, &context, &solver)
                    .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
            if !challenge_resolution.unresolved_itags.is_empty() {
                log::debug!(
                    "NOVA Media Engine left unsupported challenged formats unresolved: {:?}",
                    challenge_resolution.unresolved_itags
                );
            }
        }

        let host_postprocessing_enabled = body
            .media_options
            .as_ref()
            .and_then(|options| options.ffmpeg_enabled)
            .unwrap_or(false);
        let native_multitrack_enabled =
            nova_media_core::native_media_core_capabilities().native_mp4_multitrack_mux;
        let multitrack_enabled = host_postprocessing_enabled || native_multitrack_enabled;
        let preferred_container = if native_multitrack_enabled
            && !host_postprocessing_enabled
            && selection.preferred_container.is_none()
        {
            Some("mp4".to_owned())
        } else {
            selection.preferred_container.clone()
        };
        let youtube_policy = YouTubeSelectionPolicy {
            mode: selection.mode,
            max_height,
            prefer_separate_tracks: multitrack_enabled,
            preferred_container,
            preferred_language: None,
            preferred_video_codec: selection.preferred_video_codec.clone(),
            preferred_audio_codec: selection.preferred_audio_codec.clone(),
            sort: selection.sort.clone(),
        };
        let plan = explicit_youtube_plan(
            &extraction,
            body.media_options
                .as_ref()
                .and_then(|options| options.format_selector.as_deref()),
            &youtube_policy,
        )?
        .or_else(|| select_youtube_download_plan(&extraction, youtube_policy))
        .ok_or_else(|| {
            NativeMediaTaskError::UnsupportedFeature(
                if selection.mode == MediaSelectionMode::Audio {
                    "no native-ready audio-only representation was found after challenge resolution"
                        .to_owned()
                } else {
                    "no native-ready media stream was found after challenge resolution".to_owned()
                },
            )
        })?;

        return match plan {
            YouTubeDownloadPlan::SingleStream { stream_id } => {
                let stream = extraction
                    .descriptor
                    .streams
                    .iter()
                    .find(|stream| stream.id == stream_id)
                    .ok_or_else(|| {
                        NativeMediaTaskError::Resolution(
                            "selected native media stream disappeared".to_owned(),
                        )
                    })?;
                if selection.mode == MediaSelectionMode::Audio
                    && stream.kind != nova_media_core::MediaTrackKind::Audio
                {
                    return Err(NativeMediaTaskError::InvalidRequest(
                        "audio mode requires an audio-only source representation".to_owned(),
                    ));
                }
                ensure_requested_audio_container(stream, body.media_options.as_ref())?;
                ensure_native_remux_policy(stream, body.media_options.as_ref())?;
                let mut resolved = resolved_from_descriptor(&extraction.descriptor, stream)?;
                attach_native_chapters(&mut resolved, extraction.chapters.clone());
                Ok(resolved)
            }
            YouTubeDownloadPlan::SeparateTracks {
                video_stream_id,
                audio_stream_id,
            } => {
                if selection.mode == MediaSelectionMode::Audio {
                    return Err(NativeMediaTaskError::InvalidRequest(
                        "audio mode cannot use a video+audio format selector".to_owned(),
                    ));
                }
                if !multitrack_enabled {
                    return Err(NativeMediaTaskError::UnsupportedFeature(
                        "the selected quality requires separate audio/video tracks, but no compatible mux path is enabled"
                            .to_owned(),
                    ));
                }
                let video = extraction
                    .descriptor
                    .streams
                    .iter()
                    .find(|stream| stream.id == video_stream_id)
                    .ok_or_else(|| {
                        NativeMediaTaskError::Resolution(
                            "selected native video track disappeared".to_owned(),
                        )
                    })?;
                let audio = extraction
                    .descriptor
                    .streams
                    .iter()
                    .find(|stream| stream.id == audio_stream_id)
                    .ok_or_else(|| {
                        NativeMediaTaskError::Resolution(
                            "selected native audio track disappeared".to_owned(),
                        )
                    })?;
                let expected_bytes = match (video.content_length, audio.content_length) {
                    (Some(video), Some(audio)) => Some(video.saturating_add(audio)),
                    _ => None,
                };
                let default_container = separate_track_output_container(video, audio);
                let output_container = requested_separate_track_container(
                    &default_container,
                    body.media_options.as_ref(),
                )?;
                Ok(ResolvedNativeMedia::SeparateTracks(ResolvedSeparateTracks {
                    extraction,
                    video_stream_id,
                    audio_stream_id,
                    output_container,
                    expected_bytes,
                }))
            }
        };
    }

    let registry = nova_media_core::ExtractorRegistry::with_native_defaults();
    let descriptor = registry
        .resolve(&request)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let stream = select_media_stream(
        &descriptor,
        &MediaSelectionPolicy {
            mode: selection.mode,
            max_height,
            preferred_container: selection.preferred_container.clone(),
            preferred_language: None,
            preferred_video_codec: selection.preferred_video_codec.clone(),
            preferred_audio_codec: selection.preferred_audio_codec.clone(),
            sort: selection.sort.clone(),
        },
    )
    .ok_or_else(|| {
        NativeMediaTaskError::Resolution(
            if selection.mode == MediaSelectionMode::Audio {
                "native media result has no audio-only stream".to_owned()
            } else {
                "native media result has no playable video stream".to_owned()
            },
        )
    })?;
    ensure_requested_audio_container(stream, body.media_options.as_ref())?;
    ensure_native_remux_policy(stream, body.media_options.as_ref())?;

    resolved_from_descriptor(&descriptor, stream)
}

fn ensure_native_remux_policy(
    stream: &MediaStream,
    options: Option<&MediaDownloadOptions>,
) -> Result<(), NativeMediaTaskError> {
    let Some(requested) = options
        .and_then(|options| options.remux_format.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if matches!(requested.to_ascii_lowercase().as_str(), "auto" | "best") {
        return Ok(());
    }
    let requested = normalize_container_preference(requested)
        .map_err(NativeMediaTaskError::InvalidRequest)?;
    let actual = stream
        .container
        .as_deref()
        .map(normalize_container_alias)
        .unwrap_or_default();
    if actual == requested {
        Ok(())
    } else {
        Err(NativeMediaTaskError::UnsupportedFeature(format!(
            "remuxFormat='{requested}' requires NOVA post-processing for this source container"
        )))
    }
}

fn requested_separate_track_container(
    default_container: &str,
    options: Option<&MediaDownloadOptions>,
) -> Result<String, NativeMediaTaskError> {
    let Some(requested) = options
        .and_then(|options| options.remux_format.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(default_container.to_owned());
    };
    if matches!(requested.to_ascii_lowercase().as_str(), "auto" | "best") {
        return Ok(default_container.to_owned());
    }
    let requested = normalize_container_preference(requested)
        .map_err(NativeMediaTaskError::InvalidRequest)?;
    if requested == "mkv" || requested == default_container {
        Ok(requested)
    } else {
        Err(NativeMediaTaskError::UnsupportedFeature(format!(
            "separate-track copy-mux cannot produce '{requested}' from native '{default_container}' tracks without additional post-processing"
        )))
    }
}

fn normalize_container_alias(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "m4a" | "aac" => "mp4".to_owned(),
        "opus" | "ogg" => "webm".to_owned(),
        "matroska" => "mkv".to_owned(),
        other => other.to_owned(),
    }
}

fn ensure_requested_audio_container(
    stream: &MediaStream,
    options: Option<&MediaDownloadOptions>,
) -> Result<(), NativeMediaTaskError> {
    let Some(requested) = options
        .and_then(|options| options.audio_format.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if matches!(requested.to_ascii_lowercase().as_str(), "best" | "auto") {
        return Ok(());
    }
    let required = match requested.to_ascii_lowercase().as_str() {
        "m4a" | "mp4" | "aac" => "mp4",
        "webm" | "opus" | "ogg" => "webm",
        _ => return Ok(()),
    };
    let actual = stream
        .container
        .as_deref()
        .map(normalize_container_alias)
        .unwrap_or_default();
    if actual.eq_ignore_ascii_case(required) {
        Ok(())
    } else {
        Err(NativeMediaTaskError::UnsupportedFeature(format!(
            "requested audio format '{requested}' is not available as a native source representation"
        )))
    }
}

const NATIVE_SUBTITLE_MAX_BYTES: usize = 8 * 1024 * 1024;
const NATIVE_THUMBNAIL_MAX_BYTES: usize = 24 * 1024 * 1024;

#[derive(Default)]
struct NativeSidecarArtifacts {
    subtitles: Vec<MediaSubtitleInput>,
}

fn prepare_native_sidecars(
    body: &CreateDownloadBody,
    descriptor: &MediaDescriptor,
    chapters: &[MediaChapter],
    output_path: &Path,
) -> Result<NativeSidecarArtifacts, NativeMediaTaskError> {
    let Some(options) = body.media_options.as_ref() else {
        return Ok(NativeSidecarArtifacts::default());
    };
    let wants_embedding = options.embed_subtitles == Some(true);
    let wants_subtitles = options.subtitles == Some(true)
        || options.auto_subtitles == Some(true)
        || wants_embedding;
    let wants_thumbnail = options.write_thumbnail == Some(true);
    let wants_info = options.write_info_json == Some(true);
    let wants_description = options.write_description == Some(true);
    if !wants_subtitles && !wants_thumbnail && !wants_info && !wants_description {
        return Ok(NativeSidecarArtifacts::default());
    }

    let mut artifacts = NativeSidecarArtifacts::default();

    if let Some(parent) = output_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }

    if wants_info {
        let payload = safe_descriptor_info_json(descriptor, chapters);
        write_atomic_sidecar(
            &sidecar_path(output_path, ".info.json"),
            serde_json::to_vec_pretty(&payload)
                .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?
                .as_slice(),
        )?;
    }

    if wants_description {
        write_atomic_sidecar(
            &sidecar_path(output_path, ".description.txt"),
            descriptor
                .metadata
                .description
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        )?;
    }

    if wants_thumbnail {
        let url = descriptor
            .metadata
            .thumbnail_url
            .as_deref()
            .ok_or_else(|| {
                NativeMediaTaskError::UnsupportedFeature(
                    "the media descriptor does not expose a thumbnail".to_owned(),
                )
            })?;
        crate::daemon::utils::is_safe_target_url(url)
            .map_err(NativeMediaTaskError::InvalidRequest)?;
        let context = descriptor
            .request_context_for_url(url)
            .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
        let response = fetch_http_bytes_with_context(url, &context, NATIVE_THUMBNAIL_MAX_BYTES)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        let extension = sidecar_extension_from_url(&response.effective_url, "jpg");
        write_atomic_sidecar(
            &sidecar_path(output_path, &format!(".thumbnail.{extension}")),
            &response.body,
        )?;
    }

    if wants_subtitles {
        let languages = requested_subtitle_languages(options);
        let wants_manual = options.subtitles == Some(true)
            || (wants_embedding && options.auto_subtitles != Some(true));
        let selected = descriptor
            .subtitles
            .iter()
            .filter(|track| {
                (track.automatic && options.auto_subtitles == Some(true))
                    || (!track.automatic && wants_manual)
            })
            .filter(|track| subtitle_language_matches(&track.language, &languages))
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Err(NativeMediaTaskError::UnsupportedFeature(
                "no subtitle track matches the requested native subtitle policy".to_owned(),
            ));
        }

        for track in selected {
            crate::daemon::utils::is_safe_target_url(&track.url)
                .map_err(NativeMediaTaskError::InvalidRequest)?;
            let context = descriptor
                .request_context_for_url(&track.url)
                .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
            let response =
                fetch_http_bytes_with_context(&track.url, &context, NATIVE_SUBTITLE_MAX_BYTES)
                    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
            let language = safe_sidecar_component(&track.language, "und");
            let format = track
                .format
                .as_deref()
                .map(|value| safe_sidecar_component(value, "sub"))
                .unwrap_or_else(|| "sub".to_owned());
            if wants_embedding && !is_embeddable_subtitle_format(&format) {
                return Err(NativeMediaTaskError::UnsupportedFeature(format!(
                    "subtitle format '{format}' is not supported by the native embedding boundary"
                )));
            }
            let suffix = if track.automatic {
                format!(".auto.{language}.{format}")
            } else {
                format!(".{language}.{format}")
            };
            let path = sidecar_path(output_path, &suffix);
            write_atomic_sidecar(&path, &response.body)?;
            if wants_embedding {
                artifacts.subtitles.push(MediaSubtitleInput {
                    path,
                    language: language.clone(),
                });
            }
        }
    }

    Ok(artifacts)
}

fn is_embeddable_subtitle_format(format: &str) -> bool {
    matches!(
        format.trim().to_ascii_lowercase().as_str(),
        "vtt" | "srt" | "ass" | "ssa"
    )
}

fn requested_subtitle_languages(options: &MediaDownloadOptions) -> Vec<String> {
    options
        .subtitle_languages
        .as_deref()
        .unwrap_or("en")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .collect()
}

fn subtitle_language_matches(language: &str, requested: &[String]) -> bool {
    if requested.is_empty() || requested.iter().any(|value| value == "all" || value == "*") {
        return true;
    }
    let language = language.to_ascii_lowercase();
    requested.iter().any(|wanted| {
        language == *wanted
            || language
                .strip_prefix(wanted)
                .is_some_and(|suffix| suffix.starts_with('-'))
    })
}

fn safe_descriptor_info_json(
    descriptor: &MediaDescriptor,
    chapters: &[MediaChapter],
) -> Value {
    let streams = descriptor
        .streams
        .iter()
        .map(|stream| {
            serde_json::json!({
                "id": stream.id,
                "kind": stream.kind,
                "protocol": stream.protocol,
                "container": stream.container,
                "videoCodec": stream.video_codec,
                "audioCodec": stream.audio_codec,
                "width": stream.width,
                "height": stream.height,
                "fps": stream.fps,
                "bitrateBps": stream.bitrate_bps,
                "audioBitrateBps": stream.audio_bitrate_bps,
                "contentLength": stream.content_length,
                "language": stream.language,
            })
        })
        .collect::<Vec<_>>();
    let subtitles = descriptor
        .subtitles
        .iter()
        .map(|track| {
            serde_json::json!({
                "language": track.language,
                "name": track.name,
                "format": track.format,
                "automatic": track.automatic,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "schemaVersion": 1,
        "sourceKind": descriptor.source_kind,
        "isLive": descriptor.is_live,
        "metadata": {
            "title": descriptor.metadata.title,
            "description": descriptor.metadata.description,
            "durationMillis": descriptor.metadata.duration_millis,
            "uploader": descriptor.metadata.uploader,
            "webpageUrl": descriptor.metadata.webpage_url,
        },
        "streams": streams,
        "subtitles": subtitles,
        "chapters": chapters,
    })
}

fn sidecar_path(output_path: &Path, suffix: &str) -> PathBuf {
    let parent = output_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("nova-media");
    parent.join(format!("{stem}{suffix}"))
}

fn sidecar_extension_from_url(url: &str, fallback: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .and_then(|name| Path::new(name).extension())
                .and_then(|extension| extension.to_str())
                .map(|extension| safe_sidecar_component(extension, fallback))
        })
        .unwrap_or_else(|| fallback.to_owned())
}

fn safe_sidecar_component(value: &str, fallback: &str) -> String {
    let safe = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .take(32)
        .collect::<String>();
    if safe.is_empty() {
        fallback.to_owned()
    } else {
        safe
    }
}

fn write_atomic_sidecar(path: &Path, bytes: &[u8]) -> Result<(), NativeMediaTaskError> {
    let mut temp = path.as_os_str().to_os_string();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    let file = std::fs::File::open(&temp)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    file.sync_all()
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    drop(file);
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }
    std::fs::rename(&temp, path)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    Ok(())
}

fn separate_track_output_container(video: &MediaStream, audio: &MediaStream) -> String {
    let video_container = video
        .container
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let audio_container = audio
        .container
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    let mp4_video = matches!(video_container.as_str(), "mp4" | "m4v" | "mov");
    let mp4_audio = matches!(audio_container.as_str(), "mp4" | "m4a" | "aac");
    if mp4_video && mp4_audio {
        return "mp4".to_owned();
    }

    let webm_video = video_container == "webm";
    let webm_audio = matches!(audio_container.as_str(), "webm" | "opus" | "ogg");
    if webm_video && webm_audio {
        return "webm".to_owned();
    }

    "mkv".to_owned()
}

fn attach_native_chapters(
    resolved: &mut ResolvedNativeMedia,
    chapters: Vec<MediaChapter>,
) {
    match resolved {
        ResolvedNativeMedia::Direct(media) => media.chapters = chapters,
        ResolvedNativeMedia::Manifest(media) => media.chapters = chapters,
        ResolvedNativeMedia::SeparateTracks(media) => media.extraction.chapters = chapters,
    }
}

fn resolved_from_descriptor(
    descriptor: &MediaDescriptor,
    stream: &MediaStream,
) -> Result<ResolvedNativeMedia, NativeMediaTaskError> {
    match stream.protocol {
        MediaProtocol::Http | MediaProtocol::Https => {
            let context = descriptor
                .request_context_for_stream(stream)
                .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
            Ok(ResolvedNativeMedia::Direct(ResolvedDirectMedia {
                url: stream.url.clone(),
                title: descriptor.metadata.title.clone(),
                container: stream.container.clone(),
                content_length: stream.content_length,
                context,
                descriptor: descriptor.clone(),
                chapters: Vec::new(),
            }))
        }
        MediaProtocol::Hls | MediaProtocol::Dash => Ok(ResolvedNativeMedia::Manifest(
            ResolvedManifestMedia {
                descriptor: descriptor.clone(),
                stream: stream.clone(),
                chapters: Vec::new(),
            },
        )),
    }
}

#[derive(Default)]
struct ParsedNativeHeaders {
    generic: BTreeMap<String, String>,
    user_agent: Option<String>,
    referer: Option<String>,
    cookie: Option<String>,
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

    let options = body.media_options.as_ref();
    let parsed_headers = options
        .and_then(|options| options.headers.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_native_header_lines)
        .transpose()
        .map_err(NativeMediaTaskError::InvalidRequest)?
        .unwrap_or_default();

    let mut request = ExtractRequest::new(url);
    request.headers.extend(parsed_headers.generic);

    let user_agent = options
        .and_then(|options| options.user_agent.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or(parsed_headers.user_agent);
    if let Some(user_agent) = user_agent {
        request
            .headers
            .insert("User-Agent".to_owned(), user_agent);
    }

    let referer = options
        .and_then(|options| options.referer.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            body.referer
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .or(parsed_headers.referer);
    if let Some(referer) = referer {
        request.headers.insert("Referer".to_owned(), referer);
    }

    let mut cookie_headers = Vec::new();
    if let Some(cookies) = options
        .and_then(|options| options.cookies.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        cookie_headers.push(
            resolve_native_cookie_option(cookies, url)
                .map_err(NativeMediaTaskError::InvalidRequest)?,
        );
    }
    if let Some(source) = options
        .and_then(|options| options.cookies_from_browser.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        cookie_headers.push(
            load_browser_cookie_header(source, url)
                .map_err(NativeMediaTaskError::InvalidRequest)?,
        );
    }
    if let Some(cookie) = parsed_headers.cookie {
        cookie_headers.push(cookie);
    }
    if !cookie_headers.is_empty() {
        request
            .headers
            .insert("Cookie".to_owned(), cookie_headers.join("; "));
    }

    request
        .request_context()
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;
    Ok(request)
}

fn parse_native_header_lines(headers: &str) -> Result<ParsedNativeHeaders, String> {
    let mut parsed = ParsedNativeHeaders::default();
    for line in headers.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| format!("Invalid media header line: {line}"))?;
        let name = name.trim();
        let value = value.trim();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value.is_empty()
            || value
                .chars()
                .any(|character| matches!(character, '\r' | '\n' | '\0'))
        {
            return Err(format!("Invalid media header line: {line}"));
        }

        let normalized = name.to_ascii_lowercase();
        match normalized.as_str() {
            "host"
            | "content-length"
            | "transfer-encoding"
            | "range"
            | "if-range"
            | "accept-encoding"
            | "connection" => {
                return Err(format!(
                    "Media header '{name}' is owned by the native transport"
                ));
            }
            "user-agent" => set_unique_typed_header(
                &mut parsed.user_agent,
                value,
                "User-Agent",
            )?,
            "referer" => set_unique_typed_header(
                &mut parsed.referer,
                value,
                "Referer",
            )?,
            "cookie" => set_unique_typed_header(
                &mut parsed.cookie,
                value,
                "Cookie",
            )?,
            _ => {
                parsed.generic.insert(normalized, value.to_owned());
            }
        }
    }
    Ok(parsed)
}

fn set_unique_typed_header(
    slot: &mut Option<String>,
    value: &str,
    name: &str,
) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!(
            "Media header '{name}' was supplied more than once"
        ));
    }
    *slot = Some(value.to_owned());
    Ok(())
}

fn resolve_native_cookie_option(value: &str, target_url: &str) -> Result<String, String> {
    if !looks_like_cookie_file(value) {
        return Ok(value.to_owned());
    }
    load_native_cookie_file(Path::new(value), target_url)
}

fn looks_like_cookie_file(value: &str) -> bool {
    value.trim().to_ascii_lowercase().ends_with(".txt") || !value.contains('=')
}

fn load_native_cookie_file(path: &Path, target_url: &str) -> Result<String, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("Could not inspect cookie file '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Cookie path '{}' is not a regular file", path.display()));
    }
    if metadata.len() > NATIVE_COOKIE_FILE_MAX_BYTES {
        return Err(format!(
            "Cookie file '{}' exceeds the {} byte native limit",
            path.display(),
            NATIVE_COOKIE_FILE_MAX_BYTES
        ));
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("Could not read cookie file '{}': {error}", path.display()))?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| format!("Cookie file '{}' is not valid UTF-8", path.display()))?;
    let target = reqwest::Url::parse(target_url)
        .map_err(|_| "Invalid media URL while loading cookies".to_owned())?;
    let target_host = target
        .host_str()
        .ok_or_else(|| "Media URL has no host for cookie matching".to_owned())?
        .to_ascii_lowercase();
    let target_path = if target.path().is_empty() { "/" } else { target.path() };
    let is_https = target.scheme().eq_ignore_ascii_case("https");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);

    let mut cookies = Vec::new();
    for (line_number, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim_end_matches('\r').trim();
        if line.is_empty() || (line.starts_with('#') && !line.starts_with("#HttpOnly_")) {
            continue;
        }
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        let fields = line.splitn(7, '\t').collect::<Vec<_>>();
        if fields.len() != 7 {
            return Err(format!(
                "Malformed Netscape cookie at {}:{}",
                path.display(),
                line_number + 1
            ));
        }

        let raw_domain = fields[0].trim();
        let include_subdomains = fields[1].trim().eq_ignore_ascii_case("TRUE");
        let cookie_path = {
            let value = fields[2].trim();
            if value.is_empty() { "/" } else { value }
        };
        let secure = fields[3].trim().eq_ignore_ascii_case("TRUE");
        let expires = fields[4].trim().parse::<i64>().map_err(|_| {
            format!(
                "Invalid cookie expiry at {}:{}",
                path.display(),
                line_number + 1
            )
        })?;
        let name = fields[5].trim();
        let value = fields[6].trim();

        if name.is_empty()
            || name
                .bytes()
                .any(|byte| byte <= b' ' || matches!(byte, b';' | b',' | b'='))
            || value
                .chars()
                .any(|character| matches!(character, '\r' | '\n' | ';'))
        {
            return Err(format!(
                "Invalid cookie name/value at {}:{}",
                path.display(),
                line_number + 1
            ));
        }
        if expires > 0 && expires <= now {
            continue;
        }
        if secure && !is_https {
            continue;
        }
        if !cookie_domain_matches(&target_host, raw_domain, include_subdomains) {
            continue;
        }
        if !cookie_path_matches(target_path, cookie_path) {
            continue;
        }

        cookies.push(format!("{name}={value}"));
    }

    if cookies.is_empty() {
        return Err(format!(
            "Cookie file '{}' contains no cookies applicable to the media URL",
            path.display()
        ));
    }

    Ok(cookies.join("; "))
}

fn cookie_domain_matches(host: &str, cookie_domain: &str, include_subdomains: bool) -> bool {
    let domain = cookie_domain
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if domain.is_empty() {
        return false;
    }
    if host == domain {
        return true;
    }
    (include_subdomains || cookie_domain.trim_start().starts_with('.'))
        && host
            .strip_suffix(&domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn cookie_path_matches(target_path: &str, cookie_path: &str) -> bool {
    let cookie_path = if cookie_path.is_empty() { "/" } else { cookie_path };
    if target_path == cookie_path {
        return true;
    }
    if !target_path.starts_with(cookie_path) {
        return false;
    }
    cookie_path.ends_with('/')
        || target_path
            .as_bytes()
            .get(cookie_path.len())
            .is_some_and(|next| *next == b'/')
}

fn ensure_native_output_name(name: &str, extension: Option<&str>) -> String {
    let name = name.trim();
    let mut output = if name.is_empty() {
        "nova-media".to_owned()
    } else {
        name.to_owned()
    };
    let Some(extension) = extension
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return output;
    };

    let current_extension = Path::new(&output)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if current_extension
        .as_deref()
        .is_some_and(|value| matches!(value, "m3u8" | "mpd"))
    {
        let mut path = PathBuf::from(&output);
        path.set_extension(extension);
        return path.to_string_lossy().to_string();
    }
    if current_extension.is_none() {
        output.push('.');
        output.push_str(extension.trim_start_matches('.'));
    }
    output
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
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }

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
    fn request_context_precedence_prefers_explicit_media_fields() {
        let mut request = body("https://media.example.test/video.mp4");
        request.referer = Some("https://body.example/ref".to_owned());
        let media = request.media_options.as_mut().expect("media");
        media.user_agent = Some("NOVA-Explicit-UA".to_owned());
        media.referer = Some("https://media.example/ref".to_owned());
        media.cookies = Some("explicit=1".to_owned());
        media.headers = Some(
            "User-Agent: Raw-UA\nReferer: https://raw.example/ref\nCookie: raw=1\nAuthorization: Bearer token"
                .to_owned(),
        );

        let extract = build_extract_request(&request).expect("request context");
        let context = extract.request_context().expect("typed context");
        assert_eq!(context.user_agent.as_deref(), Some("NOVA-Explicit-UA"));
        assert_eq!(
            context.referer.as_deref(),
            Some("https://media.example/ref")
        );
        assert_eq!(context.cookie_header.as_deref(), Some("explicit=1; raw=1"));
        assert_eq!(
            context.headers.get("authorization").map(String::as_str),
            Some("Bearer token")
        );
    }

    #[test]
    fn raw_headers_supply_typed_context_when_explicit_fields_are_absent() {
        let mut request = body("https://media.example.test/video.mp4");
        let media = request.media_options.as_mut().expect("media");
        media.headers = Some(
            "User-Agent: Raw-UA\nReferer: https://raw.example/ref\nCookie: raw=1"
                .to_owned(),
        );

        let context = build_extract_request(&request)
            .expect("request")
            .request_context()
            .expect("typed context");
        assert_eq!(context.user_agent.as_deref(), Some("Raw-UA"));
        assert_eq!(
            context.referer.as_deref(),
            Some("https://raw.example/ref")
        );
        assert_eq!(context.cookie_header.as_deref(), Some("raw=1"));
    }

    #[test]
    fn transport_owned_headers_are_rejected_before_extraction() {
        let mut request = body("https://media.example.test/video.mp4");
        request.media_options.as_mut().expect("media").headers =
            Some("Range: bytes=0-99".to_owned());
        let error = build_extract_request(&request)
            .expect_err("Range must remain transport-owned");
        assert!(error.to_string().contains("owned by the native transport"));
    }

    #[test]
    fn duplicate_typed_headers_are_rejected_case_insensitively() {
        let mut request = body("https://media.example.test/video.mp4");
        request.media_options.as_mut().expect("media").headers =
            Some("Cookie: a=1\ncookie: b=2".to_owned());
        let error = build_extract_request(&request)
            .expect_err("duplicate Cookie headers must fail");
        assert!(error.to_string().contains("supplied more than once"));
    }

    #[test]
    fn manifest_urls_are_native_even_without_media_options() {
        let mut request = body("https://cdn.test/live.m3u8?token=abc");
        request.media_options = None;
        NativeMediaExtractor
            .validate(&request)
            .expect("manifest does not require explicit media options");
        assert!(NativeMediaExtractor.can_handle(
            "HTTPS://cdn.test/stream.mpd#fragment",
            false
        ));
        assert!(!NativeMediaExtractor.can_handle(
            "https://cdn.test/file.zip",
            false
        ));
    }

    #[test]
    fn ffmpeg_toggle_is_a_supported_native_execution_option() {
        let mut request = body("https://cdn.test/video.mp4");
        request.media_options.as_mut().expect("media").ffmpeg_enabled = Some(true);
        NativeMediaExtractor
            .validate(&request)
            .expect("ffmpeg toggle should be accepted by native task path");
        assert!(NATIVE_MEDIA_OPTION_KEYS.contains(&"ffmpegEnabled"));
    }

    #[test]
    fn separate_track_container_prefers_compatible_copy_mux() {
        use nova_media_core::MediaTrackKind;

        let mut video = MediaStream {
            id: "v".to_owned(),
            kind: MediaTrackKind::Video,
            protocol: MediaProtocol::Https,
            url: "https://cdn.test/v".to_owned(),
            container: Some("mp4".to_owned()),
            video_codec: Some("avc1".to_owned()),
            audio_codec: None,
            width: Some(1920),
            height: Some(1080),
            fps: Some(30),
            bitrate_bps: None,
            audio_bitrate_bps: None,
            content_length: Some(100),
            language: None,
            headers: BTreeMap::new(),
        };
        let mut audio = MediaStream {
            id: "a".to_owned(),
            kind: MediaTrackKind::Audio,
            protocol: MediaProtocol::Https,
            url: "https://cdn.test/a".to_owned(),
            container: Some("m4a".to_owned()),
            video_codec: None,
            audio_codec: Some("mp4a".to_owned()),
            width: None,
            height: None,
            fps: None,
            bitrate_bps: None,
            audio_bitrate_bps: Some(128_000),
            content_length: Some(20),
            language: None,
            headers: BTreeMap::new(),
        };
        assert_eq!(separate_track_output_container(&video, &audio), "mp4");

        video.container = Some("webm".to_owned());
        audio.container = Some("webm".to_owned());
        assert_eq!(separate_track_output_container(&video, &audio), "webm");

        video.container = Some("mp4".to_owned());
        audio.container = Some("webm".to_owned());
        assert_eq!(separate_track_output_container(&video, &audio), "mkv");
    }

    #[test]
    fn native_audio_mode_accepts_source_container_selection() {
        let mut request = body("https://cdn.test/audio");
        let media = request.media_options.as_mut().expect("media");
        media.mode = Some("audio".to_owned());
        media.audio_format = Some("m4a".to_owned());
        media.format_sort = Some("br,size,codec::m4a".to_owned());
        NativeMediaExtractor
            .validate(&request)
            .expect("native audio selection options");
    }

    #[test]
    fn native_audio_mode_rejects_transcoding_only_format() {
        let mut request = body("https://cdn.test/audio");
        let media = request.media_options.as_mut().expect("media");
        media.mode = Some("audio".to_owned());
        media.audio_format = Some("mp3".to_owned());
        let error = NativeMediaExtractor
            .validate(&request)
            .expect_err("mp3 requires transcoding");
        assert!(error.0.contains("requires transcoding"));
    }

    #[test]
    fn audio_format_is_not_silently_ignored_in_video_mode() {
        let mut request = body("https://cdn.test/video");
        request.media_options.as_mut().expect("media").audio_format =
            Some("m4a".to_owned());
        let error = NativeMediaExtractor
            .validate(&request)
            .expect_err("audioFormat must be meaningful");
        assert!(error.0.contains("mode 'audio'"));
    }

    #[test]
    fn native_format_sort_rejects_unknown_tokens() {
        let mut request = body("https://cdn.test/video");
        request.media_options.as_mut().expect("media").format_sort =
            Some("res,unknown-key".to_owned());
        assert!(NativeMediaExtractor.validate(&request).is_err());
    }

    #[test]
    fn native_remux_policy_accepts_same_container_and_rejects_conversion() {
        let stream = MediaStream {
            id: "v".to_owned(),
            kind: nova_media_core::MediaTrackKind::AudioVideo,
            protocol: MediaProtocol::Https,
            url: "https://cdn.test/v.mp4".to_owned(),
            container: Some("mp4".to_owned()),
            video_codec: Some("avc1".to_owned()),
            audio_codec: Some("mp4a".to_owned()),
            width: Some(1280),
            height: Some(720),
            fps: Some(30.0),
            bitrate_bps: Some(1_000_000),
            audio_bitrate_bps: Some(128_000),
            content_length: Some(100),
            language: None,
            headers: BTreeMap::new(),
        };
        let mut options = MediaDownloadOptions::default();
        options.remux_format = Some("mp4".to_owned());
        ensure_native_remux_policy(&stream, Some(&options)).expect("same container");

        options.remux_format = Some("webm".to_owned());
        assert!(matches!(
            ensure_native_remux_policy(&stream, Some(&options)),
            Err(NativeMediaTaskError::UnsupportedFeature(_))
        ));
    }

    #[test]
    fn separate_tracks_can_copy_mux_to_mkv_policy() {
        let mut options = MediaDownloadOptions::default();
        options.remux_format = Some("mkv".to_owned());
        assert_eq!(
            requested_separate_track_container("mp4", Some(&options)).expect("mkv copy mux"),
            "mkv"
        );
    }

    #[test]
    fn native_output_names_append_container_and_replace_manifest_suffixes() {
        assert_eq!(
            ensure_native_output_name("Example title", Some("mp4")),
            "Example title.mp4"
        );
        assert_eq!(
            ensure_native_output_name("master.m3u8", Some("ts")),
            "master.ts"
        );
        assert_eq!(
            ensure_native_output_name("stream.mpd", Some("mp4")),
            "stream.mp4"
        );
        assert_eq!(
            ensure_native_output_name("custom.webm", Some("mp4")),
            "custom.webm"
        );
    }

    #[test]
    fn standard_video_options_use_native_path() {
        let body = body("https://cdn.test/video.mp4");
        NativeMediaExtractor
            .validate(&body)
            .expect("standard native options");
    }

    #[test]
    fn subtitle_embedding_is_advertised_but_thumbnail_embedding_remains_fail_closed() {
        let mut body = body("https://cdn.test/video.mp4");
        body.media_options.as_mut().expect("media").embed_subtitles = Some(true);
        NativeMediaExtractor
            .validate(&body)
            .expect("subtitle embedding should be accepted by native validation");
        assert!(NATIVE_MEDIA_OPTION_KEYS.contains(&"embedSubtitles"));

        body.media_options.as_mut().expect("media").embed_thumbnail = Some(true);
        assert!(NativeMediaExtractor.validate(&body).is_err());
    }

    #[test]
    fn native_embedding_accepts_only_text_subtitle_formats() {
        for format in ["vtt", "SRT", "ass", "ssa"] {
            assert!(is_embeddable_subtitle_format(format));
        }
        for format in ["json3", "srv3", "ttml", "bin"] {
            assert!(!is_embeddable_subtitle_format(format));
        }
    }

    #[test]
    fn unimplemented_execution_option_is_not_advertised_or_accepted() {
        assert!(!NATIVE_MEDIA_OPTION_KEYS.contains(&"splitChapters"));
        let mut body = body("https://cdn.test/video.mp4");
        body.media_options.as_mut().expect("media").split_chapters = Some(true);
        assert!(NativeMediaExtractor.validate(&body).is_err());
    }

    #[test]
    fn native_browser_cookie_option_advertises_firefox_and_fails_closed_elsewhere() {
        assert!(NATIVE_MEDIA_OPTION_KEYS.contains(&"cookiesFromBrowser"));

        let mut request = body("https://media.example.test/video");
        request
            .media_options
            .as_mut()
            .expect("media")
            .cookies_from_browser = Some("firefox".to_owned());
        NativeMediaExtractor
            .validate(&request)
            .expect("Firefox browser-cookie import should validate");

        request
            .media_options
            .as_mut()
            .expect("media")
            .cookies_from_browser = Some("chrome".to_owned());
        let error = NativeMediaExtractor
            .validate(&request)
            .expect_err("unmigrated Chromium decryption must fail closed");
        assert!(error.0.contains("Firefox only"));
    }

    #[test]
    fn native_cookie_file_scopes_entries_to_target_url() {
        let dir = unique_temp_dir("nova-native-cookie-file");
        std::fs::create_dir_all(&dir).expect("cookie temp dir");
        let cookie_path = dir.join("cookies.txt");
        std::fs::write(
            &cookie_path,
            concat!(
                "# Netscape HTTP Cookie File\n",
                ".example.test\tTRUE\t/private\tTRUE\t0\tsession\tsecret\n",
                ".example.test\tTRUE\t/\tFALSE\t0\tpref\twide\n",
                ".example.test\tTRUE\t/admin\tFALSE\t0\tadmin\thidden\n",
                ".other.test\tTRUE\t/\tFALSE\t0\tother\tignored\n",
            ),
        )
        .expect("write cookie file");

        let mut request = body("https://media.example.test/private/video");
        request.media_options.as_mut().expect("media").cookies =
            Some(cookie_path.to_string_lossy().into_owned());
        NativeMediaExtractor
            .validate(&request)
            .expect("cookie file option should validate");
        let extract = build_extract_request(&request).expect("cookie-backed extract request");
        let context = extract.request_context().expect("cookie request context");
        assert_eq!(
            context.cookie_header.as_deref(),
            Some("session=secret; pref=wide")
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_cookie_path_matching_respects_segment_boundaries() {
        assert!(cookie_path_matches("/private", "/private"));
        assert!(cookie_path_matches("/private/video", "/private"));
        assert!(cookie_path_matches("/private/video", "/private/"));
        assert!(cookie_path_matches("/anything", "/"));
        assert!(!cookie_path_matches("/private-video", "/private"));
        assert!(!cookie_path_matches("/public", "/private"));
    }

    #[test]
    fn native_cookie_file_rejects_malformed_netscape_rows() {
        let dir = unique_temp_dir("nova-native-cookie-file-invalid");
        std::fs::create_dir_all(&dir).expect("cookie temp dir");
        let cookie_path = dir.join("cookies.txt");
        std::fs::write(&cookie_path, "not-a-netscape-cookie-row\n").expect("write cookie file");

        let mut request = body("https://media.example.test/video");
        request.media_options.as_mut().expect("media").cookies =
            Some(cookie_path.to_string_lossy().into_owned());
        let error = build_extract_request(&request).expect_err("malformed cookie file must fail");
        assert!(error.to_string().contains("Malformed Netscape cookie"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn metadata_sidecar_excludes_transport_secrets_and_stream_urls() {
        let mut request_headers = BTreeMap::new();
        request_headers.insert("Cookie".to_owned(), "session=secret-cookie".to_owned());
        let mut stream_headers = BTreeMap::new();
        stream_headers.insert("Authorization".to_owned(), "Bearer secret-header".to_owned());
        let descriptor = MediaDescriptor {
            source_kind: nova_media_core::MediaSourceKind::Site,
            metadata: nova_media_core::MediaMetadata {
                title: "Safe metadata".to_owned(),
                description: Some("description".to_owned()),
                duration_millis: Some(1_000),
                uploader: Some("uploader".to_owned()),
                webpage_url: "https://media.test/watch".to_owned(),
                thumbnail_url: Some(
                    "https://cdn.test/thumb.jpg?token=secret-thumbnail".to_owned(),
                ),
            },
            streams: vec![MediaStream {
                id: "stream".to_owned(),
                kind: nova_media_core::MediaTrackKind::AudioVideo,
                protocol: MediaProtocol::Https,
                url: "https://cdn.test/video.mp4?token=secret-stream".to_owned(),
                container: Some("mp4".to_owned()),
                video_codec: Some("avc1".to_owned()),
                audio_codec: Some("mp4a".to_owned()),
                width: Some(1920),
                height: Some(1080),
                fps: Some(30.0),
                bitrate_bps: Some(4_000_000),
                audio_bitrate_bps: Some(128_000),
                content_length: Some(10),
                language: None,
                headers: stream_headers,
            }],
            subtitles: vec![nova_media_core::SubtitleTrack {
                language: "en".to_owned(),
                name: Some("English".to_owned()),
                url: "https://cdn.test/subtitle?token=secret-subtitle".to_owned(),
                format: Some("vtt".to_owned()),
                automatic: false,
            }],
            request_headers,
            is_live: false,
        };

        let serialized =
            serde_json::to_string(&safe_descriptor_info_json(&descriptor, &[]))
                .expect("metadata json");
        assert!(serialized.contains("Safe metadata"));
        assert!(!serialized.contains("secret-cookie"));
        assert!(!serialized.contains("secret-header"));
        assert!(!serialized.contains("secret-stream"));
        assert!(!serialized.contains("secret-subtitle"));
        assert!(!serialized.contains("secret-thumbnail"));
    }

    #[test]
    fn subtitle_language_filter_supports_exact_prefix_and_all() {
        assert!(subtitle_language_matches("en-US", &["en".to_owned()]));
        assert!(!subtitle_language_matches("ar", &["en".to_owned()]));
        assert!(subtitle_language_matches("ar", &["all".to_owned()]));
    }

    #[test]
    fn generic_direct_media_resolves_without_network_probe() {
        let resolved = resolve_native_media(&body("https://cdn.test/movie.mp4"))
            .expect("native direct resolution");
        let ResolvedNativeMedia::Direct(resolved) = resolved else {
            panic!("expected direct media");
        };
        assert_eq!(resolved.url, "https://cdn.test/movie.mp4");
        assert_eq!(resolved.container.as_deref(), Some("mp4"));
    }

    #[test]
    fn generic_hls_url_resolves_to_manifest_execution() {
        let resolved = resolve_native_media(&body("https://cdn.test/master.m3u8"))
            .expect("native HLS resolution");
        assert!(matches!(
            resolved,
            ResolvedNativeMedia::Manifest(ResolvedManifestMedia {
                stream: MediaStream {
                    protocol: MediaProtocol::Hls,
                    ..
                },
                ..
            })
        ));
    }

    #[test]
    fn generic_dash_url_resolves_to_manifest_execution() {
        let resolved = resolve_native_media(&body("https://cdn.test/stream.mpd"))
            .expect("native DASH resolution");
        assert!(matches!(
            resolved,
            ResolvedNativeMedia::Manifest(ResolvedManifestMedia {
                stream: MediaStream {
                    protocol: MediaProtocol::Dash,
                    ..
                },
                ..
            })
        ));
    }

    #[test]
    fn manifest_default_name_replaces_manifest_extension() {
        let mut path = PathBuf::from("master.m3u8");
        path.set_extension("ts");
        assert_eq!(path.to_string_lossy(), "master.ts");

        let mut path = PathBuf::from("stream.mpd");
        path.set_extension("mp4");
        assert_eq!(path.to_string_lossy(), "stream.mp4");
    }

    #[test]
    fn native_hls_wrapper_follows_master_and_stages_media() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind HLS wrapper server");
        let address = listener.local_addr().expect("HLS address");
        let server = std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("accept HLS wrapper request");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("read HLS wrapper request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body: Vec<u8> = if request.contains("GET /master.m3u8 ") {
                    format!(
                        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nhttp://{address}/media.m3u8\n"
                    )
                    .into_bytes()
                } else if request.contains("GET /media.m3u8 ") {
                    format!(
                        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://{address}/1.ts\n#EXTINF:2,\nhttp://{address}/2.ts\n#EXT-X-ENDLIST\n"
                    )
                    .into_bytes()
                } else if request.contains("GET /1.ts ") {
                    b"AAA".to_vec()
                } else if request.contains("GET /2.ts ") {
                    b"BBBB".to_vec()
                } else {
                    panic!("unexpected HLS wrapper request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write HLS wrapper response");
            }
        });

        let dir = unique_temp_dir("nova-native-hls-wrapper");
        let progress = std::sync::Mutex::new(Vec::new());
        let (parts, bytes) = stage_hls_stream(
            &format!("http://{address}/master.m3u8"),
            &HttpRequestContext::default(),
            &dir,
            2,
            &|| false,
            &|value| progress.lock().expect("progress").push(value),
        )
        .expect("stage native HLS wrapper");
        server.join().expect("HLS wrapper server");

        assert_eq!(bytes, 7);
        assert_eq!(parts.len(), 2);
        assert_eq!(
            progress.lock().expect("progress").last().copied(),
            Some(7)
        );
        let output = dir.join("assembled.ts");
        let assembled = assemble_ordered_parts(&parts, &output).expect("assemble HLS wrapper");
        assert_eq!(assembled.bytes, 7);
        assert_eq!(std::fs::read(&output).expect("HLS output"), b"AAABBBB");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_dash_wrapper_selects_and_stages_static_representation() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind DASH wrapper server");
        let address = listener.local_addr().expect("DASH address");
        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept DASH wrapper request");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("read DASH wrapper request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body: Vec<u8> = if request.contains("GET /stream.mpd ") {
                    b"<MPD mediaPresentationDuration=\"PT2S\"><Period><AdaptationSet contentType=\"video\"><SegmentTemplate timescale=\"1\" duration=\"2\" startNumber=\"1\" initialization=\"init.mp4\" media=\"$Number$.m4s\"/><Representation id=\"v1\" bandwidth=\"1000\" width=\"640\" height=\"360\"/></AdaptationSet></Period></MPD>".to_vec()
                } else if request.contains("GET /init.mp4 ") {
                    b"INIT".to_vec()
                } else if request.contains("GET /1.m4s ") {
                    b"MEDIA".to_vec()
                } else {
                    panic!("unexpected DASH wrapper request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write DASH wrapper response");
            }
        });

        let dir = unique_temp_dir("nova-native-dash-wrapper");
        let progress = std::sync::Mutex::new(Vec::new());
        let (parts, bytes) = stage_dash_stream(
            &format!("http://{address}/stream.mpd"),
            &HttpRequestContext::default(),
            &dir,
            2,
            &|| false,
            &|value| progress.lock().expect("progress").push(value),
        )
        .expect("stage native DASH wrapper");
        server.join().expect("DASH wrapper server");

        assert_eq!(bytes, 9);
        assert_eq!(parts.len(), 2);
        assert_eq!(
            progress.lock().expect("progress").last().copied(),
            Some(9)
        );
        let output = dir.join("assembled.mp4");
        let assembled = assemble_ordered_parts(&parts, &output).expect("assemble DASH wrapper");
        assert_eq!(assembled.bytes, 9);
        assert_eq!(std::fs::read(&output).expect("DASH output"), b"INITMEDIA");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_hls_live_refresh_records_only_new_segments_and_finishes() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind live HLS task server");
        let address = listener.local_addr().expect("live HLS task address");
        let manifest_hits = Arc::new(AtomicU64::new(0));
        let server_hits = manifest_hits.clone();

        let server = std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("accept live HLS task request");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("read live HLS task request");
                let request = String::from_utf8_lossy(&request[..read]);

                let body: Vec<u8> = if request.contains("GET /live.m3u8 ") {
                    let hit = server_hits.fetch_add(1, Ordering::AcqRel);
                    if hit == 0 {
                        format!(
                            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://{address}/7.ts\n"
                        )
                        .into_bytes()
                    } else {
                        format!(
                            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://{address}/7.ts\n#EXTINF:1,\nhttp://{address}/8.ts\n#EXT-X-ENDLIST\n"
                        )
                        .into_bytes()
                    }
                } else if request.contains("GET /7.ts ") {
                    b"SEVEN".to_vec()
                } else if request.contains("GET /8.ts ") {
                    b"EIGHT".to_vec()
                } else {
                    panic!("unexpected live HLS task request: {request}");
                };

                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write live HLS task response");
            }
        });

        let first = fetch_http_bytes_with_context(
            &format!("http://{address}/live.m3u8"),
            &HttpRequestContext::default(),
            DEFAULT_MANIFEST_MAX_BYTES,
        )
        .expect("initial live HLS manifest");
        let first_body = String::from_utf8(first.body).expect("live HLS UTF-8");
        let first_manifest = parse_hls(&first.effective_url, &first_body).expect("live HLS parse");
        let dir = unique_temp_dir("nova-native-hls-live-task");
        let progress = std::sync::Mutex::new(Vec::new());

        let (parts, bytes) = stage_hls_live_stream(
            &first.effective_url,
            first_manifest,
            &HttpRequestContext::default(),
            &dir,
            2,
            &|| false,
            &|value| progress.lock().expect("progress").push(value),
        )
        .expect("record live HLS");
        server.join().expect("live HLS server");

        assert_eq!(bytes, 10);
        assert_eq!(parts.len(), 2);
        assert_eq!(
            progress.lock().expect("progress").last().copied(),
            Some(10)
        );
        let checkpoint: HlsLiveTaskCheckpoint =
            read_live_checkpoint(&dir.join("hls-live-checkpoint.json"))
                .expect("live HLS checkpoint");
        assert_eq!(checkpoint.cursor.next_sequence, Some(9));
        assert_eq!(checkpoint.next_order, 2);

        let output = dir.join("live.ts");
        assemble_ordered_parts(&parts, &output).expect("assemble live HLS");
        assert_eq!(std::fs::read(&output).expect("live HLS output"), b"SEVENEIGHT");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_dynamic_dash_keeps_committed_snapshot_when_cancelled() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind dynamic DASH task server");
        let address = listener.local_addr().expect("dynamic DASH task address");

        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().expect("accept dynamic DASH task request");
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).expect("read dynamic DASH task request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body: Vec<u8> = if request.contains("GET /live.mpd ") {
                    b"<MPD type=\"dynamic\" minimumUpdatePeriod=\"PT1S\"><Period><AdaptationSet contentType=\"video\"><SegmentTemplate timescale=\"1\" initialization=\"init.mp4\" media=\"$Time$.m4s\"><SegmentTimeline><S t=\"10\" d=\"2\"/></SegmentTimeline></SegmentTemplate><Representation id=\"v1\" bandwidth=\"1000\" width=\"640\" height=\"360\"/></AdaptationSet></Period></MPD>".to_vec()
                } else if request.contains("GET /init.mp4 ") {
                    b"INIT".to_vec()
                } else if request.contains("GET /10.m4s ") {
                    b"MEDIA".to_vec()
                } else {
                    panic!("unexpected dynamic DASH task request: {request}");
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .and_then(|_| stream.write_all(&body))
                    .expect("write dynamic DASH task response");
            }
        });

        let first = fetch_http_bytes_with_context(
            &format!("http://{address}/live.mpd"),
            &HttpRequestContext::default(),
            DEFAULT_MANIFEST_MAX_BYTES,
        )
        .expect("initial dynamic DASH manifest");
        let body = String::from_utf8(first.body).expect("dynamic DASH UTF-8");
        let manifest = parse_dash(&body).expect("dynamic DASH parse");
        let (period, adaptation, representation) =
            best_dash_representation_indices(&manifest).expect("DASH representation");
        let dir = unique_temp_dir("nova-native-dash-live-task");
        let cancelled = AtomicBool::new(false);

        let result = stage_dash_live_stream(
            &first.effective_url,
            manifest,
            period,
            adaptation,
            representation,
            &HttpRequestContext::default(),
            &dir,
            2,
            &|| cancelled.load(Ordering::Acquire),
            &|bytes| {
                if bytes >= 9 {
                    cancelled.store(true, Ordering::Release);
                }
            },
        );
        server.join().expect("dynamic DASH server");
        assert!(matches!(result, Err(NativeMediaTaskError::Transfer(_))));

        let checkpoint: DashLiveTaskCheckpoint =
            read_live_checkpoint(&dir.join("dash-live-checkpoint.json"))
                .expect("dynamic DASH checkpoint");
        assert_eq!(checkpoint.cursor.last_time, Some(10));
        assert_eq!(checkpoint.total_bytes, 9);

        let parts = committed_live_parts(&dir).expect("committed dynamic DASH parts");
        assert_eq!(parts.len(), 2);
        let output = dir.join("live.mp4");
        assemble_ordered_parts(&parts, &output).expect("assemble dynamic DASH snapshot");
        assert_eq!(std::fs::read(&output).expect("dynamic DASH output"), b"INITMEDIA");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_mp4_mux_is_available_without_host_postprocessing() {
        assert!(native_mux_supports_container("mp4"));
        assert!(native_mux_supports_container("MP4"));
        assert!(!native_mux_supports_container("webm"));
        assert!(!native_mux_supports_container("mkv"));
    }

    #[test]
    fn native_manifest_task_capabilities_remain_separate_from_multitrack_mux() {
        let capabilities = nova_media_core::native_media_core_capabilities();
        assert!(capabilities.hls_staging);
        assert!(capabilities.hls_live_refresh);
        assert!(capabilities.dash_staging);
        assert!(capabilities.dash_live_refresh);
        assert!(capabilities.separate_track_staging);
    }

    #[test]
    fn parses_common_quality_limits() {
        assert_eq!(parse_quality_height("1080p"), Some(1080));
        assert_eq!(parse_quality_height("4k"), Some(2160));
        assert_eq!(parse_quality_height("best"), None);
    }
}
