//! Application-wide logging setup.
//!
//! NOVA logs to a structured, rotating file under
//! `{data_dir}/logs/nova.log` and mirrors every record into an in-memory ring
//! buffer that the `/api/logs` daemon routes can query at runtime.
//!
//! The default verbosity is `Debug` in debug builds and `Info` in release
//! builds. It can be overridden at startup with the `NOVA_LOG_LEVEL`
//! environment variable (`off|error|warn|info|debug|trace`) or changed at
//! runtime through `PATCH /api/logs/level`.

use flexi_logger::writers::LogWriter;
use flexi_logger::{DeferredNow, FileSpec, LogSpecification, Logger, LoggerHandle};
use log::{LevelFilter, Record};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Maximum number of log entries kept in the in-memory ring buffer.
pub const LOG_BUFFER_CAPACITY: usize = 5000;
/// Rotate the log file once it reaches this size (10 MiB).
pub const LOG_FILE_MAX_SIZE: u64 = 10 * 1024 * 1024;
/// Number of rotated log files to keep.
pub const LOG_FILES_TO_KEEP: usize = 10;
/// Maximum number of bytes `read_log_file` will read from a log file before
/// giving up, guarding against unbounded memory use on oversized files.
const MAX_LOG_FILE_READ_BYTES: u64 = 64 * 1024 * 1024;

/// A single structured log record, as exposed by `/api/logs`.
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    /// RFC 3339 timestamp (UTC) of the record.
    pub timestamp: String,
    /// Unix milliseconds (UTC) of the record — exact ordering across threads.
    #[serde(rename = "timestampMs")]
    pub timestamp_ms: u64,
    /// Uppercase level name, e.g. `DEBUG`.
    pub level: String,
    /// The module path of the emitting crate.
    pub target: String,
    /// Name of the thread that emitted the record.
    pub thread: String,
    /// The formatted message.
    pub message: String,
    /// Source location `file:line` when the record carries it.
    pub location: Option<String>,
    /// Scoped structured context (e.g. `task`, `url`, `segment`) attached to the
    /// thread that emitted the record, outermost first.
    pub context: Vec<LogContext>,
}

/// A single key/value pair of scoped logging context attached to a record.
#[derive(Debug, Clone, Serialize)]
pub struct LogContext {
    pub key: String,
    pub value: String,
}

impl LogEntry {
    /// Numeric rank so callers can filter by minimum level.
    fn level_rank(level: &str) -> u8 {
        match level {
            "TRACE" => 1,
            "DEBUG" => 2,
            "INFO" => 3,
            "WARN" => 4,
            "ERROR" => 5,
            _ => 3,
        }
    }

    /// Whether this entry is at least as severe as `min_level`.
    pub(crate) fn meets_level(&self, min_level: LevelFilter) -> bool {
        let min_rank = match min_level {
            LevelFilter::Off => 5,
            LevelFilter::Error => 5,
            LevelFilter::Warn => 4,
            LevelFilter::Info => 3,
            LevelFilter::Debug => 2,
            LevelFilter::Trace => 1,
        };
        Self::level_rank(&self.level) >= min_rank
    }

    /// Value of the scoped context pair with the given key, if present.
    pub fn context_value(&self, key: &str) -> Option<&str> {
        self.context
            .iter()
            .find(|pair| pair.key == key)
            .map(|pair| pair.value.as_str())
    }

    /// Whether this record belongs to the given task: it either carries a
    /// `task=` context pair, or its message uses the `Task <id>:` prefix used
    /// throughout the engine (covers entries emitted without scoped context,
    /// e.g. from API/watchdog threads).
    pub fn is_for_task(&self, task_id: &str) -> bool {
        if self.context_value("task") == Some(task_id) {
            return true;
        }
        let prefix = format!("Task {task_id}:");
        self.message.starts_with(&prefix) || self.message.contains(&format!("(task: {task_id})"))
    }

    /// Whether this is an `[ERROR-PATH]` fingerprint record emitted by
    /// `mark_curl_task_failed`.
    pub fn is_error_path(&self) -> bool {
        self.message.starts_with("[ERROR-PATH]")
    }
}

// ── Scoped structured context ──────────────────────────────────────────
//
// Worker threads (downloads, media, probe) push scoped key/value pairs (task
// id, URL, phase, segment, ...) before doing work. Every log record emitted on
// that thread then carries the active context, so the rotating files and the
// `/api/logs` ring buffer expose the full "error path" without having to parse
// free-text messages.

thread_local! {
    static CONTEXT_STACK: RefCell<Vec<ContextEntry>> = const { RefCell::new(Vec::new()) };
}

struct ContextEntry {
    id: u64,
    key: String,
    value: String,
}

static NEXT_CONTEXT_ID: AtomicU64 = AtomicU64::new(1);

