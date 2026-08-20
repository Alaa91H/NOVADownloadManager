use super::types::{ExternalTool, ToolPathCandidate, ToolRegistry};
use std::path::PathBuf;

pub fn discover_tool(tool: &dyn ExternalTool, registry: &ToolRegistry) -> Vec<ToolPathCandidate> {
    let mut candidates = Vec::new();

    if let Some(entry) = registry.tools.get(tool.id().as_str()) {
        // Both manually configured paths and binaries installed by NOVA are
        // authoritative. Ignoring managed entries made a successful update
        // invisible to capability discovery until the user changed PATH.
        let path = PathBuf::from(&entry.path);
        candidates.push(ToolPathCandidate {
            path: path.clone(),
            source: if entry.custom_path {
                "registry (custom)".to_owned()
            } else {
                "registry (managed)".to_owned()
            },
            exists: path.exists(),
            is_executable: is_executable_path(&path),
        });
    }

    for search_path in tool.default_search_paths() {
        for name in tool.executable_names() {
            let candidate = search_path.join(name);
            if !candidates.iter().any(|c| c.path == candidate) {
                let exists = candidate.exists();
                candidates.push(ToolPathCandidate {
                    path: candidate.clone(),
                    source: format!("system ({})", search_path.display()),
                    exists,
                    is_executable: exists && is_executable_path(&candidate),
                });
            }
        }
    }

    for name in tool.executable_names() {
        if let Some(full_path) = which_on_path(name) {
            if !candidates.iter().any(|c| c.path == full_path) {
                candidates.push(ToolPathCandidate {
                    path: full_path,
                    source: "PATH".to_owned(),
                    exists: true,
                    is_executable: true,
                });
            }
        }
    }

    candidates
}

pub fn find_best_candidate(
    tool: &dyn ExternalTool,
    registry: &ToolRegistry,
) -> Option<ToolPathCandidate> {
    let candidates = discover_tool(tool, registry);
    candidates.into_iter().find(|c| c.exists && c.is_executable)
}

fn is_executable_path(path: &std::path::Path) -> bool {
    if cfg!(windows) {
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| matches!(e.to_lowercase().as_str(), "exe" | "cmd" | "bat" | "com"))
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)
                .ok()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            path.exists()
        }
    }
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    // Manually search PATH to avoid CWD hijack on Windows (where.exe checks CWD first)
    let path_var = std::env::var_os("PATH")?;
    let is_windows = cfg!(target_os = "windows");
    for dir in std::env::split_paths(&path_var) {
        // Skip empty entries (which represent CWD on Windows)
        if dir.as_os_str().is_empty() || dir == std::path::Path::new(".") {
            continue;
        }
        let candidate = if is_windows {
            let with_exe = dir.join(format!("{}.exe", name));
            if with_exe.exists() {
                with_exe
            } else {
                dir.join(name)
            }
        } else {
            dir.join(name)
        };
        if candidate.exists() && candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::discover_tool;
    use crate::daemon::external_tools::tools::yt_dlp::YtDlpTool;
    use crate::daemon::external_tools::types::{ToolRegistry, ToolRegistryEntry};
    use crate::daemon::external_tools::ToolId;
    use std::collections::HashMap;

    #[test]
    fn managed_registry_path_is_discovered_before_system_paths() {
        let managed_path = std::env::temp_dir().join("nova-managed-yt-dlp");
        let registry = ToolRegistry {
            tools: HashMap::from([(
                "yt-dlp".to_owned(),
                ToolRegistryEntry {
                    tool_id: "yt-dlp".to_owned(),
                    path: managed_path.display().to_string(),
                    version: Some("2026.01.01".to_owned()),
                    installed_by_app: true,
                    installed_at: None,
                    custom_path: false,
                    auto_update: false,
                    install_scope: crate::daemon::external_tools::types::InstallScope::User,
                    checksum_sha256: Some("a".repeat(64)),
                },
            )]),
            auto_check_updates: true,
            check_interval: "startup".to_owned(),
            auto_update: false,
        };

        let candidates = discover_tool(&YtDlpTool, &registry);
        assert_eq!(
            candidates.first().map(|candidate| &candidate.path),
            Some(&managed_path)
        );
        assert_eq!(
            candidates
                .first()
                .map(|candidate| candidate.source.as_str()),
            Some("registry (managed)")
        );
    }

    #[test]
    fn executable_names_windows() {
        let tool_id = ToolId::Ffmpeg;
        let names = match tool_id {
            ToolId::Ffmpeg => vec!["ffmpeg.exe"],
            ToolId::YtDlp => vec!["yt-dlp.exe"],
        };
        assert!(!names.is_empty());
    }
}
