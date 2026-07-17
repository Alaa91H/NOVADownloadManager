#![allow(dead_code)]

pub mod capabilities;
pub mod discovery;
pub mod health;
pub mod installer;
pub mod process;
pub mod registry;
pub mod tools;
pub mod types;

use capabilities::CapabilityResolver;
use types::{ExternalTool, ToolId, ToolInstallation, ToolRegistry, ToolState, UpdateInfo, Version};

use std::path::PathBuf;
use std::sync::Mutex;

pub struct ExternalToolManager {
    ffmpeg: tools::ffmpeg::FfmpegTool,
    yt_dlp: tools::yt_dlp::YtDlpTool,
    pub registry: Mutex<ToolRegistry>,
    pub resolver: Mutex<CapabilityResolver>,
    data_dir: String,
    http: reqwest::Client,
}

impl ExternalToolManager {
    pub fn new(data_dir: &str, http: reqwest::Client) -> Self {
        let registry = registry::load_registry(data_dir);
        Self {
            ffmpeg: tools::ffmpeg::FfmpegTool,
            yt_dlp: tools::yt_dlp::YtDlpTool,
            registry: Mutex::new(registry),
            resolver: Mutex::new(CapabilityResolver::new()),
            data_dir: data_dir.to_string(),
            http,
        }
    }

    fn tool_for_id(&self, tool_id: ToolId) -> &dyn ExternalTool {
        match tool_id {
            ToolId::Ffmpeg => &self.ffmpeg,
            ToolId::YtDlp => &self.yt_dlp,
        }
    }

    pub fn discover(&self, tool_id: ToolId) -> ToolInstallation {
        let tool = self.tool_for_id(tool_id);
        let reg = self.registry.lock().unwrap();
        let installation = self.discover_inner(tool, &reg);
        drop(reg);

        let mut resolver = self.resolver.lock().unwrap();
        resolver.update_installation(installation.clone());
        drop(resolver);

        installation
    }

    fn discover_inner(&self, tool: &dyn ExternalTool, reg: &ToolRegistry) -> ToolInstallation {
        let reg_entry = reg.tools.get(tool.id().as_str());
        let custom_path = reg_entry.map(|e| e.custom_path).unwrap_or(false);
        let installed_by_app = reg_entry.map(|e| e.installed_by_app).unwrap_or(false);

        if custom_path {
            if let Some(entry) = reg_entry {
                let path = PathBuf::from(&entry.path);
                if path.exists() {
                    let report = health::check_health(tool, &path);
                    let caps = if report.executable_works {
                        tool.capabilities()
                    } else {
                        Vec::new()
                    };
                    let version_str = report.version_detected.clone();
                    let installation = ToolInstallation {
                        tool_id: tool.id(),
                        status: report.status,
                        version: version_str.as_ref().map(|v| Version::new(v)),
                        path: Some(path),
                        custom_path: true,
                        installed_by_app,
                        capabilities: caps,
                        error_message: report.error_message,
                        last_health_check: Some(chrono::Utc::now().to_rfc3339()),
                        health_ok: report.executable_works,
                    };
                    let mut resolver = self.resolver.lock().unwrap();
                    resolver.update_installation(installation.clone());
                    return installation;
                }
            }
        }

        if let Some(candidate) = discovery::find_best_candidate(tool, reg) {
            let report = health::check_health(tool, &candidate.path);
            let caps = if report.executable_works {
                tool.capabilities()
            } else {
                Vec::new()
            };
            let version_str = report.version_detected.clone();

            let installation = ToolInstallation {
                tool_id: tool.id(),
                status: report.status,
                version: version_str.as_ref().map(|v| Version::new(v)),
                path: Some(candidate.path),
                custom_path: false,
                installed_by_app: false,
                capabilities: caps,
                error_message: report.error_message,
                last_health_check: Some(chrono::Utc::now().to_rfc3339()),
                health_ok: report.executable_works,
            };

            {
                let mut reg_owned = self.registry.lock().unwrap();
                let path_display = installation
                    .path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default();
                let ver_display = installation.version.as_ref().map(|v| v.to_string());
                registry::register_tool(
                    &mut reg_owned,
                    tool.id().as_str(),
                    &path_display,
                    ver_display.as_deref(),
                    false,
                    false,
                );
                let _ = registry::save_registry(&self.data_dir, &reg_owned);
            }

            {
                let mut resolver = self.resolver.lock().unwrap();
                resolver.update_installation(installation.clone());
            }

            installation
        } else {
            ToolInstallation::not_installed(tool.id())
        }
    }

    pub fn discover_all(&self) -> Vec<ToolInstallation> {
        let all_tools: Vec<ToolId> = vec![ToolId::Ffmpeg, ToolId::YtDlp];
        all_tools.into_iter().map(|id| self.discover(id)).collect()
    }

    pub fn check_health(&self, tool_id: ToolId) -> ToolInstallation {
        self.discover(tool_id)
    }

    pub fn check_for_updates(&self, tool_id: ToolId) -> UpdateInfo {
        let tool = self.tool_for_id(tool_id);
        installer::check_latest_version(tool, &self.http)
    }

