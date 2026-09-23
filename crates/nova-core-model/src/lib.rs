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

/// Schema version for durable, platform-neutral recovery checkpoints.
pub const RECOVERY_SCHEMA_VERSION: u32 = 1;

/// HTTP representation identity captured before bytes are persisted.
///
/// The effective URL is diagnostic/routing metadata and is deliberately not
/// used by itself as an identity validator because signed/CDN URLs may
/// legitimately change while still addressing the same representation.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResourceIdentity {
    #[serde(rename = "effectiveUrl", default)]
    pub effective_url: Option<String>,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(rename = "lastModified", default)]
    pub last_modified: Option<String>,
    #[serde(rename = "contentLength", default)]
    pub content_length: Option<u64>,
}

impl ResourceIdentity {
    /// Returns the strongest value that is valid for an HTTP If-Range request.
    ///
    /// Weak ETags cannot safely validate byte ranges, so they are skipped in
    /// favour of Last-Modified when available.
    pub fn if_range_value(&self) -> Option<&str> {
        self.etag
            .as_deref()
            .filter(|etag| !etag.trim_start().starts_with("W/"))
            .or(self.last_modified.as_deref())
    }

    /// Whether this checkpoint contains evidence that must be re-confirmed
    /// before already-written bytes may be trusted.
    pub fn has_identity_evidence(&self) -> bool {
        self.etag.is_some() || self.last_modified.is_some() || self.content_length.is_some()
    }
}

/// Result of comparing the persisted representation with a fresh probe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceContinuity {
    /// A byte-stable validator (strong ETag or Last-Modified) matched.
    Confirmed,
    /// At least one persisted identity field positively disagreed.
    Changed,
    /// The fresh response did not provide enough evidence to prove continuity.
    Unknown,
}

/// Compare a persisted representation identity with a fresh server probe.
///
/// Size mismatches and validator mismatches always mean the resource changed.
/// Strong ETags are preferred; Last-Modified is the safe fallback. Equal weak
/// ETags are not treated as byte-level proof because weak validators explicitly
/// allow semantically equivalent but byte-different representations.
pub fn compare_resource_identity(
    previous: &ResourceIdentity,
    current: &ResourceIdentity,
) -> ResourceContinuity {
    if let (Some(old), Some(new)) = (previous.content_length, current.content_length) {
        if old != new {
            return ResourceContinuity::Changed;
        }
    }

    if let Some(old_etag) = previous.etag.as_deref() {
        match current.etag.as_deref() {
            Some(new_etag) if new_etag != old_etag => return ResourceContinuity::Changed,
            Some(new_etag)
                if new_etag == old_etag && !old_etag.trim_start().starts_with("W/") =>
            {
                return ResourceContinuity::Confirmed;
            }
            Some(_) => {}
            None => return ResourceContinuity::Unknown,
        }
    }

    if let Some(old_modified) = previous.last_modified.as_deref() {
        return match current.last_modified.as_deref() {
            Some(new_modified) if new_modified == old_modified => ResourceContinuity::Confirmed,
            Some(_) => ResourceContinuity::Changed,
            None => ResourceContinuity::Unknown,
        };
    }

    ResourceContinuity::Unknown
}

/// Durable per-segment state. Transient speed/activity fields are intentionally
/// omitted so a restored task always starts from neutral runtime state.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecoverySegment {
    pub id: u32,
    #[serde(rename = "startByte")]
    pub start_byte: u64,
    #[serde(rename = "endByte")]
    pub end_byte: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
}

/// Platform-neutral crash-recovery checkpoint shared by desktop and mobile.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecoveryCheckpoint {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(default)]
    pub segments: Vec<RecoverySegment>,
    #[serde(default)]
    pub resource: ResourceIdentity,
}

impl RecoveryCheckpoint {
    pub fn from_task(task: &Task, resource: ResourceIdentity) -> Self {
        let segments = task
            .segments
            .iter()
            .map(|segment| {
                let range_len = if segment.end_byte >= segment.start_byte {
                    segment.end_byte - segment.start_byte + 1
                } else {
                    segment.total_bytes
                };
                let total_bytes = if segment.total_bytes > 0 {
                    segment.total_bytes
                } else {
                    range_len
                };
                RecoverySegment {
                    id: segment.id,
                    start_byte: segment.start_byte,
                    end_byte: segment.end_byte,
                    total_bytes,
                    downloaded_bytes: if total_bytes > 0 {
                        segment.downloaded_bytes.min(total_bytes)
                    } else {
                        segment.downloaded_bytes
                    },
                }
            })
            .collect();

        Self {
            schema_version: RECOVERY_SCHEMA_VERSION,
            task_id: task.id.clone(),
            downloaded_bytes: task.downloaded_bytes.min(if task.size_bytes > 0 {
                task.size_bytes
            } else {
                task.downloaded_bytes
            }),
            size_bytes: task.size_bytes,
            segments,
            resource,
        }
    }

