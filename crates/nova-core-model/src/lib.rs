//! Platform-neutral NOVA task models.
//!
//! This crate intentionally contains no Tauri, HTTP-server, filesystem,
//! subprocess, or Android/JNI dependencies. Hosts serialize these records at
//! their own boundaries while the domain schema remains stable across desktop
//! and mobile clients.

use serde::{Deserialize, Serialize};

/// Platform-neutral lifecycle state for a NOVA download task.
///
/// The public `Task.status` field remains a string for wire compatibility,
/// while all engines can parse and validate it through this shared enum. This
/// prevents desktop and Android from inventing incompatible transition rules.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskState {
    Queued,
    Preparing,
    Probing,
    Downloading,
    Pausing,
    Paused,
    Retrying,
    Recovering,
    Verifying,
    Finalizing,
    Completed,
    Failed,
    Interrupted,
}

impl TaskState {
    /// Canonical status string exposed through the existing task schema.
    ///
    /// `Failed` intentionally remains `"error"` because desktop clients and
    /// persisted snapshots already use that public value.
    pub const fn as_status(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Preparing => "preparing",
            Self::Probing => "probing",
            Self::Downloading => "downloading",
            Self::Pausing => "pausing",
            Self::Paused => "paused",
            Self::Retrying => "retrying",
            Self::Recovering => "recovering",
            Self::Verifying => "verifying",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Failed => "error",
            Self::Interrupted => "interrupted",
        }
    }

    /// Parse canonical states plus legacy aliases already present in snapshots.
    pub fn from_status(status: &str) -> Option<Self> {
        match status.trim().to_ascii_lowercase().as_str() {
            "queued" | "waiting" => Some(Self::Queued),
            "preparing" | "starting" => Some(Self::Preparing),
            "probing" | "resolving" | "resolving-url" => Some(Self::Probing),
            "downloading" => Some(Self::Downloading),
            "pausing" | "stopping" => Some(Self::Pausing),
            "paused" => Some(Self::Paused),
            "retrying" => Some(Self::Retrying),
            "recovering" => Some(Self::Recovering),
            "verifying" => Some(Self::Verifying),
            "finalizing" | "merging" => Some(Self::Finalizing),
            "completed" => Some(Self::Completed),
            "error" | "failed" => Some(Self::Failed),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }

    /// True for states that represent work currently occupying an engine slot.
    pub const fn is_active(self) -> bool {
        matches!(
            self,
            Self::Preparing
                | Self::Probing
                | Self::Downloading
                | Self::Pausing
                | Self::Retrying
                | Self::Recovering
                | Self::Verifying
                | Self::Finalizing
        )
    }

    /// Validate an ordinary lifecycle transition.
    ///
    /// Completed is intentionally terminal here. Re-downloading is a distinct
    /// user operation and must use `can_restart_to`, which prevents accidental
    /// code paths from silently resurrecting a completed task.
    pub const fn can_transition_to(self, next: Self) -> bool {
        if self as u8 == next as u8 {
            return true;
        }
        match self {
            Self::Queued => matches!(
                next,
                Self::Preparing | Self::Paused | Self::Failed
            ),
            Self::Preparing => matches!(
                next,
                Self::Probing | Self::Pausing | Self::Paused | Self::Failed
            ),
            Self::Probing => matches!(
                next,
                Self::Downloading
                    | Self::Pausing
                    | Self::Paused
                    | Self::Retrying
                    | Self::Recovering
                    | Self::Failed
            ),
            Self::Downloading => matches!(
                next,
                Self::Pausing
                    | Self::Paused
                    | Self::Retrying
                    | Self::Recovering
                    | Self::Verifying
                    | Self::Failed
            ),
            Self::Pausing => matches!(next, Self::Paused | Self::Failed),
            Self::Paused => matches!(
                next,
                Self::Queued | Self::Preparing | Self::Failed
            ),
            Self::Retrying => matches!(
                next,
                Self::Probing
                    | Self::Downloading
                    | Self::Recovering
                    | Self::Pausing
                    | Self::Paused
                    | Self::Failed
            ),
            Self::Recovering => matches!(
                next,
                Self::Probing
                    | Self::Downloading
                    | Self::Retrying
                    | Self::Pausing
                    | Self::Paused
                    | Self::Failed
            ),
            Self::Verifying => matches!(next, Self::Finalizing | Self::Failed),
            Self::Finalizing => matches!(next, Self::Completed | Self::Failed),
            Self::Completed => false,
            Self::Failed => matches!(
                next,
                Self::Queued | Self::Preparing | Self::Paused
            ),
            Self::Interrupted => matches!(
                next,
                Self::Paused | Self::Queued | Self::Preparing | Self::Failed
            ),
        }
    }

    /// Explicit restart/redownload transition, separate from normal lifecycle.
    pub const fn can_restart_to(self, next: Self) -> bool {
        // Restart is an explicit destructive user operation: it may reset a
        // queued, active, failed, interrupted, or completed task back to the
        // queue after the host cancels the old generation and clears partial
        // output. Keeping this separate from can_transition_to preserves
        // Completed as terminal for every non-destructive code path.
        matches!(next, Self::Queued)
    }
}