    pub fn update(&self, tool_id: ToolId) -> Result<String, String> {
        let tool = self.tool_for_id(tool_id);
        let update_info = self.check_for_updates(tool_id);

        if !update_info.available {
            return Err("No update available".to_string());
        }

        let install_dir = self.get_install_dir(tool_id);
        installer::download_and_install(
            tool,
            &update_info,
            &install_dir,
            &self.http,
            &self.data_dir,
        )
    }

    pub fn set_custom_path(&self, tool_id: ToolId, path: &str) -> Result<ToolInstallation, String> {
        let tool = self.tool_for_id(tool_id);
        let path_buf = PathBuf::from(path);

        if !path_buf.exists() {
            return Err(format!("Path does not exist: {}", path));
        }

        let report = health::check_health(tool, &path_buf);
        let caps = if report.executable_works {
            tool.capabilities()
        } else {
            Vec::new()
        };

        let version_str = report.version_detected.clone();

        let installation = ToolInstallation {
            tool_id,
            status: report.status,
            version: version_str.as_ref().map(|v| Version::new(v)),
            path: Some(path_buf),
            custom_path: true,
            installed_by_app: false,
            capabilities: caps,
            error_message: report.error_message,
            last_health_check: Some(chrono::Utc::now().to_rfc3339()),
            health_ok: report.executable_works,
        };

        {
            let mut reg = self.registry.lock().unwrap();
            registry::update_tool_path(&mut reg, tool_id.as_str(), path);
            if let Some(ref ver) = installation.version {
                registry::update_tool_version(&mut reg, tool_id.as_str(), &ver.to_string());
            }
            let _ = registry::save_registry(&self.data_dir, &reg);
        }

        {
            let mut resolver = self.resolver.lock().unwrap();
            resolver.update_installation(installation.clone());
        }

        Ok(installation)
    }

    pub fn uninstall(&self, tool_id: ToolId) -> Result<(), String> {
        let tool = self.tool_for_id(tool_id);
        let installation = self.discover(tool_id);

        let path = installation.path.ok_or("Tool is not installed")?;

        installer::uninstall_tool(tool, &path, installation.installed_by_app, &self.data_dir)?;

        {
            let mut resolver = self.resolver.lock().unwrap();
            resolver.remove_installation(tool_id);
        }

        Ok(())
    }

    pub fn get_install_dir(&self, tool_id: ToolId) -> PathBuf {
        let base = PathBuf::from(&self.data_dir).join("external_tools");
        match tool_id {
            ToolId::Ffmpeg => base.join("ffmpeg"),
            ToolId::YtDlp => base.join("yt-dlp"),
        }
    }

    pub fn tool_state(&self, tool_id: ToolId) -> ToolState {
        let installation = self.discover(tool_id);
        let tool = self.tool_for_id(tool_id);

        let update_info = self.check_for_updates(tool_id);

        let all_caps = tool.capabilities();
        let tool_caps: Vec<types::ToolCapability> = all_caps
            .iter()
            .map(|c| types::ToolCapability {
                id: c.id.clone(),
                name: c.name.clone(),
                available: installation.status.is_available(),
                requires: None,
            })
            .collect();

        ToolState {
            id: tool_id.as_str().to_string(),
            name: tool.name().to_string(),
            description: tool.description().to_string(),
            status: installation.status.display_text().to_string(),
            version: installation.version.as_ref().map(|v| v.to_string()),
            latest_version: update_info.latest_version.clone(),
            path: installation.path.as_ref().map(|p| p.display().to_string()),
            custom_path: installation.custom_path,
            installed_by_app: installation.installed_by_app,
            capabilities: tool_caps,
            update_available: update_info.available,
            is_installing: false,
            is_updating: false,
            is_uninstalling: false,
            health_ok: installation.health_ok,
            error: installation.error_message,
            download_url: update_info.download_url,
            source_url: Some(tool.source().base_url.to_string()),
            source_name: Some(tool.source().name.to_string()),
        }
    }

    pub fn all_tool_states(&self) -> Vec<ToolState> {
        vec![
            self.tool_state(ToolId::Ffmpeg),
            self.tool_state(ToolId::YtDlp),
        ]
    }

    pub fn has_capability(&self, capability_id: &str) -> bool {
        let resolver = self.resolver.lock().unwrap();
        resolver.is_capable(capability_id)
    }

    pub fn resolve_capability(&self, capability_id: &str) -> capabilities::CapabilityAvailability {
        let resolver = self.resolver.lock().unwrap();
        resolver.resolve_capability(capability_id)
    }

    pub fn ytdlp_path(&self) -> Option<String> {
        let resolver = self.resolver.lock().unwrap();
        resolver.tool_path(ToolId::YtDlp)
    }

    pub fn ffmpeg_path(&self) -> Option<String> {
        let resolver = self.resolver.lock().unwrap();
        resolver.tool_path(ToolId::Ffmpeg)
    }

    pub fn is_ytdlp_available(&self) -> bool {
        self.has_capability("media.resolve")
    }

    pub fn is_ffmpeg_available(&self) -> bool {
        self.has_capability("media.merge")
    }

    pub fn discover_and_initialize(&self) {
        let _ = self.discover_all();
        log::info!(
            "External tools initialized: yt-dlp={}, ffmpeg={}",
            self.is_ytdlp_available(),
            self.is_ffmpeg_available()
        );
    }
}
