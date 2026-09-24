use crate::daemon::external_tools::types::{
    Capability, ExternalTool, PlatformPattern, ToolId, ToolSource, Version,
};
use std::path::PathBuf;
use std::time::Duration;

pub struct MediaBridgeTool;

impl ExternalTool for MediaBridgeTool {
    fn id(&self) -> ToolId {
        ToolId::MediaBridge
    }

    fn name(&self) -> &'static str {
        "NOVA Media Bridge"
    }

    fn description(&self) -> &'static str {
        "Media URL Resolver"
    }

    fn executable_names(&self) -> Vec<&'static str> {
        if cfg!(windows) {
            vec!["nova-media-bridge.exe"]
        } else {
            vec!["nova-media-bridge"]
        }
    }

    fn default_search_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();

        if cfg!(windows) {
            if let Ok(appdata) = std::env::var("APPDATA") {
                paths.push(PathBuf::from(appdata).join("Python").join("Scripts"));
            }
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                paths.push(PathBuf::from(local).join("Programs").join("NOVA").join("MediaBridge"));
            }
            paths.push(PathBuf::from("C:\\ProgramData\\NOVA\\MediaBridge"));
        } else if cfg!(target_os = "macos") {
            paths.push(PathBuf::from("/usr/local/bin"));
            paths.push(PathBuf::from("/opt/homebrew/bin"));
            paths.push(PathBuf::from("/opt/local/bin"));
        } else {
            paths.push(PathBuf::from("/usr/bin"));
            paths.push(PathBuf::from("/usr/local/bin"));
            paths.push(PathBuf::from("/snap/bin"));
            if let Ok(home) = std::env::var("HOME") {
                paths.push(PathBuf::from(home).join(".local").join("bin"));
            }
        }

        paths
    }

    fn version_args(&self) -> &'static [&'static str] {
        &["--version"]
    }

    fn parse_version(&self, output: &str) -> Option<Version> {
        let first_line = output.lines().next()?;
        let version_str = first_line.trim();
        Some(Version::new(version_str))
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![
            Capability::new(
                "media.resolve",
                "URL Extraction",
                "Extract direct download URLs from pages",
            ),
            Capability::new(
                "media.metadata",
                "Metadata",
                "Extract media metadata and info",
            ),
            Capability::new(
                "media.format_discovery",
                "Format Discovery",
                "Discover available formats and qualities",
            ),
            Capability::new(
                "media.platform_extraction",
                "Platform Extraction",
                "Extract media from supported platforms",
            ),
            Capability::new(
                "media.direct_url_resolution",
                "Direct URL Resolution",
                "Resolve direct download URLs",
            ),
        ]
    }

    fn source(&self) -> ToolSource {
        ToolSource {
            name: "NOVA release package",
            base_url: "nova://media-bridge",
            platform_patterns: &[
                PlatformPattern {
                    os: "windows",
                    arch: "x86_64",
                    pattern: "nova-media-bridge.exe",
                    executable_name: "nova-media-bridge.exe",
                },
                PlatformPattern {
                    os: "linux",
                    arch: "x86_64",
                    pattern: "nova-media-bridge",
                    executable_name: "nova-media-bridge",
                },
                PlatformPattern {
                    os: "macos",
                    arch: "x86_64",
                    pattern: "nova-media-bridge",
                    executable_name: "nova-media-bridge",
                },
            ],
            requires_checksum: false,
        }
    }

    fn minimum_version(&self) -> Version {
        Version::new("2024.01.01")
    }

    fn version_command_timeout(&self) -> Duration {
        Duration::from_secs(15)
    }
}