    /// Restore durable fields into an existing task model.
    ///
    /// Returns false when the checkpoint belongs to another task or an unknown
    /// future schema. Runtime-only speed/activity values are reset.
    pub fn apply_to_task(&self, task: &mut Task) -> bool {
        if self.schema_version != RECOVERY_SCHEMA_VERSION || self.task_id != task.id {
            return false;
        }

        if self.size_bytes > 0 {
            task.size_bytes = self.size_bytes;
        }
        task.downloaded_bytes = if task.size_bytes > 0 {
            self.downloaded_bytes.min(task.size_bytes)
        } else {
            self.downloaded_bytes
        };
        task.speed_bytes_per_sec = 0;
        task.time_left_seconds = 0;

        if !self.segments.is_empty() {
            task.segments = self
                .segments
                .iter()
                .map(|segment| {
                    let range_total = if segment.end_byte >= segment.start_byte {
                        segment.end_byte - segment.start_byte + 1
                    } else {
                        0
                    };
                    let total = if segment.total_bytes > 0 {
                        segment.total_bytes
                    } else {
                        range_total
                    };
                    let downloaded = segment.downloaded_bytes.min(total);
                    Segment {
                        id: segment.id,
                        progress: if total > 0 {
                            downloaded as f64 / total as f64
                        } else {
                            0.0
                        },
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                        active: false,
                        speed: 0,
                        start_byte: segment.start_byte,
                        end_byte: segment.end_byte,
                    }
                })
                .collect();
        }

        true
    }
}

