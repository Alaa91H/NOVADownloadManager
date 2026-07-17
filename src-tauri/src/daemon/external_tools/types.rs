use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolId {
    Ffmpeg,
    YtDlp,
}

impl ToolId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolId::Ffmpeg => "ffmpeg",
            ToolId::YtDlp => "yt-dlp",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            ToolId::Ffmpeg => "FFmpeg",
            ToolId::YtDlp => "yt-dlp",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            ToolId::Ffmpeg => "Media Processing Engine",
            ToolId::YtDlp => "Media URL Resolver",
        }
    }
}

impl fmt::Display for ToolId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ToolStatus {
    NotInstalled,
    Installed,
    UpdateAvailable,
    Updating,
    Installing,
    Uninstalling,
    Broken,
    Incompatible,
    PermissionDenied,
    Unknown,
}

impl ToolStatus {
    pub fn is_available(&self) -> bool {
        matches!(self, ToolStatus::Installed)
    }

    pub fn display_text(&self) -> &'static str {
        match self {
            ToolStatus::NotInstalled => "Not Installed",
            ToolStatus::Installed => "Installed",
            ToolStatus::UpdateAvailable => "Update Available",
            ToolStatus::Updating => "Updating",
            ToolStatus::Installing => "Installing",
            ToolStatus::Uninstalling => "Uninstalling",
            ToolStatus::Broken => "Broken",
            ToolStatus::Incompatible => "Incompatible",
            ToolStatus::PermissionDenied => "Permission Denied",
            ToolStatus::Unknown => "Unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub description: String,
}

impl Capability {
    pub fn new(id: &str, name: &str, description: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub pre_release: Option<String>,
    pub build_metadata: Option<String>,
    pub raw: String,
}

impl Version {
    pub fn new(raw: &str) -> Self {
        let cleaned = raw.trim().trim_start_matches('v').trim_start_matches('V');
        let parts: Vec<&str> = cleaned.split('.').collect();
        let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        Self {
            major,
            minor,
            patch,
            pre_release: None,
            build_metadata: None,
            raw: raw.to_string(),
        }
    }

    pub fn is_compatible_with(&self, minimum: &Version) -> bool {
        if self.major > minimum.major {
            return true;
        }
        if self.major < minimum.major {
            return false;
        }
        if self.minor > minimum.minor {
            return true;
        }
        if self.minor < minimum.minor {
            return false;
        }
        self.patch >= minimum.patch
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.raw)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub download_url: Option<String>,
    pub release_notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInstallation {
    pub tool_id: ToolId,
    pub status: ToolStatus,
    pub version: Option<Version>,
    pub path: Option<PathBuf>,
    pub custom_path: bool,
    pub installed_by_app: bool,
    pub capabilities: Vec<Capability>,
    pub error_message: Option<String>,
    pub last_health_check: Option<String>,
    pub health_ok: bool,
}

impl ToolInstallation {
    pub fn not_installed(tool_id: ToolId) -> Self {
        Self {
            tool_id,
            status: ToolStatus::NotInstalled,
            version: None,
            path: None,
            custom_path: false,
            installed_by_app: false,
            capabilities: Vec::new(),
            error_message: None,
            last_health_check: None,
            health_ok: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolState {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub path: Option<String>,
    pub custom_path: bool,
    pub installed_by_app: bool,
    pub capabilities: Vec<ToolCapability>,
    pub update_available: bool,
    pub is_installing: bool,
    pub is_updating: bool,
    pub is_uninstalling: bool,
    pub health_ok: bool,
    pub error: Option<String>,
    pub download_url: Option<String>,
    pub source_url: Option<String>,
    pub source_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCapability {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub requires: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolPathCandidate {
    pub path: PathBuf,
    pub source: String,
    pub exists: bool,
    pub is_executable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallProgress {
    pub tool_id: String,
    pub phase: InstallPhase,
    pub progress: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum InstallPhase {
    Downloading,
    Verifying,
    Extracting,
    Installing,
    Validating,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRegistryEntry {
    pub tool_id: String,
    pub path: String,
    pub version: Option<String>,
    pub installed_by_app: bool,
    pub installed_at: Option<String>,
    pub custom_path: bool,
    pub auto_update: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRegistry {
    pub tools: HashMap<String, ToolRegistryEntry>,
    pub auto_check_updates: bool,
    pub check_interval: String,
    pub auto_update: bool,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self {
            tools: HashMap::new(),
            auto_check_updates: true,
            check_interval: "startup".to_string(),
            auto_update: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolSource {
    pub name: &'static str,
    pub base_url: &'static str,
    pub platform_patterns: &'static [PlatformPattern],
    pub requires_checksum: bool,
}

#[derive(Debug, Clone)]
pub struct PlatformPattern {
    pub os: &'static str,
    pub arch: &'static str,
    pub pattern: &'static str,
    pub executable_name: &'static str,
}

pub const FFMPEG_MIN_VERSION: &str = "5.0";
pub const YTDLP_MIN_VERSION: &str = "2024.01.01";

pub trait ExternalTool: Send + Sync {
    fn id(&self) -> ToolId;
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn executable_names(&self) -> Vec<&'static str>;
    fn default_search_paths(&self) -> Vec<PathBuf>;
    fn version_args(&self) -> &'static [&'static str];
    fn parse_version(&self, output: &str) -> Option<Version>;
    fn capabilities(&self) -> Vec<Capability>;
    fn source(&self) -> ToolSource;
    fn minimum_version(&self) -> Version;
    fn version_command_timeout(&self) -> Duration {
        Duration::from_secs(10)
    }
}

pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub timeout: Option<Duration>,
}