/// RAII guard that removes its context entry from the calling thread when
/// dropped (naturally scoped to the enclosing block).
pub struct LogContextGuard {
    id: u64,
}

impl Drop for LogContextGuard {
    fn drop(&mut self) {
        CONTEXT_STACK.with(|stack| {
            if let Ok(mut stack) = stack.try_borrow_mut() {
                stack.retain(|entry| entry.id != self.id);
            }
        });
    }
}

/// Attach a scoped context key/value pair to the current thread for the rest
/// of the enclosing block. Returns a guard that pops the entry on drop.
///
/// ```ignore
/// let _task = logging::push_context("task", task.id.as_str());
/// let _phase = logging::push_context("phase", "dispatch");
/// ```
pub fn push_context(key: &str, value: &str) -> LogContextGuard {
    let id = NEXT_CONTEXT_ID.fetch_add(1, Ordering::Relaxed);
    CONTEXT_STACK.with(|stack| {
        if let Ok(mut stack) = stack.try_borrow_mut() {
            stack.push(ContextEntry {
                id,
                key: key.to_owned(),
                value: value.to_owned(),
            });
        }
    });
    LogContextGuard { id }
}

/// Run `f` with a scoped context pair attached to the current thread.
pub fn with_context<T>(key: &str, value: &str, f: impl FnOnce() -> T) -> T {
    let _guard = push_context(key, value);
    f()
}

