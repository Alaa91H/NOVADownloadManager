use crate::daemon::external_tools::types::{Capability, ExternalTool, ToolId, ToolSource, Version};
use std::path::PathBuf;
use std::time::Duration;

pub struct FfmpegTool;

fn parse_official_nightly(raw: &str) -> Option<Version> {
    let nightly = raw.strip_prefix("N-")?;
    let (build, commit) = nightly.split_once("-g")?;
    if build.is_empty()
        || commit.is_empty()
        || !build.chars().all(|character| character.is_ascii_digit())
        || !commit
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return None;
    }

    // Nightly identifiers do not contain a release number. A valid `N-...-g...`
    // identifier denotes an FFmpeg git snapshot; represent it at the supported
    // baseline while preserving its original text for diagnostics.
    Some(Version {
        major: 5,
        minor: 0,
        patch: 0,
        pre_release: Some("nightly".to_owned()),
        build_metadata: Some(format!("build-{build}")),
        raw: raw.to_owned(),
    })
}

impl ExternalTool for FfmpegTool {
    fn id(&self) -> ToolId {
        ToolId::Ffmpeg
    }

    fn name(&self) -> &'static str {
        "FFmpeg"
    }

    fn description(&self) -> &'static str {
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
        let first_line = output.lines().next()?.trim();
        let version_str = first_line
            .strip_prefix("ffmpeg version ")?
            .split_whitespace()
            .next()?;

        // Official FFmpeg nightly builds use git-describe's `N-<build>-g<commit>`
        // form instead of a release semver. They have already passed the executable
        // health check; treat only that strict form as meeting the feature baseline.
        // A random non-numeric banner must remain unparseable rather than becoming
        // version 0.0.0 and producing a misleading compatibility error.
        if let Some(nightly) = parse_official_nightly(version_str) {
            return Some(nightly);
        }

        let cleaned = version_str.trim_start_matches('v').trim_start_matches('V');
        let mut numeric_parts = cleaned.split('.');
        let major = numeric_parts.next()?.parse::<u32>().ok()?;
        let minor = numeric_parts
            .next()
            .and_then(|part| part.parse::<u32>().ok())
            .unwrap_or(0);
        let patch = numeric_parts
            .next()
            .and_then(|part| {
                part.split_once('-')
                    .map_or(part, |(value, _)| value)
                    .parse::<u32>()
                    .ok()
            })
            .unwrap_or(0);
        Some(Version {
            major,
            minor,
            patch,
            pre_release: None,
            build_metadata: None,
            raw: version_str.to_owned(),
        })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stable_ffmpeg_release_version() {
        let version = FfmpegTool
            .parse_version("ffmpeg version 6.1.2 Copyright (c) FFmpeg developers")
            .expect("stable version should parse");
        assert_eq!((version.major, version.minor, version.patch), (6, 1, 2));
        assert!(version.is_compatible_with(&Version::new("5.0")));
    }

    #[test]
    fn accepts_official_ffmpeg_nightly_identifier() {
        let version = FfmpegTool
            .parse_version("ffmpeg version N-126277-ga8c7afa7d7 Copyright (c) FFmpeg developers")
            .expect("official nightly should parse");
        assert_eq!((version.major, version.minor, version.patch), (5, 0, 0));
        assert_eq!(version.pre_release.as_deref(), Some("nightly"));
        assert!(version.is_compatible_with(&Version::new("5.0")));
    }

    #[test]
    fn rejects_malformed_or_non_numeric_version_banners() {
        assert!(FfmpegTool
            .parse_version("ffmpeg version N-126277-not-a-commit")
            .is_none());
        assert!(FfmpegTool
            .parse_version("unexpected executable output")
            .is_none());
    }
}
