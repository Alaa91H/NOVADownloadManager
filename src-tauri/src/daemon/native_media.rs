use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use nova_download_core::{fetch_http_bytes_with_context, HttpRequestContext};
use nova_media_core::{
    assemble_ordered_parts, resolve_youtube_pending_formats, select_youtube_download_plan,
    stage_dash_representation_plan_controlled_with_progress,
    stage_hls_media_plan_controlled_with_progress, youtube_video_id, ExtractRequest,
    MediaDescriptor, MediaProtocol, MediaStream, YouTubeDownloadPlan, YouTubeExtractor,
    YouTubePlayerScriptSolver, YouTubeSelectionPolicy, DEFAULT_MANIFEST_MAX_BYTES,
};
use nova_stream_core::{
    build_dash_representation_plan, build_hls_media_plan, parse_dash, parse_hls,
    select_best_hls_variant, DashManifest, HlsPlaylistKind,
};
use serde_json::Value;
use uuid::Uuid;

use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};
use crate::daemon::state::SharedState;
use crate::daemon::types::{
    transition_task_state, CreateDownloadBody, MediaDownloadOptions, NativeMediaJob, Task,
    TaskState,
};

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

#[derive(Debug)]
struct ResolvedDirectMedia {
    url: String,
    title: String,
    container: Option<String>,
    content_length: Option<u64>,
    context: HttpRequestContext,
}

#[derive(Clone, Debug)]
struct ResolvedManifestMedia {
    descriptor: MediaDescriptor,
    stream: MediaStream,
}

#[derive(Debug)]
enum ResolvedNativeMedia {
    Direct(ResolvedDirectMedia),
    Manifest(ResolvedManifestMedia),
}

pub async fn create_native_media_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, NativeMediaTaskError> {
    let owned = body.clone();
    let resolved = tokio::task::spawn_blocking(move || resolve_native_media(&owned))
        .await
        .map_err(|error| NativeMediaTaskError::Worker(error.to_string()))??;

    match resolved {
        ResolvedNativeMedia::Direct(resolved) => {
            create_native_direct_task(state, body, resolved).await
        }
        ResolvedNativeMedia::Manifest(resolved) => {
            create_native_manifest_task(state, body, resolved)
        }
    }
}

async fn create_native_direct_task(
    state: &SharedState,
    body: &CreateDownloadBody,
    resolved: ResolvedDirectMedia,
) -> Result<Task, NativeMediaTaskError> {
    let mut direct = body.clone();
    direct.url = Some(resolved.url);
    direct.media_options = None;
    if direct.name.as_deref().is_none_or(|name| name.trim().is_empty()) {
        direct.name = Some(resolved.title);
    }
    if direct.file_type.as_deref().is_none_or(|kind| kind.trim().is_empty()) {
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
    if task_body.name.as_deref().is_none_or(|name| name.trim().is_empty()) {
        let mut title = resolved.descriptor.metadata.title.trim().to_owned();
        if title.is_empty() {
            title = format!("nova-{protocol}-media");
        }
        if Path::new(&title).extension().is_none() {
            title.push('.');
            title.push_str(extension);
        }
        task_body.name = Some(title);
    }
    if task_body.file_type.as_deref().is_none_or(|kind| kind.trim().is_empty()) {
        task_body.file_type = Some(extension.to_owned());
    }

    let source_url = body.url.as_deref().unwrap_or_default();
    let (name, output_path) = crate::daemon::curl::destination_from_body(&task_body, source_url);
    if let Some(parent) = output_path.parent().filter(|path| !path.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    }

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
        resumable: true,
        save_path: output_path.to_string_lossy().to_string(),
        description: body
            .description
            .clone()
            .unwrap_or_else(|| format!("Native {protocol.to_ascii_uppercase()} media transfer")),
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
        ))
    };

    let Some((generation, cancel_token, run_generation, request, task)) = prepared else {
        return;
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.mark_dirty();

    let state = state.clone();
    let id = id.to_owned();
    std::thread::spawn(move || {
        run_native_manifest_worker(
            state,
            id,
            generation,
            cancel_token,
            run_generation,
            request,
        );
    });
}