/// Active scoped context of the current thread, outermost first.
pub fn current_context() -> Vec<LogContext> {
    CONTEXT_STACK.with(|stack| {
        stack
            .try_borrow()
            .map(|stack| {
                stack
                    .iter()
                    .map(|entry| LogContext {
                        key: entry.key.clone(),
                        value: entry.value.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

/// Render the active context as ` key=value key=value` for the file format.
fn context_suffix() -> String {
    let context = current_context();
    if context.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for pair in context {
        out.push(' ');
        out.push_str(&pair.key);
        out.push('=');
        out.push_str(&pair.value);
    }
    out
}

struct LoggerState {
    handle: LoggerHandle,
    ring: Arc<Mutex<VecDeque<LogEntry>>>,
    dir: PathBuf,
    /// Base log specification the logger was started with (env overrides plus
    /// the default global level). `set_level` rebuilds from this so module
    /// filters set through `RUST_LOG` survive a runtime level change.
    spec: LogSpecification,
}

static STATE: OnceLock<LoggerState> = OnceLock::new();

fn state() -> Option<&'static LoggerState> {
    STATE.get()
}

/// Directory used when no explicit data dir is available yet.
fn default_log_dir() -> PathBuf {
    let home = std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE"))
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_owned());
    Path::new(&home).join("nova-download-manager").join("logs")
}

/// Resolve the effective log specification used at startup.
///
/// Precedence:
/// 1. `RUST_LOG` (standard `module=level,module2=level,global` syntax) for
///    fine-grained per-module control, e.g. `RUST_LOG=nova=debug,nova::daemon::curl=trace,info`.
/// 2. `NOVA_LOG_LEVEL` (backward-compatible single level, also accepts the
///    full `RUST_LOG` syntax).
/// 3. Built-in default: `Debug` in debug builds, `Info` in release.
fn resolve_spec() -> LogSpecification {
    for var in ["RUST_LOG", "NOVA_LOG_LEVEL"] {
        if let Ok(raw) = std::env::var(var) {
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                match LogSpecification::parse(trimmed) {
                    Ok(spec) => return spec,
                    Err(err) => {
                        eprintln!("[nova] ignoring invalid {var} log spec {trimmed:?}: {err}");
                    }
                }
            }
        }
    }
    let default = if cfg!(debug_assertions) {
        "debug"
    } else {
        "info"
    };
    LogSpecification::parse(default).expect("built-in level names always parse")
}

/// Structured, tab-free single-line format for the rotating log files.
/// Timestamps carry microsecond precision so the on-disk log is an exact
/// timeline for error-path reconstruction.
fn format_file_line(
    w: &mut dyn Write,
    now: &mut DeferredNow,
    record: &Record,
) -> std::io::Result<()> {
    let ts = now
        .now_utc_owned()
        .format("%Y-%m-%dT%H:%M:%S%.6fZ")
        .to_string();
    let thread = std::thread::current()
        .name()
        .unwrap_or("<unnamed>")
        .to_owned();
    let location = record
        .file()
        .zip(record.line())
        .map(|(file, line)| format!(" at {file}:{line}"))
        .unwrap_or_default();
    writeln!(
        w,
        "[{ts}] [{level}] [{thread}] [{target}]{location} {msg}{ctx}",
        level = record.level(),
        target = record.target(),
        msg = record.args(),
        ctx = context_suffix(),
    )
}

/// A flexi_logger target that pushes structured entries into the ring buffer.
struct RingBufferWriter {
    ring: Arc<Mutex<VecDeque<LogEntry>>>,
}

impl LogWriter for RingBufferWriter {
    fn write(&self, now: &mut DeferredNow, record: &Record) -> std::io::Result<()> {
        let entry = LogEntry {
            timestamp: now.format_rfc3339(),
            timestamp_ms: now.now_utc_owned().timestamp_millis() as u64,
            level: record.level().as_str().to_owned(),
            target: record.target().to_owned(),
            thread: std::thread::current()
                .name()
                .unwrap_or("<unnamed>")
                .to_owned(),
            message: record.args().to_string(),
            location: record
                .file()
                .zip(record.line())
                .map(|(file, line)| format!("{file}:{line}")),
            context: current_context(),
        };
        if let Ok(mut buffer) = self.ring.lock() {
            if buffer.len() == LOG_BUFFER_CAPACITY {
                buffer.pop_front();
            }
            buffer.push_back(entry);
        }
        Ok(())
    }

    fn flush(&self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Initialize the global logger with the default data directory.
/// Safe to call multiple times; only the first call takes effect.
pub fn init_default() {
    let _ = init(default_log_dir());
}

/// Initialize the global logger, writing rotating structured logs to
/// `log_dir` and mirroring records into the in-memory ring buffer.
///
/// If the log directory cannot be used, falls back to a ring-buffer-only
/// logger so runtime log queries still work.
pub fn init(log_dir: PathBuf) -> Result<(), String> {
    if STATE.get().is_some() {
        return Ok(());
    }

    let ring: Arc<Mutex<VecDeque<LogEntry>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(LOG_BUFFER_CAPACITY)));
    let spec = resolve_spec();

    let handle = if std::fs::create_dir_all(&log_dir).is_err() {
        build_ring_only_logger(ring.clone(), spec.clone()).map_err(|e| {
            format!(
                "cannot create log dir {} and fallback logger failed: {e}",
                log_dir.display()
            )
        })?
    } else {
        match build_logger(log_dir.clone(), ring.clone(), spec.clone()) {
            Ok(handle) => handle,
            Err(_) => build_ring_only_logger(ring.clone(), spec.clone())
                .map_err(|e| format!("failed to initialize fallback logger: {e}"))?,
        }
    };

    let state = LoggerState {
        handle,
        ring,
        dir: log_dir.clone(),
        spec,
    };
    let _ = STATE.set(state);
    log::info!(
        "Logging initialized (level={} spec={}) file={}",
        current_level(),
        spec_to_string(),
        log_dir.join("nova.log").display()
    );
    Ok(())
}

fn build_logger(
    log_dir: PathBuf,
    ring: Arc<Mutex<VecDeque<LogEntry>>>,
    spec: LogSpecification,
) -> Result<LoggerHandle, flexi_logger::FlexiLoggerError> {
    Logger::with(spec)
        .log_to_file_and_writer(
            FileSpec::default().directory(&log_dir).basename("nova"),
            Box::new(RingBufferWriter { ring }),
        )
        .rotate(
            flexi_logger::Criterion::Size(LOG_FILE_MAX_SIZE),
            flexi_logger::Naming::Timestamps,
            flexi_logger::Cleanup::KeepLogFiles(LOG_FILES_TO_KEEP),
        )
        .append()
        .use_utc()
        .use_windows_line_ending()
        .format_for_files(format_file_line)
        .start()
}

fn build_ring_only_logger(
    ring: Arc<Mutex<VecDeque<LogEntry>>>,
    spec: LogSpecification,
) -> Result<LoggerHandle, flexi_logger::FlexiLoggerError> {
    Logger::with(spec)
        .log_to_writer(Box::new(RingBufferWriter { ring }))
        .start()
}

/// Render the active spec as `RUST_LOG`-style text (module filters and global
/// level), for diagnostics and the startup banner.
fn spec_to_string() -> String {
    let Some(state) = state() else {
        return resolve_spec()
            .module_filters
            .iter()
            .map(|f| match &f.module_name {
                Some(name) => format!("{name}={}", f.level_filter.to_string().to_ascii_lowercase()),
                None => f.level_filter.to_string().to_ascii_lowercase(),
            })
            .collect::<Vec<_>>()
            .join(",");
    };
    state
        .spec
        .module_filters
        .iter()
        .map(|f| match &f.module_name {
            Some(name) => format!("{name}={}", f.level_filter.to_string().to_ascii_lowercase()),
            None => f.level_filter.to_string().to_ascii_lowercase(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Current effective global level.
pub fn current_level() -> LevelFilter {
    state()
        .and_then(|s| s.handle.current_max_level().ok())
        .unwrap_or_else(|| {
            std::env::var("NOVA_LOG_LEVEL")
                .ok()
                .and_then(|raw| raw.trim().parse().ok())
                .unwrap_or(LevelFilter::Off)
        })
}

/// Change the global level at runtime (e.g. via `PATCH /api/logs/level`).
/// Module filters from a `RUST_LOG`/`NOVA_LOG_LEVEL` startup spec are kept.
pub fn set_level(level: LevelFilter) -> Result<(), String> {
    match state() {
        Some(s) => {
            let mut builder = LogSpecification::builder();
            for filter in &s.spec.module_filters {
                if let Some(name) = &filter.module_name {
                    builder.module(name, filter.level_filter);
                }
            }
            builder.default(level);
            s.handle.set_new_spec(builder.build());
            log::info!("Log level changed to {level} (spec={})", spec_to_string());
            Ok(())
        }
        None => Err("logger is not initialized".to_owned()),
    }
}

/// List the log files present in the log directory (active + rotated),
/// newest first, as (file name, absolute path).
pub fn log_files() -> Vec<(String, PathBuf)> {
    log_files_in(log_dir())
}

fn log_files_in(dir: Option<PathBuf>) -> Vec<(String, PathBuf)> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<(String, PathBuf)> = read_dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let is_log = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("log"))
                .unwrap_or(false);
            if !is_log || !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some((name, path))
        })
        .collect();
    files.sort_by(|a, b| {
        let a_mtime = std::fs::metadata(&a.1).and_then(|m| m.modified()).ok();
        let b_mtime = std::fs::metadata(&b.1).and_then(|m| m.modified()).ok();
        b_mtime.cmp(&a_mtime).then_with(|| b.0.cmp(&a.0))
    });
    files
}

/// Absolute path of the directory holding the rotating log files, if the
/// file logger is active.
pub fn log_dir() -> Option<PathBuf> {
    state().map(|s| s.dir.clone())
}

/// Return up to `limit` most-recent ring-buffer entries, optionally filtered
/// to `min_level` or more severe.
pub fn recent(limit: usize, min_level: Option<LevelFilter>) -> Vec<LogEntry> {
    let Some(state) = state() else {
        return Vec::new();
    };
    let guard = state
        .ring
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let filtered: Vec<LogEntry> = guard
        .iter()
        .filter(|entry| min_level.map_or(true, |min| entry.meets_level(min)))
        .cloned()
        .collect();
    let start = filtered.len().saturating_sub(limit);
    filtered[start..].to_vec()
}

/// One phase of a task's lifecycle observed in a trace (e.g. `dispatch`,
/// `single`, `segmented`, `error-path`).
#[derive(Debug, Clone, Serialize)]
pub struct TracePhase {
    pub phase: String,
    pub entries: usize,
    pub first_ms: u64,
    pub last_ms: u64,
}

/// Per-task summary aggregated from the ring buffer.
#[derive(Debug, Clone, Serialize)]
pub struct TaskSummary {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub entries: usize,
    pub errors: usize,
    pub warnings: usize,
    #[serde(rename = "lastSeenMs")]
    pub last_seen_ms: u64,
    #[serde(rename = "lastLevel")]
    pub last_level: String,
    pub threads: Vec<String>,
    /// Context values carried with the task (url, save_path, ...), deduplicated.
    pub context: Vec<LogContext>,
}

/// A full chronological reconstruction of one task's log trail.
#[derive(Debug, Clone, Serialize)]
pub struct TaskTrace {
    #[serde(rename = "taskId")]
    pub task_id: String,
    /// Chronological records for the task (oldest first).
    pub entries: Vec<LogEntry>,
    /// The `[ERROR-PATH]` fingerprint record, if the task failed.
    #[serde(rename = "errorPath")]
    pub error_path: Option<LogEntry>,
    /// ERROR-level records (excluding the fingerprint itself).
    pub errors: Vec<LogEntry>,
    /// Distinct phases observed, in first-appearance order.
    pub phases: Vec<TracePhase>,
    pub threads: Vec<String>,
    pub first_ms: u64,
    pub last_ms: u64,
}

/// Aggregate the ring buffer into per-task summaries, newest-last-seen first.
/// Only tasks with at least one record are returned. Reads the buffer under
/// the lock and aggregates by reference — no full-buffer clone (round 2).
pub fn task_summaries() -> Vec<TaskSummary> {
    let Some(s) = state() else {
        return Vec::new();
    };
    let guard = s
        .ring
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    task_summaries_from(&guard)
}

fn task_summaries_from(entries: &VecDeque<LogEntry>) -> Vec<TaskSummary> {
    let mut by_task: std::collections::BTreeMap<&str, TaskSummary> = Default::default();
    for entry in entries {
        let Some(task_id) = entry
            .context_value("task")
            .or_else(|| {
                entry
                    .message
                    .strip_prefix("Task ")
                    .and_then(|rest| rest.split(':').next())
            })
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let summary = by_task.entry(task_id).or_insert_with(|| TaskSummary {
            task_id: task_id.to_owned(),
            entries: 0,
            errors: 0,
            warnings: 0,
            last_seen_ms: 0,
            last_level: String::new(),
            threads: Vec::new(),
            context: Vec::new(),
        });
        summary.entries += 1;
        match entry.level.as_str() {
            "ERROR" => summary.errors += 1,
            "WARN" => summary.warnings += 1,
            _ => {}
        }
        if entry.timestamp_ms >= summary.last_seen_ms {
            summary.last_seen_ms = entry.timestamp_ms;
            summary.last_level = entry.level.clone();
        }
        if !summary.threads.contains(&entry.thread) {
            summary.threads.push(entry.thread.clone());
        }
        for pair in &entry.context {
            if pair.key != "task"
                && pair.key != "phase"
                && pair.key != "segment"
                && !summary
                    .context
                    .iter()
                    .any(|c| c.key == pair.key && c.value == pair.value)
            {
                summary.context.push(pair.clone());
            }
        }
    }
    let mut all: Vec<TaskSummary> = by_task.into_values().collect();
    all.sort_by_key(|s| std::cmp::Reverse(s.last_seen_ms));
    all
}

/// Reconstruct the chronological log trail of a single task.
///
/// Matches records that either carry a `task=<id>` context pair or use the
/// `Task <id>:` message prefix (covers records emitted on threads without
/// scoped context). Returns the most recent `limit` matching records
/// (oldest first), plus a structured error-path/phase summary. Reads under
/// the lock — no full-buffer clone (round 2).
pub fn task_trace(task_id: &str, limit: usize) -> TaskTrace {
    let Some(s) = state() else {
        return TaskTrace {
            task_id: task_id.to_owned(),
            entries: Vec::new(),
            error_path: None,
            errors: Vec::new(),
            phases: Vec::new(),
            threads: Vec::new(),
            first_ms: 0,
            last_ms: 0,
        };
    };
    let guard = s
        .ring
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    task_trace_from(&guard, task_id, limit)
}

fn task_trace_from(entries: &VecDeque<LogEntry>, task_id: &str, limit: usize) -> TaskTrace {
    // Only the matching records are cloned — the rest of the buffer is
    // iterated by reference under the lock.
    let mut matched: Vec<LogEntry> = entries
        .iter()
        .filter(|entry| entry.is_for_task(task_id))
        .cloned()
        .collect();
    let start = matched.len().saturating_sub(limit);
    matched = matched[start..].to_vec();

    let error_path = matched.iter().find(|entry| entry.is_error_path()).cloned();
    let errors: Vec<LogEntry> = matched
        .iter()
        .filter(|entry| entry.level == "ERROR" && !entry.is_error_path())
        .cloned()
        .collect();

    let mut phase_meta: Vec<TracePhase> = Vec::new();
    for entry in &matched {
        let phase = entry.context_value("phase").unwrap_or("unknown").to_owned();
        if let Some(meta) = phase_meta.iter_mut().find(|m| m.phase == phase) {
            meta.entries += 1;
            meta.last_ms = entry.timestamp_ms;
        } else {
            phase_meta.push(TracePhase {
                phase,
                entries: 1,
                first_ms: entry.timestamp_ms,
                last_ms: entry.timestamp_ms,
            });
        }
    }

    let mut threads: Vec<String> = Vec::new();
    for entry in &matched {
        if !threads.contains(&entry.thread) {
            threads.push(entry.thread.clone());
        }
    }

    let first_ms = matched.first().map(|e| e.timestamp_ms).unwrap_or(0);
    let last_ms = matched.last().map(|e| e.timestamp_ms).unwrap_or(0);

    TaskTrace {
        task_id: task_id.to_owned(),
        entries: matched,
        error_path,
        errors,
        phases: phase_meta,
        threads,
        first_ms,
        last_ms,
    }
}

/// A single grep hit inside a log file, with optional surrounding context
/// lines. Line numbers are 1-based.
#[derive(Debug, Clone, Serialize)]
pub struct LogMatch {
    pub file: String,
    pub line: usize,
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}

/// Result of reading a tail and/or a grep over one rotating log file.
#[derive(Debug, Clone, Serialize)]
pub struct LogFileTail {
    /// Absolute path of the file that was read.
    pub path: String,
    /// Total number of lines in the file.
    pub total_lines: usize,
    /// The last `lines` lines of the file (empty when `lines` is 0).
    pub tail: Vec<String>,
    /// Grep hits with surrounding context (empty when no `grep` was given).
    pub matches: Vec<LogMatch>,
    /// Number of grep hits that were dropped because of `max_matches`.
    pub truncated_matches: usize,
}

/// Read the tail of and/or grep a rotating log file by its base name.
///
/// `name` defaults to the active `nova.log`; any base name returned by
/// [`log_files`] is accepted (rotated files included). Returns `None` when the
/// logger has no file directory or the named file does not exist.
pub fn read_log_file(
    name: Option<&str>,
    lines: usize,
    grep: Option<&str>,
    context_lines: usize,
    max_matches: usize,
) -> Option<LogFileTail> {
    read_log_file_in(log_dir(), name, lines, grep, context_lines, max_matches)
}

/// Read a file's contents as UTF-8, refusing to allocate past `max_bytes`.
fn read_text_capped(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let file = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut buf)?;
    if buf.len() as u64 > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file exceeds {max_bytes} bytes"),
        ));
    }
    String::from_utf8(buf).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file is not valid UTF-8: {e}"),
        )
    })
}

