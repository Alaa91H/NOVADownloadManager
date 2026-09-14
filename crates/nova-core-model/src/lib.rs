//! Platform-neutral NOVA task models.
//!
//! This crate intentionally contains no Tauri, HTTP-server, filesystem,
//! subprocess, or Android/JNI dependencies. Hosts serialize these records at
//! their own boundaries while the domain schema remains stable across desktop
//! and mobile clients.

use serde::{Deserialize, Serialize};

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
        plan_byte_ranges, plan_http_resume, ByteRange, ResumeAction, Segment,
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
}
