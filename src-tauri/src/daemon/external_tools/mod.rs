pub mod capabilities;
pub mod discovery;
pub mod health;
pub mod installer;
pub mod registry;
pub mod tools;
pub mod types;

use capabilities::CapabilityResolver;
use types::{
    ExternalTool, InstallScope, ToolId, ToolInstallation, ToolRegistry, ToolState, UpdateInfo,
    Version,
};

use std::path::PathBuf;
use std::sync::Mutex;

use crate::lock_or_err;

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
            data_dir: data_dir.to_owned(),
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
        let mut reg = lock_or_err!(self.registry);
        let installation = self.discover_inner(tool, &mut reg);
        drop(reg);

        let mut resolver = lock_or_err!(self.resolver);
        resolver.update_installation(installation.clone());
        drop(resolver);

        installation
    }

    fn discover_inner(&self, tool: &dyn ExternalTool, reg: &mut ToolRegistry) -> ToolInstallation {
        let reg_entry = reg.tools.get(tool.id().as_str());
        let custom_path = reg_entry.is_some_and(|e| e.custom_path);
        let installed_by_app = reg_entry.is_some_and(|e| e.installed_by_app);

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
                let path_display = installation
                    .path
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default();
                let ver_display = installation
                    .version
                    .as_ref()
                    .map(std::string::ToString::to_string);
                registry::register_tool(
                    reg,
                    tool.id().as_str(),
                    &path_display,
                    ver_display.as_deref(),
                    false,
                    false,
                    InstallScope::User,
                );
                let _ = registry::save_registry(&self.data_dir, reg);
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

    /// Download and register the current verified release for a tool that is
    /// absent or unhealthy. System-managed tools are never overwritten: users
    /// may adopt one explicitly through a custom path, while NOVA manages only
    /// files it installs under its data directory.
    pub fn install_in_scope(&self, tool_id: ToolId, scope: InstallScope) -> Result<String, String> {
        let existing = self.discover(tool_id);
        if existing.health_ok && !existing.installed_by_app {
            return Err(format!(
                "{} is already available at {} and is not managed by NOVA. Use its existing installation or set a custom path instead.",
                self.tool_for_id(tool_id).name(),
                existing
                    .path
                    .as_ref()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "the system path".to_owned())
            ));
        }
        self.install_verified_release(tool_id, scope)
    }

    pub fn update(&self, tool_id: ToolId) -> Result<String, String> {
        let existing = self.discover(tool_id);
        if !existing.installed_by_app {
            return Err(format!(
                "{} is not managed by NOVA and cannot be updated automatically.",
                self.tool_for_id(tool_id).name()
            ));
        }
        let scope = lock_or_err!(self.registry)
            .tools
            .get(tool_id.as_str())
            .map(|entry| entry.install_scope)
            .unwrap_or_default();
        self.install_verified_release(tool_id, scope)
    }

    fn install_verified_release(
        &self,
        tool_id: ToolId,
        scope: InstallScope,
    ) -> Result<String, String> {
        let tool = self.tool_for_id(tool_id);
        let update_info = self.check_for_updates(tool_id);

        if !update_info.available {
            return Err(
                "No compatible verified release is currently available for automatic installation"
                    .to_owned(),
            );
        }

        let install_dir = self.get_install_dir(tool_id, scope)?;
        let path = installer::download_and_install(
            tool,
            &update_info,
            &install_dir,
            &self.http,
            &self.data_dir,
            scope,
        )?;
        // Re-discover immediately so the capability resolver and Settings UI
        // observe an app-managed binary without requiring a restart.
        let installation = self.discover(tool_id);
        if !installation.health_ok {
            return Err(installation.error_message.unwrap_or_else(|| {
                format!(
                    "{} was installed but did not pass the post-install health check",
                    tool.name()
                )
            }));
        }
        Ok(path)
    }

    pub fn set_custom_path(&self, tool_id: ToolId, path: &str) -> Result<ToolInstallation, String> {
        let tool = self.tool_for_id(tool_id);
        let path_buf = PathBuf::from(path);

        if !path_buf.exists() {
            return Err(format!("Path does not exist: {path}"));
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
            let mut reg = lock_or_err!(self.registry);
            registry::update_tool_path(&mut reg, tool_id.as_str(), path);
            if let Some(ref ver) = installation.version {
                registry::update_tool_version(&mut reg, tool_id.as_str(), &ver.to_string());
            }
            let _ = registry::save_registry(&self.data_dir, &reg);
        }

        {
            let mut resolver = lock_or_err!(self.resolver);
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
            let mut resolver = lock_or_err!(self.resolver);
            resolver.remove_installation(tool_id);
        }

        Ok(())
    }

    pub fn get_install_dir(&self, tool_id: ToolId, scope: InstallScope) -> Result<PathBuf, String> {
        let tool_dir = match tool_id {
            ToolId::Ffmpeg => "FFmpeg",
            ToolId::YtDlp => "YT-DLP",
        };
        match scope {
            InstallScope::User => Ok(PathBuf::from(&self.data_dir)
                .join("external_tools")
                .join(tool_id.as_str())),
            InstallScope::System => {
                #[cfg(windows)]
                {
                    let program_files = std::env::var_os("PROGRAMFILES").ok_or(
                        "Program Files is unavailable; choose the current-user installation instead.",
                    )?;
                    Ok(PathBuf::from(program_files).join(tool_dir))
                }
                #[cfg(not(windows))]
                {
                    let _ = tool_dir;
                    Err("System-wide external-tool installation is currently supported on Windows only. Choose the current-user installation on this platform.".to_owned())
                }
            }
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
            id: tool_id.as_str().to_owned(),
            name: tool.name().to_owned(),
            description: tool.description().to_owned(),
            status: installation.status.display_text().to_owned(),
            version: installation
                .version
                .as_ref()
                .map(std::string::ToString::to_string),
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
            source_url: Some(tool.source().base_url.to_owned()),
            source_name: Some(tool.source().name.to_owned()),
        }
    }

    pub fn all_tool_states(&self) -> Vec<ToolState> {
        vec![
            self.tool_state(ToolId::Ffmpeg),
            self.tool_state(ToolId::YtDlp),
        ]
    }

    pub fn resolve_capability(&self, capability_id: &str) -> capabilities::CapabilityAvailability {
        let resolver = lock_or_err!(self.resolver);
        resolver.resolve_capability(capability_id)
    }

    #[allow(dead_code)]
    pub fn ytdlp_path(&self) -> Option<String> {
        let resolver = lock_or_err!(self.resolver);
        resolver.tool_path(ToolId::YtDlp)
    }

    #[allow(dead_code)]
    pub fn ffmpeg_path(&self) -> Option<String> {
        let resolver = lock_or_err!(self.resolver);
        resolver.tool_path(ToolId::Ffmpeg)
    }
}
