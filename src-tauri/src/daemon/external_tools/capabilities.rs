use super::types::{ToolId, ToolInstallation};
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct CapabilityAvailability {
    pub capability_id: String,
    pub available: bool,
    pub tool_id: ToolId,
    pub requires_message: Option<String>,
}

pub struct CapabilityResolver {
    installations: HashMap<ToolId, ToolInstallation>,
}

impl CapabilityResolver {
    pub fn new() -> Self {
        Self {
            installations: HashMap::new(),
        }
    }

    pub fn update_installation(&mut self, installation: ToolInstallation) {
        self.installations
            .insert(installation.tool_id, installation);
    }

    pub fn remove_installation(&mut self, tool_id: ToolId) {
        self.installations.remove(&tool_id);
    }

    pub fn is_capable(&self, capability_id: &str) -> bool {
        self.installations.values().any(|inst| {
            inst.status.is_available() && inst.capabilities.iter().any(|c| c.id == capability_id)
        })
    }

    pub fn resolve_capability(&self, capability_id: &str) -> CapabilityAvailability {
        for installation in self.installations.values() {
            if installation.status.is_available() {
                if let Some(_cap) = installation
                    .capabilities
                    .iter()
                    .find(|c| c.id == capability_id)
                {
                    return CapabilityAvailability {
                        capability_id: capability_id.to_string(),
                        available: true,
                        tool_id: installation.tool_id,
                        requires_message: None,
                    };
                }
            }
        }

        let required_tool = match capability_id {
            id if id.starts_with("media.") => {
                if matches!(
                    capability_id,
                    "media.resolve"
                        | "media.metadata"
                        | "media.format_discovery"
                        | "media.platform_extraction"
                        | "media.direct_url_resolution"
                ) {
                    ToolId::YtDlp
                } else {
                    ToolId::Ffmpeg
                }
            }
            _ => ToolId::Ffmpeg,
        };

        CapabilityAvailability {
            capability_id: capability_id.to_string(),
            available: false,
            tool_id: required_tool,
            requires_message: Some(format!(
                "This feature requires {}. Install {} from Settings > External Tools.",
                required_tool.display_name(),
                required_tool.display_name()
            )),
        }
    }

    pub fn all_capabilities(&self) -> Vec<CapabilityAvailability> {
        let mut all_caps: Vec<String> = Vec::new();
        for installation in self.installations.values() {
            for cap in &installation.capabilities {
                if !all_caps.contains(&cap.id) {
                    all_caps.push(cap.id.clone());
                }
            }
        }

        all_caps
            .into_iter()
            .map(|cap_id| self.resolve_capability(&cap_id))
            .collect()
    }

    pub fn get_installed_tool(&self, tool_id: ToolId) -> Option<&ToolInstallation> {
        self.installations.get(&tool_id)
    }

    pub fn tool_path(&self, tool_id: ToolId) -> Option<String> {
        self.installations
            .get(&tool_id)
            .filter(|i| i.status.is_available())
            .and_then(|i| i.path.as_ref())
            .map(|p| p.display().to_string())
    }
}

impl Default for CapabilityResolver {
    fn default() -> Self {
        Self::new()
    }
}

pub fn get_feature_requirements(feature: &str) -> Vec<(&'static str, ToolId)> {
    match feature {
        "media.merge"
        | "media.remux"
        | "media.transcode"
        | "media.audio_extract"
        | "media.video_convert"
        | "media.thumbnail_extract"
        | "media.media_probe" => {
            vec![("FFmpeg", ToolId::Ffmpeg)]
        }
        "media.resolve"
        | "media.metadata"
        | "media.format_discovery"
        | "media.platform_extraction"
        | "media.direct_url_resolution" => {
            vec![("yt-dlp", ToolId::YtDlp)]
        }
        "media.extract_and_process" => vec![("yt-dlp", ToolId::YtDlp), ("FFmpeg", ToolId::Ffmpeg)],
        _ => vec![],
    }
}
