use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::daemon::utils::hide_command_window;

#[derive(Clone, Debug)]
pub struct MediaMuxRequest {
    pub video_path: PathBuf,
    pub audio_path: PathBuf,
    pub destination: PathBuf,
}

#[derive(Debug)]
pub enum PostProcessError {
    Unavailable(String),
    InvalidInput(String),
    Io(String),
    Failed(String),
    Cancelled,
}

impl std::fmt::Display for PostProcessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(message) => write!(f, "post-processor unavailable: {message}"),
            Self::InvalidInput(message) => write!(f, "invalid post-processing input: {message}"),
            Self::Io(message) => write!(f, "post-processing I/O failed: {message}"),
            Self::Failed(message) => write!(f, "post-processing failed: {message}"),
            Self::Cancelled => write!(f, "post-processing was cancelled"),
        }
    }
}

impl std::error::Error for PostProcessError {}

pub trait MediaPostProcessor: Send + Sync {
    fn id(&self) -> &'static str;
    fn is_available(&self) -> bool;
    fn mux(
        &self,
        request: &MediaMuxRequest,
        should_cancel: &(dyn Fn() -> bool + Sync),
    ) -> Result<u64, PostProcessError>;
}

/// Temporary host adapter for lossless container muxing.
///
/// Extraction and stream selection remain entirely inside NOVA's Rust media
/// core. This adapter receives only local staged files and is deliberately
/// isolated from URL resolution, probing, cookies and network access.
#[derive(Clone, Debug)]
pub struct FfmpegPostProcessor {
    program: String,
}

impl FfmpegPostProcessor {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
        }
    }

    fn build_mux_command(&self, request: &MediaMuxRequest, output: &Path) -> Command {
        let mut command = Command::new(&self.program);
        hide_command_window(&mut command);
        command
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-nostdin")
            .arg("-y")
            .arg("-i")
            .arg(&request.video_path)
            .arg("-i")
            .arg(&request.audio_path)
            .arg("-map")
            .arg("0:v:0")
            .arg("-map")
            .arg("1:a:0")
            .arg("-c")
            .arg("copy")
            .arg(output)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }
}

impl MediaPostProcessor for FfmpegPostProcessor {
    fn id(&self) -> &'static str {
        "ffmpeg-mux"
    }

    fn is_available(&self) -> bool {
        if self.program.trim().is_empty() {
            return false;
        }
        let mut command = Command::new(&self.program);
        hide_command_window(&mut command);
        command
            .arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn mux(
        &self,
        request: &MediaMuxRequest,
        should_cancel: &(dyn Fn() -> bool + Sync),
    ) -> Result<u64, PostProcessError> {
        for (label, path) in [
            ("video", request.video_path.as_path()),
            ("audio", request.audio_path.as_path()),
        ] {
            let metadata = std::fs::metadata(path).map_err(|error| {
                PostProcessError::InvalidInput(format!(
                    "{label} track '{}' is unavailable: {error}",
                    path.display()
                ))
            })?;
            if !metadata.is_file() || metadata.len() == 0 {
                return Err(PostProcessError::InvalidInput(format!(
                    "{label} track '{}' is empty or is not a regular file",
                    path.display()
                )));
            }
        }

        if should_cancel() {
            return Err(PostProcessError::Cancelled);
        }

        if let Some(parent) = request
            .destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .map_err(|error| PostProcessError::Io(error.to_string()))?;
        }

        let temp = mux_temp_path(&request.destination);
        let _ = std::fs::remove_file(&temp);
        let mut child = self
            .build_mux_command(request, &temp)
            .spawn()
            .map_err(|error| PostProcessError::Unavailable(error.to_string()))?;

        loop {
            if should_cancel() {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&temp);
                return Err(PostProcessError::Cancelled);
            }

            match child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(status)) => {
                    let _ = std::fs::remove_file(&temp);
                    return Err(PostProcessError::Failed(format!(
                        "{} exited with status {status}",
                        self.id()
                    )));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = std::fs::remove_file(&temp);
                    return Err(PostProcessError::Io(error.to_string()));
                }
            }
        }

        if should_cancel() {
            let _ = std::fs::remove_file(&temp);
            return Err(PostProcessError::Cancelled);
        }

        let bytes = std::fs::metadata(&temp)
            .map_err(|error| PostProcessError::Io(error.to_string()))?
            .len();
        if bytes == 0 {
            let _ = std::fs::remove_file(&temp);
            return Err(PostProcessError::Failed(
                "muxer produced an empty output".to_owned(),
            ));
        }

        if request.destination.exists() {
            std::fs::remove_file(&request.destination)
                .map_err(|error| PostProcessError::Io(error.to_string()))?;
        }
        std::fs::rename(&temp, &request.destination)
            .map_err(|error| PostProcessError::Io(error.to_string()))?;
        Ok(bytes)
    }
}

