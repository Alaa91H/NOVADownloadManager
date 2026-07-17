use super::types::{ToolRegistry, ToolRegistryEntry};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const REGISTRY_FILENAME: &str = "external_tools.json";

#[derive(Debug, Serialize, Deserialize)]
pub struct PersistedRegistry {
    pub registry: ToolRegistry,
}

pub fn registry_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join(REGISTRY_FILENAME)
}

pub fn load_registry(data_dir: &str) -> ToolRegistry {
    let path = registry_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ToolRegistry::default(),
    }
}

pub fn save_registry(data_dir: &str, registry: &ToolRegistry) -> Result<(), String> {
    let path = registry_path(data_dir);
    let json = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialize registry: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write registry to {}: {}", path.display(), e))
}

pub fn register_tool(
    registry: &mut ToolRegistry,
    tool_id: &str,
    path: &str,
    version: Option<&str>,
    installed_by_app: bool,
    custom_path: bool,
) {
    registry.tools.insert(
        tool_id.to_string(),
        ToolRegistryEntry {
            tool_id: tool_id.to_string(),
            path: path.to_string(),
            version: version.map(|s| s.to_string()),
            installed_by_app,
            installed_at: Some(chrono::Utc::now().to_rfc3339()),
            custom_path,
            auto_update: false,
        },
    );
}

pub fn unregister_tool(registry: &mut ToolRegistry, tool_id: &str) {
    registry.tools.remove(tool_id);
}

pub fn update_tool_path(registry: &mut ToolRegistry, tool_id: &str, path: &str) {
    if let Some(entry) = registry.tools.get_mut(tool_id) {
        entry.path = path.to_string();
        entry.custom_path = true;
    }
}

pub fn update_tool_version(registry: &mut ToolRegistry, tool_id: &str, version: &str) {
    if let Some(entry) = registry.tools.get_mut(tool_id) {
        entry.version = Some(version.to_string());
    }
}
