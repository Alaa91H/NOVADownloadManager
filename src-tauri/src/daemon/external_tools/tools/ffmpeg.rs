use crate::daemon::external_tools::types::{Capability, ExternalTool, ToolId, ToolSource, Version};
use std::path::PathBuf;
use std::time::Duration;

pub struct FfmpegTool;

impl ExternalTool for FfmpegTool {
    fn id(&self) -> ToolId {
        ToolId::Ffmpeg
    }

    fn name(&self) -> &str {
        "FFmpeg"
    }

    fn description(&self) -> &str {
        "Media Processing Engine"
    }

    fn executable_names(&self) -> Vec<&'static str> {
        if cfg!(windows) {
            vec!["ffmpeg.exe"]
        } else {
            vec!["ffmpeg"]
        }
    }

    fn default_search_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();

        if cfg!(windows) {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                paths.push(PathBuf::from(local).join("Programs").join("FFmpeg"));
            }
            if let Ok(pf) = std::env::var("PROGRAMFILES") {
                paths.push(PathBuf::from(pf).join("FFmpeg").join("bin"));
            }
            if let Ok(pf86) = std::env::var("PROGRAMFILES(X86)") {
                paths.push(PathBuf::from(pf86).join("FFmpeg").join("bin"));
            }
            paths.push(PathBuf::from("C:\\ffmpeg\\bin"));
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
        &["-version"]
    }

    fn parse_version(&self, output: &str) -> Option<Version> {
        let first_line = output.lines().next()?;
        let version_str = first_line.split_whitespace().nth(2)?;
        let cleaned = version_str.trim_start_matches('v').trim_start_matches('V');
        let parts: Vec<&str> = cleaned.split('.').collect();
        if parts.len() >= 3 {
            Some(Version::new(&format!(
                "{}.{}.{}",
                parts[0], parts[1], parts[2]
            )))
        } else {
            Some(Version::new(cleaned))
        }
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![
            Capability::new("media.merge", "Merge", "Merge video and audio streams"),
            Capability::new(
                "media.remux",
                "Remuxing",
                "Remux media containers without re-encoding",
            ),
            Capability::new(
                "media.transcode",
                "Transcoding",
                "Transcode media to different codecs",
            ),
            Capability::new(
                "media.audio_extract",
                "Audio Extraction",
                "Extract audio from video",
            ),
            Capability::new(
                "media.video_convert",
                "Video Conversion",
                "Convert video formats",
            ),
            Capability::new(
                "media.thumbnail_extract",
                "Thumbnail Extraction",
                "Extract thumbnails from video",
            ),
            Capability::new(
                "media.media_probe",
                "Media Probing",
                "Probe media file metadata",
            ),
        ]
    }

    fn source(&self) -> ToolSource {
        ToolSource {
            name: "FFmpeg Official",
            base_url: "https://ffmpeg.org/download.html",
            platform_patterns: &[],
            requires_checksum: true,
        }
    }

    fn minimum_version(&self) -> Version {
        Version::new("5.0")
    }

    fn version_command_timeout(&self) -> Duration {
        Duration::from_secs(10)
    }
}
