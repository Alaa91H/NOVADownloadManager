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
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg",
            Self::YtDlp => "yt-dlp",
        }
    }

    pub const fn display_name(&self) -> &'static str {
        match self {
            Self::Ffmpeg => "FFmpeg",
            Self::YtDlp => "yt-dlp",
        }
    }

    #[allow(dead_code)]
    pub const fn description(&self) -> &'static str {
        match self {
            Self::Ffmpeg => "Media Processing Engine",
            Self::YtDlp => "Media URL Resolver",
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallScope {
    /// A NOVA-owned, per-user directory that is writable without elevation.
    #[default]
    User,
    /// A shared operating-system location. On Windows this is under
    /// `%ProgramFiles%` and requires the daemon process to be elevated.
    System,
}

impl ToolStatus {
    pub const fn is_available(&self) -> bool {
        matches!(self, Self::Installed)
    }

    pub const fn display_text(&self) -> &'static str {
        match self {
            Self::NotInstalled => "Not Installed",
            Self::Installed => "Installed",
            Self::UpdateAvailable => "Update Available",
            Self::Updating => "Updating",
            Self::Installing => "Installing",
            Self::Uninstalling => "Uninstalling",
            Self::Broken => "Broken",
            Self::Incompatible => "Incompatible",
            Self::PermissionDenied => "Permission Denied",
            Self::Unknown => "Unknown",
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
            id: id.to_owned(),
            name: name.to_owned(),
            description: description.to_owned(),
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
            raw: raw.to_owned(),
        }
    }

    pub const fn is_compatible_with(&self, minimum: &Self) -> bool {
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
    /// SHA-256 published by the release provider for the selected asset.
    /// Automatic installation is refused when a required checksum is absent.
    pub expected_sha256: Option<String>,
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
    pub const fn not_installed(tool_id: ToolId) -> Self {
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
#[serde(rename_all = "camelCase")]
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
#[allow(dead_code)]
pub struct InstallProgress {
    pub tool_id: String,
    pub phase: InstallPhase,
    pub progress: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
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
    #[serde(default)]
    pub install_scope: InstallScope,
    pub checksum_sha256: Option<String>,
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
            check_interval: "startup".to_owned(),
            auto_update: false,
        }
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ToolSource {
    pub name: &'static str,
    pub base_url: &'static str,
    pub platform_patterns: &'static [PlatformPattern],
    pub requires_checksum: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PlatformPattern {
    pub os: &'static str,
    pub arch: &'static str,
    pub pattern: &'static str,
    pub executable_name: &'static str,
}

#[allow(dead_code)]
pub const FFMPEG_MIN_VERSION: &str = "5.0";
#[allow(dead_code)]
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

#[allow(dead_code)]
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub timeout: Option<Duration>,
}