fn run_native_manifest_worker(
    state: SharedState,
    id: String,
    generation: u64,
    cancel_token: Arc<AtomicBool>,
    run_generation: Arc<AtomicU64>,
    request: CreateDownloadBody,
) {
    let still_current = || run_generation.load(Ordering::Acquire) == generation;
    let cancelled = || cancel_token.load(Ordering::Acquire) || !still_current();

    if cancelled() {
        finish_native_cancelled(&state, &id, generation);
        return;
    }
    if let Err(error) =
        transition_native_task(&state, &id, generation, TaskState::Probing, "resolving-manifest")
    {
        fail_native_task(&state, &id, generation, error);
        return;
    }

    let resolved = match resolve_native_media(&request) {
        Ok(ResolvedNativeMedia::Manifest(manifest)) => manifest,
        Ok(ResolvedNativeMedia::Direct(_)) => {
            fail_native_task(
                &state,
                &id,
                generation,
                "media source changed from manifest to direct transport".to_owned(),
            );
            return;
        }
        Err(error) => {
            fail_native_task(&state, &id, generation, error.to_string());
            return;
        }
    };

    if cancelled() {
        finish_native_cancelled(&state, &id, generation);
        return;
    }
    if let Err(error) =
        transition_native_task(&state, &id, generation, TaskState::Downloading, "downloading")
    {
        fail_native_task(&state, &id, generation, error);
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
        .join(format!("generation-{generation}"));
    let _ = std::fs::remove_dir_all(&staging_dir);

    let progress_state = state.clone();
    let progress_id = id.clone();
    let progress = |bytes: u64| {
        update_native_progress(&progress_state, &progress_id, generation, bytes);
    };

    let result = execute_manifest_transfer(
        &resolved,
        &staging_dir,
        &output_path,
        connections,
        &cancelled,
        &progress,
    );

    match result {
        Ok(bytes) => {
            if cancelled() {
                finish_native_cancelled(&state, &id, generation);
                return;
            }
            update_native_progress(&state, &id, generation, bytes);
            if let Err(error) = transition_native_task(
                &state,
                &id,
                generation,
                TaskState::Verifying,
                "verifying-staged-media",
            ) {
                fail_native_task(&state, &id, generation, error);
                return;
            }
            if let Err(error) = transition_native_task(
                &state,
                &id,
                generation,
                TaskState::Finalizing,
                "finalizing-media",
            ) {
                fail_native_task(&state, &id, generation, error);
                return;
            }
            complete_native_task(&state, &id, generation, bytes);
            let _ = std::fs::remove_dir_all(&staging_dir);
        }
        Err(error) if cancelled() => finish_native_cancelled(&state, &id, generation),
        Err(error) => fail_native_task(&state, &id, generation, error.to_string()),
    }
}

fn execute_manifest_transfer<F, P>(
    resolved: &ResolvedManifestMedia,
    staging_dir: &Path,
    output_path: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<u64, NativeMediaTaskError>
where
    F: Fn() -> bool + Sync,
    P: Fn(u64) + Sync,
{
    let context = resolved
        .descriptor
        .request_context_for_stream(&resolved.stream)
        .map_err(|error| NativeMediaTaskError::InvalidRequest(error.to_string()))?;

    let parts = match resolved.stream.protocol {
        MediaProtocol::Hls => stage_hls_stream(
            &resolved.stream.url,
            &context,
            staging_dir,
            connections,
            should_cancel,
            on_progress,
        )?,
        MediaProtocol::Dash => stage_dash_stream(
            &resolved.stream.url,
            &context,
            staging_dir,
            connections,
            should_cancel,
            on_progress,
        )?,
        MediaProtocol::Http | MediaProtocol::Https => {
            return Err(NativeMediaTaskError::UnsupportedFeature(
                "direct stream reached manifest executor".to_owned(),
            ));
        }
    };

    if should_cancel() {
        return Err(NativeMediaTaskError::Transfer(
            "native manifest staging was cancelled".to_owned(),
        ));
    }
    let assembly = assemble_ordered_parts(&parts, output_path)
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    Ok(assembly.bytes)
}

fn stage_hls_stream<F, P>(
    manifest_url: &str,
    context: &HttpRequestContext,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<Vec<(u64, PathBuf)>, NativeMediaTaskError>
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
        .map_err(|_| NativeMediaTaskError::Resolution("HLS manifest is not UTF-8".to_owned()))?;
    let mut manifest = parse_hls(&response.effective_url, &body)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;

    if manifest.kind == HlsPlaylistKind::Master {
        let variant = select_best_hls_variant(&manifest)
            .ok_or_else(|| NativeMediaTaskError::Resolution("HLS master has no variants".to_owned()))?;
        let response = fetch_http_bytes_with_context(
            &variant.uri,
            context,
            DEFAULT_MANIFEST_MAX_BYTES,
        )
        .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
        let body = String::from_utf8(response.body)
            .map_err(|_| NativeMediaTaskError::Resolution("HLS media playlist is not UTF-8".to_owned()))?;
        manifest = parse_hls(&response.effective_url, &body)
            .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    }

    if !manifest.end_list {
        return Err(NativeMediaTaskError::UnsupportedFeature(
            "live HLS scheduling is not connected to the task lifecycle yet".to_owned(),
        ));
    }
    let plan = build_hls_media_plan(&manifest)
        .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let staged = stage_hls_media_plan_controlled_with_progress(
        &plan,
        context,
        staging_dir,
        connections,
        || should_cancel(),
        |bytes| on_progress(bytes),
    )
    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    Ok(staged
        .files
        .into_iter()
        .map(|file| (file.order, file.path))
        .collect())
}

fn stage_dash_stream<F, P>(
    manifest_url: &str,
    context: &HttpRequestContext,
    staging_dir: &Path,
    connections: u32,
    should_cancel: &F,
    on_progress: &P,
) -> Result<Vec<(u64, PathBuf)>, NativeMediaTaskError>
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
    if manifest.is_dynamic {
        return Err(NativeMediaTaskError::UnsupportedFeature(
            "dynamic DASH scheduling is not connected to the task lifecycle yet".to_owned(),
        ));
    }
    let (period, adaptation, representation) = best_dash_representation_indices(&manifest)
        .ok_or_else(|| NativeMediaTaskError::Resolution("DASH manifest has no representations".to_owned()))?;
    let plan = build_dash_representation_plan(
        &manifest,
        &response.effective_url,
        period,
        adaptation,
        representation,
    )
    .map_err(|error| NativeMediaTaskError::Resolution(error.to_string()))?;
    let staged = stage_dash_representation_plan_controlled_with_progress(
        &plan,
        context,
        staging_dir,
        connections,
        || should_cancel(),
        |bytes| on_progress(bytes),
    )
    .map_err(|error| NativeMediaTaskError::Transfer(error.to_string()))?;
    Ok(staged
        .files
        .into_iter()
        .map(|file| (file.order, file.path))
        .collect())
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
                if best.as_ref().is_none_or(|(current, _)| score > *current) {
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

fn finish_native_cancelled(state: &SharedState, id: &str, generation: u64) {
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
    state.mark_dirty();
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
    state.mark_dirty();
}

fn complete_native_task(state: &SharedState, id: &str, generation: u64, bytes: u64) {
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
        job.task.size_bytes = bytes;
        job.task.downloaded_bytes = bytes;
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.error_message = None;
        if transition_task_state(&mut job.task, TaskState::Completed, "completed").is_err() {
            return;
        }
        job.task.clone()
    };
    if let Ok(mut snapshot) = state.task_snapshot.lock() {
        snapshot.insert(id.to_owned(), task);
    }
    state.mark_dirty();
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

        let prefer_separate_tracks = body
            .media_options
            .as_ref()
            .and_then(|options| options.ffmpeg_enabled)
            .unwrap_or(false);
        let plan = select_youtube_download_plan(
            &extraction,
            YouTubeSelectionPolicy {
                max_height,
                prefer_separate_tracks,
            },
        )
        .ok_or_else(|| {
            NativeMediaTaskError::UnsupportedFeature(
                "no native-ready media stream was found after challenge resolution".to_owned(),
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
                resolved_from_descriptor(&extraction.descriptor, stream)
            }
            YouTubeDownloadPlan::SeparateTracks { .. } => Err(
                NativeMediaTaskError::UnsupportedFeature(
                    "separate-track mux is not migrated to task execution yet".to_owned(),
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
        .max_by_key(|stream| {
            (
                stream.height.unwrap_or(0),
                stream.bitrate_bps.unwrap_or(0),
                stream.content_length.unwrap_or(0),
            )
        })
        .ok_or_else(|| NativeMediaTaskError::Resolution("native media result has no playable stream".to_owned()))?;

    resolved_from_descriptor(&descriptor, stream)
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
            }))
        }
        MediaProtocol::Hls | MediaProtocol::Dash => Ok(ResolvedNativeMedia::Manifest(
            ResolvedManifestMedia {
                descriptor: descriptor.clone(),
                stream: stream.clone(),
            },
        )),
    }
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
    fn parses_common_quality_limits() {
        assert_eq!(parse_quality_height("1080p"), Some(1080));
        assert_eq!(parse_quality_height("4k"), Some(2160));
        assert_eq!(parse_quality_height("best"), None);
    }
}