/// Canonical persisted and observable state of one NOVA download task.
///
/// Field names and serde aliases intentionally match the existing desktop API
/// and persisted snapshots. Do not rename a field without a schema migration.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(rename = "fileType")]
    pub file_type: String,
    pub status: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    #[serde(rename = "speedBytesPerSec")]
    pub speed_bytes_per_sec: u64,
    #[serde(rename = "timeLeftSeconds")]
    pub time_left_seconds: u64,
    #[serde(rename = "elapsedSeconds")]
    pub elapsed_seconds: u64,
    #[serde(rename = "dateAdded")]
    pub date_added: String,
    pub category: String,
    #[serde(rename = "queueId")]
    pub queue_id: String,
    pub connections: u32,
    pub resumable: bool,
    #[serde(rename = "savePath")]
    pub save_path: String,
    pub description: String,
    pub segments: Vec<Segment>,
    pub referer: Option<String>,
    pub engine: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    #[serde(rename = "engineStatus")]
    pub engine_status: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
}

/// Progress and byte-range state for one task segment.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub id: u32,
    pub progress: f64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub active: bool,
    pub speed: u64,
    /// Absolute byte range this segment covers in the output file. Missing
    /// ranges in legacy snapshots default to zero and are recovered by the
    /// host's resume planner.
    #[serde(default)]
    pub start_byte: u64,
    #[serde(default)]
    pub end_byte: u64,
}

/// Maximum number of parallel byte ranges that the shared NOVA planner emits.
///
/// Hosts remain free to use fewer connections based on profile, battery, or
/// network policy, but neither desktop nor mobile should create a wider range
/// fan-out than this shared safety ceiling.
pub const MAX_PARALLEL_SEGMENTS: u32 = 32;

/// Inclusive HTTP byte range for one parallel transfer segment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(self) -> u64 {
        self.end - self.start + 1
    }
}

/// Split a known representation length into balanced, non-overlapping ranges.
///
/// The result is deterministic across platforms, covers each byte exactly once,
/// never creates an empty range, and differs by at most one byte between the
/// largest and smallest segment. Requested parallelism is clamped to NOVA's
/// shared ceiling and to the representation length itself.
pub fn plan_byte_ranges(total_bytes: u64, requested_connections: u32) -> Vec<ByteRange> {
    if total_bytes == 0 {
        return Vec::new();
    }

    let requested = requested_connections.max(1).min(MAX_PARALLEL_SEGMENTS) as u64;
    let segment_count = requested.min(total_bytes);
    let base_len = total_bytes / segment_count;
    let remainder = total_bytes % segment_count;

    (0..segment_count)
        .map(|index| {
            let extra_before = index.min(remainder);
            let start = index * base_len + extra_before;
            let len = base_len + u64::from(index < remainder);
            ByteRange {
                start,
                end: start + len - 1,
            }
        })
        .collect()
}

/// Safe action after a host has asked an HTTP server to resume at an existing
/// local byte offset.
///
/// This belongs to the shared core because desktop and mobile must make the
/// same corruption-avoidance decision even when their transport bindings differ.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResumeAction {
    /// The response is a matching partial response and can be appended.
    Append,
    /// The host must discard partial bytes and restart from byte zero.
    Restart,
}

/// Decide whether a resume response is safe to append to an existing file.
///
/// For an empty destination there is nothing to resume, so a normal 2xx response
/// is treated as a fresh transfer. For a non-empty destination NOVA appends only
/// when the server returns `206 Partial Content` and confirms the exact requested
/// start offset through `Content-Range`. Any missing/mismatched range or a full
/// `200 OK` response forces a restart to prevent duplicated/corrupted output.
pub fn plan_http_resume(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
) -> ResumeAction {
    if existing_bytes == 0 {
        return ResumeAction::Append;
    }

    if response_status == 206 && content_range_start == Some(existing_bytes) {
        ResumeAction::Append
    } else {
        ResumeAction::Restart
    }
}

#[cfg(test)]
mod tests {
    use super::{
        plan_byte_ranges, plan_http_resume, ByteRange, ResumeAction, Segment, TaskState,
        MAX_PARALLEL_SEGMENTS,
    };

    #[test]
    fn legacy_segment_without_byte_range_deserializes() {
        let legacy = r#"{"id":0,"progress":0.5,"downloadedBytes":50,"totalBytes":100,"active":true,"speed":10}"#;
        let segment: Segment = serde_json::from_str(legacy).expect("legacy segment must load");
        assert_eq!(segment.start_byte, 0);
        assert_eq!(segment.end_byte, 0);
    }

    #[test]
    fn segment_roundtrips_with_byte_range() {
        let segment = Segment {
            id: 2,
            progress: 0.25,
            downloaded_bytes: 25,
            total_bytes: 100,
            active: true,
            speed: 7,
            start_byte: 100,
            end_byte: 199,
        };
        let serialized = serde_json::to_string(&segment).expect("serialize segment");
        let restored: Segment = serde_json::from_str(&serialized).expect("deserialize segment");
        assert_eq!(restored, segment);
    }

