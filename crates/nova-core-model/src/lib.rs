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

#[cfg(test)]
mod tests {
    use super::Segment;

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
}
