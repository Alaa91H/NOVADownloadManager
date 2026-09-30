//! Versioned runtime capability registry shared by NOVA clients.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::control_plane::CapabilityStatus;

/// One runtime feature with its live availability, limits, and source evidence.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityEntry {
    pub id: String,
    pub version: u32,
    pub status: CapabilityStatus,
    #[serde(default)]
    pub platforms: Vec<String>,
    /// Adapter coverage is supplied by the parity manifest when known. An
    /// empty map means this runtime response makes no client-parity claim.
    #[serde(default)]
    pub client_adapters: BTreeMap<String, CapabilityStatus>,
    #[serde(default)]
    pub operations: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub constraints: BTreeMap<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
}

/// Runtime-owned registry snapshot with deterministic entry ordering.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRegistry {
    pub schema_version: u32,
    pub source_of_truth: String,
    pub entries: Vec<CapabilityEntry>,
}

impl CapabilityRegistry {
    pub fn new(schema_version: u32, mut entries: Vec<CapabilityEntry>) -> Self {
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        Self {
            schema_version,
            source_of_truth: "rust-runtime".to_owned(),
            entries,
        }
    }
}