fn read_log_file_in(
    dir: Option<PathBuf>,
    name: Option<&str>,
    lines: usize,
    grep: Option<&str>,
    context_lines: usize,
    max_matches: usize,
) -> Option<LogFileTail> {
    let dir = dir?;
    let active = dir.join("nova.log");
    let path = match name {
        Some(base) if !base.is_empty() => {
            // Only accept a plain file name. Reject anything that contains a
            // path separator, `..`, an absolute/root/prefix path, or that
            // escapes `dir` — otherwise a caller-controlled `file` query
            // parameter could read arbitrary files on disk.
            let candidate_path = Path::new(base);
            let is_plain_name = !candidate_path.is_absolute()
                && candidate_path.components().count() == 1
                && matches!(
                    candidate_path.components().next(),
                    Some(Component::Normal(_))
                );
            if !is_plain_name {
                return None;
            }
            let candidate = dir.join(candidate_path);
            if !candidate.is_file() {
                return None;
            }
            candidate
        }
        _ => active,
    };
    let Ok(content) = read_text_capped(&path, MAX_LOG_FILE_READ_BYTES) else {
        return None;
    };
    let all: Vec<&str> = content.lines().collect();
    let total_lines = all.len();

    let tail = if lines == 0 {
        Vec::new()
    } else {
        let start = all.len().saturating_sub(lines);
        all[start..].iter().map(|s| (*s).to_owned()).collect()
    };

    let (matches, truncated_matches) = match grep {
        Some(needle) if !needle.trim().is_empty() => {
            let needle = needle.trim().to_ascii_lowercase();
            let mut hits = Vec::new();
            let mut truncated = 0usize;
            for (idx, line) in all.iter().enumerate() {
                if !line.to_ascii_lowercase().contains(&needle) {
                    continue;
                }
                if hits.len() >= max_matches {
                    truncated += 1;
                    continue;
                }
                let lo = idx.saturating_sub(context_lines);
                let hi = (idx + 1 + context_lines).min(all.len());
                let before = all[lo..idx].iter().map(|s| (*s).to_owned()).collect();
                let after = all[idx + 1..hi].iter().map(|s| (*s).to_owned()).collect();
                hits.push(LogMatch {
                    file: path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    line: idx + 1,
                    text: (*line).to_owned(),
                    before,
                    after,
                });
            }
            (hits, truncated)
        }
        _ => (Vec::new(), 0),
    };

    Some(LogFileTail {
        path: path.to_string_lossy().into_owned(),
        total_lines,
        tail,
        matches,
        truncated_matches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes env-var-manipulating tests, since `std::env` is process-wide.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// flexi_logger's `max_level` is `pub(crate)`; compute the same max from the
    /// public `module_filters` for assertions.
    fn spec_max(spec: &LogSpecification) -> LevelFilter {
        spec.module_filters
            .iter()
            .map(|f| f.level_filter)
            .max()
            .unwrap_or(LevelFilter::Off)
    }

    #[test]
    fn level_rank_orders_severity() {
        assert_eq!(LogEntry::level_rank("TRACE"), 1);
        assert_eq!(LogEntry::level_rank("DEBUG"), 2);
        assert_eq!(LogEntry::level_rank("INFO"), 3);
        assert_eq!(LogEntry::level_rank("WARN"), 4);
        assert_eq!(LogEntry::level_rank("ERROR"), 5);
    }

    #[test]
    fn meets_level_filters_by_minimum() {
        let entry = |level: &str| LogEntry {
            timestamp: "ts".to_owned(),
            timestamp_ms: 0,
            level: level.to_owned(),
            target: "t".to_owned(),
            thread: "th".to_owned(),
            message: "m".to_owned(),
            location: None,
            context: Vec::new(),
        };
        assert!(entry("INFO").meets_level(LevelFilter::Info));
        assert!(entry("WARN").meets_level(LevelFilter::Info));
        assert!(entry("DEBUG").meets_level(LevelFilter::Debug));
        assert!(!entry("DEBUG").meets_level(LevelFilter::Info));
        assert!(!entry("TRACE").meets_level(LevelFilter::Debug));
    }

    #[test]
    fn resolve_spec_honors_env_override() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("NOVA_LOG_LEVEL", "trace");
        assert_eq!(spec_max(&resolve_spec()), LevelFilter::Trace);
        std::env::set_var("NOVA_LOG_LEVEL", "info");
        assert_eq!(spec_max(&resolve_spec()), LevelFilter::Info);
        std::env::remove_var("NOVA_LOG_LEVEL");
        std::env::remove_var("RUST_LOG");
    }

    #[test]
    fn resolve_spec_parses_module_filters() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::set_var("RUST_LOG", "nova::daemon::curl=trace,nova=warn,error");
        let spec = resolve_spec();
        std::env::remove_var("RUST_LOG");
        std::env::remove_var("NOVA_LOG_LEVEL");
        let curl = spec
            .module_filters
            .iter()
            .find(|f| f.module_name.as_deref() == Some("nova::daemon::curl"));
        assert_eq!(curl.map(|f| f.level_filter), Some(LevelFilter::Trace));
        let global = spec.module_filters.iter().find(|f| f.module_name.is_none());
        assert_eq!(global.map(|f| f.level_filter), Some(LevelFilter::Error));
    }

    #[test]
    fn resolve_spec_falls_back_to_build_level() {
        let _env_guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        std::env::remove_var("NOVA_LOG_LEVEL");
        std::env::remove_var("RUST_LOG");
        let expected = if cfg!(debug_assertions) {
            LevelFilter::Debug
        } else {
            LevelFilter::Info
        };
        assert_eq!(spec_max(&resolve_spec()), expected);
    }

    #[test]
    fn format_file_line_emits_structured_single_line() {
        let args = format_args!("hello {value}", value = 7);
        let record = log::Record::builder()
            .file(Some("src/lib.rs"))
            .line(Some(42))
            .target("nova::test")
            .args(args)
            .level(log::Level::Info)
            .build();
        let mut now = DeferredNow::new();
        let mut out = Vec::new();
        format_file_line(&mut out, &mut now, &record).unwrap();
        let line = String::from_utf8(out).unwrap();
        assert!(line.starts_with('['));
        assert!(line.contains("] [INFO] ["));
        assert!(line.contains("[nova::test]"));
        assert!(line.contains("at src/lib.rs:42"));
        assert!(line.contains("hello 7"));
        assert_eq!(line.matches('\n').count(), 1);
    }

    #[test]
    fn context_is_scoped_and_nested() {
        {
            let _outer = push_context("task", "abc");
            assert_eq!(current_context().len(), 1);
            assert_eq!(current_context()[0].key, "task");
            {
                let _inner = push_context("segment", "3");
                assert_eq!(current_context().len(), 2);
                assert_eq!(current_context()[1].value, "3");
            }
            assert_eq!(current_context().len(), 1);
        }
        assert!(current_context().is_empty());
    }

    fn sample_entry(level: &str, message: &str, ctx: &[(&str, &str)], ms: u64) -> LogEntry {
        LogEntry {
            timestamp: "2026-01-01T00:00:00Z".to_owned(),
            timestamp_ms: ms,
            level: level.to_owned(),
            target: "nova::test".to_owned(),
            thread: "worker".to_owned(),
            message: message.to_owned(),
            location: None,
            context: ctx
                .iter()
                .map(|(k, v)| LogContext {
                    key: (*k).to_owned(),
                    value: (*v).to_owned(),
                })
                .collect(),
        }
    }

    #[test]
    fn is_for_task_matches_context_and_message_prefix() {
        let with_ctx = sample_entry("INFO", "some msg", &[("task", "t-1")], 1);
        assert!(with_ctx.is_for_task("t-1"));
        assert!(!with_ctx.is_for_task("t-2"));

        let with_prefix = sample_entry("INFO", "Task t-2: starting", &[], 2);
        assert!(with_prefix.is_for_task("t-2"));
        assert!(!with_prefix.is_for_task("t-1"));
    }

    #[test]
    fn task_trace_reconstructs_chronology_and_error_path() {
        let entries = vec![
            sample_entry(
                "INFO",
                "Task t-1: plan",
                &[("task", "t-1"), ("phase", "dispatch")],
                100,
            ),
            sample_entry(
                "DEBUG",
                "segment decision",
                &[("task", "t-1"), ("phase", "segmented"), ("segment", "0")],
                200,
            ),
            sample_entry("INFO", "Task t-9: unrelated", &[("task", "t-9")], 300),
            sample_entry(
                "ERROR",
                "Task t-1: download failed",
                &[("task", "t-1"), ("phase", "error-path")],
                400,
            ),
            sample_entry(
                "ERROR",
                "[ERROR-PATH] task=t-1 ...",
                &[("task", "t-1"), ("phase", "error-path")],
                500,
            ),
        ];
        let trace = task_trace_from(&VecDeque::from(entries), "t-1", 100);
        assert_eq!(trace.entries.len(), 4);
        assert_eq!(trace.entries.first().map(|e| e.timestamp_ms), Some(100));
        assert_eq!(trace.entries.last().map(|e| e.timestamp_ms), Some(500));
        assert!(trace.error_path.is_some());
        assert_eq!(trace.errors.len(), 1); // the "download failed" ERROR, not the fingerprint
        assert_eq!(trace.phases.len(), 3);
        assert!(trace.phases.iter().any(|p| p.phase == "segmented"));
        assert!(trace.phases.iter().any(|p| p.phase == "error-path"));
        assert_eq!(trace.first_ms, 100);
        assert_eq!(trace.last_ms, 500);
    }

    #[test]
    fn task_trace_respects_limit_keeping_newest() {
        let entries: Vec<LogEntry> = (0..10)
            .map(|i| sample_entry("DEBUG", "line", &[("task", "t-1")], i))
            .collect();
        let trace = task_trace_from(&VecDeque::from(entries), "t-1", 3);
        assert_eq!(trace.entries.len(), 3);
        assert_eq!(trace.entries.first().map(|e| e.timestamp_ms), Some(7));
        assert_eq!(trace.entries.last().map(|e| e.timestamp_ms), Some(9));
    }

    #[test]
    fn task_summaries_aggregate_per_task() {
        let entries = vec![
            sample_entry(
                "INFO",
                "Task t-1: a",
                &[("task", "t-1"), ("url", "http://x")],
                100,
            ),
            sample_entry(
                "ERROR",
                "Task t-1: b",
                &[("task", "t-1"), ("url", "http://x")],
                200,
            ),
            sample_entry("WARN", "Task t-2: c", &[("task", "t-2")], 150),
        ];
        let summaries = task_summaries_from(&VecDeque::from(entries));
        assert_eq!(summaries.len(), 2);
        // t-1 last seen 200 > t-2 last seen 150, so t-1 sorts first.
        assert_eq!(summaries[0].task_id, "t-1");
        assert_eq!(summaries[0].entries, 2);
        assert_eq!(summaries[0].errors, 1);
        assert_eq!(summaries[0].last_level, "ERROR");
        assert!(summaries[0]
            .context
            .iter()
            .any(|c| c.key == "url" && c.value == "http://x"));
        assert_eq!(summaries[1].task_id, "t-2");
        assert_eq!(summaries[1].warnings, 1);
    }

    #[test]
    fn with_context_runs_closure() {
        let result = with_context("phase", "dispatch", || {
            assert_eq!(current_context().len(), 1);
            42
        });
        assert_eq!(result, 42);
        assert!(current_context().is_empty());
    }

    #[test]
    fn context_suffix_is_space_prefixed_when_active() {
        assert_eq!(context_suffix(), "");
        let _guard = push_context("task", "t-1");
        assert_eq!(context_suffix(), " task=t-1");
        let _guard2 = push_context("segment", "0");
        assert_eq!(context_suffix(), " task=t-1 segment=0");
    }

    #[test]
    fn log_files_lists_rotated_and_active() {
        let dir = std::env::temp_dir().join(format!("nova-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("nova.log"), "current\n").unwrap();
        std::fs::write(dir.join("nova_2026-01-01_00-00-00.log"), "old\n").unwrap();
        std::fs::write(dir.join("unrelated.txt"), "x").unwrap();

        let files = log_files_in(Some(dir.clone()));
        let names: Vec<String> = files.iter().map(|(n, _)| n.clone()).collect();
        assert!(names.iter().any(|n| n == "nova.log"));
        assert!(names.iter().any(|n| n.starts_with("nova_2026-01-01")));
        assert!(!names.iter().any(|n| n == "unrelated.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_log_file_tails_and_greps() {
        let dir = std::env::temp_dir().join(format!("nova-log-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let content = [
            "line one",
            "ERROR the task failed",
            "line three",
            "line four",
            "ERROR the task failed again",
        ]
        .join("\n");
        std::fs::write(dir.join("nova.log"), &content).unwrap();

        let result = read_log_file_in(
            Some(dir.clone()),
            Some("nova.log"),
            2,
            Some("failed"),
            1,
            100,
        );
        let result = result.expect("read_log_file should find the file");
        assert_eq!(result.total_lines, 5);
        assert_eq!(result.tail.len(), 2);
        assert_eq!(result.tail[0], "line four");
        assert_eq!(result.tail[1], "ERROR the task failed again");
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.matches[0].line, 2);
        assert_eq!(result.matches[0].before.len(), 1);
        assert_eq!(result.matches[0].after.len(), 1);
        assert_eq!(result.matches[1].line, 5);
        assert_eq!(result.truncated_matches, 0);
        assert!(result.path.ends_with("nova.log"));

        // Unknown file name returns None.
        assert!(read_log_file_in(Some(dir.clone()), Some("nope.log"), 10, None, 0, 100).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