/// Make the final corruption-avoidance decision for an HTTP resume.
///
/// Legacy checkpoints with no identity evidence preserve NOVA's existing
/// Content-Range safety rule. Once a checkpoint has validators/size metadata,
/// that evidence must be re-confirmed before append is allowed.
pub fn plan_http_recovery(
    existing_bytes: u64,
    response_status: u16,
    content_range_start: Option<u64>,
    previous: &ResourceIdentity,
    current: &ResourceIdentity,
) -> ResumeAction {
    if existing_bytes > 0 && previous.has_identity_evidence() {
        if compare_resource_identity(previous, current) != ResourceContinuity::Confirmed {
            return ResumeAction::Restart;
        }
    }

    plan_http_resume(existing_bytes, response_status, content_range_start)
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
        compare_resource_identity, plan_byte_ranges, plan_http_recovery, plan_http_resume,
        ByteRange, RecoveryCheckpoint, ResourceContinuity, ResourceIdentity, ResumeAction, Segment,
        MAX_PARALLEL_SEGMENTS, RECOVERY_SCHEMA_VERSION,
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
    fn strong_etag_confirms_resource_continuity() {
        let previous = ResourceIdentity {
            etag: Some("\"v1\"".to_owned()),
            content_length: Some(1024),
            ..ResourceIdentity::default()
        };
        let current = previous.clone();
        assert_eq!(
            compare_resource_identity(&previous, &current),
            ResourceContinuity::Confirmed
        );
        assert_eq!(previous.if_range_value(), Some("\"v1\""));
    }

    #[test]
    fn changed_etag_or_length_forces_recovery_restart() {
        let previous = ResourceIdentity {
            etag: Some("\"v1\"".to_owned()),
            content_length: Some(1024),
            ..ResourceIdentity::default()
        };
        let changed = ResourceIdentity {
            etag: Some("\"v2\"".to_owned()),
            content_length: Some(1024),
            ..ResourceIdentity::default()
        };
        assert_eq!(
            plan_http_recovery(512, 206, Some(512), &previous, &changed),
            ResumeAction::Restart
        );

        let resized = ResourceIdentity {
            etag: Some("\"v1\"".to_owned()),
            content_length: Some(2048),
            ..ResourceIdentity::default()
        };
        assert_eq!(
            compare_resource_identity(&previous, &resized),
            ResourceContinuity::Changed
        );
    }

    #[test]
    fn missing_validator_does_not_trust_existing_bytes() {
        let previous = ResourceIdentity {
            last_modified: Some("Wed, 21 Oct 2015 07:28:00 GMT".to_owned()),
            content_length: Some(1024),
            ..ResourceIdentity::default()
        };
        let current = ResourceIdentity {
            content_length: Some(1024),
            ..ResourceIdentity::default()
        };
        assert_eq!(
            compare_resource_identity(&previous, &current),
            ResourceContinuity::Unknown
        );
        assert_eq!(
            plan_http_recovery(512, 206, Some(512), &previous, &current),
            ResumeAction::Restart
        );
    }

    #[test]
    fn weak_etag_uses_last_modified_for_if_range() {
        let identity = ResourceIdentity {
            etag: Some("W/\"semantic\"".to_owned()),
            last_modified: Some("Wed, 21 Oct 2015 07:28:00 GMT".to_owned()),
            ..ResourceIdentity::default()
        };
        assert_eq!(
            identity.if_range_value(),
            Some("Wed, 21 Oct 2015 07:28:00 GMT")
        );
    }

    #[test]
    fn recovery_checkpoint_preserves_legacy_segment_total() {
        let task = Task {
            id: "legacy".to_owned(),
            name: "legacy.bin".to_owned(),
            url: "https://example.com/legacy.bin".to_owned(),
            file_type: "other".to_owned(),
            status: "paused".to_owned(),
            size_bytes: 100,
            downloaded_bytes: 50,
            speed_bytes_per_sec: 0,
            time_left_seconds: 0,
            elapsed_seconds: 0,
            date_added: "2026-09-24".to_owned(),
            category: "other".to_owned(),
            queue_id: "main".to_owned(),
            connections: 1,
            resumable: true,
            save_path: "legacy.bin".to_owned(),
            description: String::new(),
            segments: vec![Segment {
                id: 0,
                progress: 0.5,
                downloaded_bytes: 50,
                total_bytes: 100,
                active: false,
                speed: 0,
                start_byte: 0,
                end_byte: 0,
            }],
            referer: None,
            engine: "libcurl-multi".to_owned(),
            engine_id: "legacy".to_owned(),
            engine_status: None,
            error_message: None,
        };
        let checkpoint =
            RecoveryCheckpoint::from_task(&task, ResourceIdentity::default());
        let mut restored = task.clone();
        restored.segments.clear();
        assert!(checkpoint.apply_to_task(&mut restored));
        assert_eq!(restored.segments[0].total_bytes, 100);
        assert_eq!(restored.segments[0].downloaded_bytes, 50);
    }

    #[test]
    fn recovery_checkpoint_restores_durable_state_only() {
        let mut task = Task {
            id: "task-1".to_owned(),
            name: "payload.bin".to_owned(),
            url: "https://example.com/payload.bin".to_owned(),
            file_type: "other".to_owned(),
            status: "downloading".to_owned(),
            size_bytes: 100,
            downloaded_bytes: 50,
            speed_bytes_per_sec: 999,
            time_left_seconds: 9,
            elapsed_seconds: 3,
            date_added: "2026-09-24".to_owned(),
            category: "other".to_owned(),
            queue_id: "main".to_owned(),
            connections: 1,
            resumable: true,
            save_path: "payload.bin".to_owned(),
            description: String::new(),
            segments: vec![Segment {
                id: 0,
                progress: 0.5,
                downloaded_bytes: 50,
                total_bytes: 100,
                active: true,
                speed: 999,
                start_byte: 0,
                end_byte: 99,
            }],
            referer: None,
            engine: "libcurl-multi".to_owned(),
            engine_id: "task-1".to_owned(),
            engine_status: None,
            error_message: None,
        };
        let checkpoint = RecoveryCheckpoint::from_task(
            &task,
            ResourceIdentity {
                etag: Some("\"stable\"".to_owned()),
                content_length: Some(100),
                ..ResourceIdentity::default()
            },
        );
        assert_eq!(checkpoint.schema_version, RECOVERY_SCHEMA_VERSION);

        task.downloaded_bytes = 0;
        task.speed_bytes_per_sec = 123;
        task.segments.clear();
        assert!(checkpoint.apply_to_task(&mut task));
        assert_eq!(task.downloaded_bytes, 50);
        assert_eq!(task.speed_bytes_per_sec, 0);
        assert_eq!(task.segments.len(), 1);
        assert!(!task.segments[0].active);
        assert_eq!(task.segments[0].speed, 0);
    }
}