fn mux_temp_path(destination: &Path) -> PathBuf {
    let parent = destination.parent().unwrap_or_else(|| Path::new(""));
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("nova-media");
    match destination.extension().and_then(|value| value.to_str()) {
        Some(extension) if !extension.is_empty() => {
            parent.join(format!("{stem}.nova-mux.tmp.{extension}"))
        }
        _ => parent.join(format!("{stem}.nova-mux.tmp")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mux_temp_path_preserves_container_extension() {
        assert_eq!(
            mux_temp_path(Path::new("/tmp/video.mp4")),
            PathBuf::from("/tmp/video.nova-mux.tmp.mp4")
        );
        assert_eq!(
            mux_temp_path(Path::new("clip.webm")),
            PathBuf::from("clip.nova-mux.tmp.webm")
        );
    }

    #[test]
    fn mux_command_is_copy_only_and_uses_explicit_track_mapping() {
        let processor = FfmpegPostProcessor::new("ffmpeg");
        let request = MediaMuxRequest {
            video_path: PathBuf::from("video.track"),
            audio_path: PathBuf::from("audio.track"),
            destination: PathBuf::from("output.mp4"),
        };
        let command =
            processor.build_mux_command(&request, Path::new("output.nova-mux.tmp.mp4"));
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-i" && pair[1] == "video.track"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-i" && pair[1] == "audio.track"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-map" && pair[1] == "0:v:0"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-map" && pair[1] == "1:a:0"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c" && pair[1] == "copy"));
        assert!(!args.iter().any(|arg| arg == "-filter_complex"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("output.nova-mux.tmp.mp4")
        );
    }

    #[test]
    fn mux_honors_cancellation_before_process_spawn() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-postprocess-cancel-{unique}"));
        std::fs::create_dir_all(&dir).expect("create postprocess dir");
        let video = dir.join("video.part");
        let audio = dir.join("audio.part");
        std::fs::write(&video, b"video").expect("video input");
        std::fs::write(&audio, b"audio").expect("audio input");

        let processor = FfmpegPostProcessor::new("__must_not_spawn__");
        let error = processor
            .mux(
                &MediaMuxRequest {
                    video_path: video,
                    audio_path: audio,
                    destination: dir.join("output.mp4"),
                },
                &|| true,
            )
            .expect_err("cancelled mux");
        assert!(matches!(error, PostProcessError::Cancelled));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mux_rejects_missing_inputs_before_spawning_process() {
        let processor = FfmpegPostProcessor::new("unused");
        let error = processor
            .mux(
                &MediaMuxRequest {
                    video_path: PathBuf::from("missing-video"),
                    audio_path: PathBuf::from("missing-audio"),
                    destination: PathBuf::from("out.mp4"),
                },
                &|| false,
            )
            .expect_err("missing inputs");
        assert!(matches!(error, PostProcessError::InvalidInput(_)));
    }
}