    #[test]
    fn range_planner_balances_and_covers_representation() {
        let ranges = plan_byte_ranges(10, 3);
        assert_eq!(
            ranges,
            vec![
                ByteRange { start: 0, end: 3 },
                ByteRange { start: 4, end: 6 },
                ByteRange { start: 7, end: 9 },
            ]
        );
        assert_eq!(ranges.iter().map(|range| range.len()).sum::<u64>(), 10);
    }

    #[test]
    fn range_planner_never_creates_empty_segments() {
        let ranges = plan_byte_ranges(3, 8);
        assert_eq!(
            ranges,
            vec![
                ByteRange { start: 0, end: 0 },
                ByteRange { start: 1, end: 1 },
                ByteRange { start: 2, end: 2 },
            ]
        );
    }

    #[test]
    fn range_planner_clamps_parallelism_to_shared_ceiling() {
        let ranges = plan_byte_ranges(1_000_000, u32::MAX);
        assert_eq!(ranges.len(), MAX_PARALLEL_SEGMENTS as usize);
        assert_eq!(ranges.first().copied(), Some(ByteRange { start: 0, end: 31_249 }));
        assert_eq!(
            ranges.last().copied(),
            Some(ByteRange {
                start: 968_750,
                end: 999_999,
            })
        );
    }

    #[test]
    fn range_planner_handles_zero_and_single_connection() {
        assert!(plan_byte_ranges(0, 32).is_empty());
        assert_eq!(
            plan_byte_ranges(42, 0),
            vec![ByteRange { start: 0, end: 41 }]
        );
    }

    #[test]
    fn matching_partial_response_is_safe_to_append() {
        assert_eq!(
            plan_http_resume(1_048_576, 206, Some(1_048_576)),
            ResumeAction::Append
        );
    }

    #[test]
    fn full_response_during_resume_forces_restart() {
        assert_eq!(plan_http_resume(1_048_576, 200, None), ResumeAction::Restart);
    }

    #[test]
    fn mismatched_content_range_forces_restart() {
        assert_eq!(
            plan_http_resume(1_048_576, 206, Some(524_288)),
            ResumeAction::Restart
        );
    }

    #[test]
    fn missing_content_range_forces_restart() {
        assert_eq!(plan_http_resume(1_048_576, 206, None), ResumeAction::Restart);
    }

    #[test]
    fn fresh_transfer_never_requires_truncating_empty_output() {
        assert_eq!(plan_http_resume(0, 200, None), ResumeAction::Append);
    }

    #[test]
    fn lifecycle_requires_verification_before_completion() {
        assert!(!TaskState::Downloading.can_transition_to(TaskState::Completed));
        assert!(TaskState::Preparing.can_transition_to(TaskState::Probing));
        assert!(TaskState::Probing.can_transition_to(TaskState::Downloading));
        assert!(TaskState::Downloading.can_transition_to(TaskState::Verifying));
        assert!(TaskState::Verifying.can_transition_to(TaskState::Finalizing));
        assert!(TaskState::Finalizing.can_transition_to(TaskState::Completed));
    }

    #[test]
    fn completed_is_terminal_without_explicit_restart() {
        assert!(!TaskState::Completed.can_transition_to(TaskState::Queued));
        assert!(!TaskState::Completed.can_transition_to(TaskState::Downloading));
        assert!(TaskState::Completed.can_restart_to(TaskState::Queued));
        assert!(!TaskState::Completed.can_restart_to(TaskState::Downloading));
    }

    #[test]
    fn legacy_status_aliases_map_to_shared_states() {
        assert_eq!(TaskState::from_status("error"), Some(TaskState::Failed));
        assert_eq!(TaskState::from_status("failed"), Some(TaskState::Failed));
        assert_eq!(TaskState::from_status("waiting"), Some(TaskState::Queued));
        assert_eq!(TaskState::from_status("starting"), Some(TaskState::Preparing));
        assert_eq!(TaskState::from_status("stopping"), Some(TaskState::Pausing));
        assert_eq!(TaskState::from_status("merging"), Some(TaskState::Finalizing));
        assert_eq!(TaskState::from_status("unknown-state"), None);
    }

    #[test]
    fn active_state_classification_includes_completion_pipeline() {
        for state in [
            TaskState::Preparing,
            TaskState::Probing,
            TaskState::Downloading,
            TaskState::Pausing,
            TaskState::Retrying,
            TaskState::Recovering,
            TaskState::Verifying,
            TaskState::Finalizing,
        ] {
            assert!(state.is_active(), "{state:?} must consume an active slot");
        }
        for state in [
            TaskState::Queued,
            TaskState::Paused,
            TaskState::Completed,
            TaskState::Failed,
            TaskState::Interrupted,
        ] {
            assert!(!state.is_active(), "{state:?} must not count as active");
        }
    }
}
