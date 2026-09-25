use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{MediaCodec, MediaContainer, MediaProcessingError};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaProcessingOperation {
    Probe,
    Mux,
    Remux,
    Transcode,
    ExtractAudio,
    AssembleStream,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaInput {
    pub path: PathBuf,
    pub container_hint: Option<MediaContainer>,
}

impl MediaInput {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            container_hint: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaOutput {
    pub path: PathBuf,
    pub container: MediaContainer,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TranscodeSettings {
    pub video_codec: Option<MediaCodec>,
    pub audio_codec: Option<MediaCodec>,
    pub video_bitrate_bps: Option<u64>,
    pub audio_bitrate_bps: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaProcessingJob {
    pub operation: MediaProcessingOperation,
    pub inputs: Vec<MediaInput>,
    pub output: Option<MediaOutput>,
    pub transcode: Option<TranscodeSettings>,
    pub preserve_metadata: bool,
}

impl MediaProcessingJob {
    pub fn validate(&self) -> Result<(), MediaProcessingError> {
        if self.inputs.is_empty() {
            return Err(MediaProcessingError::InvalidJob(
                "at least one media input is required".to_owned(),
            ));
        }

        match self.operation {
            MediaProcessingOperation::Probe => {
                if self.inputs.len() != 1 {
                    return Err(MediaProcessingError::InvalidJob(
                        "probe jobs require exactly one input".to_owned(),
                    ));
                }
                if self.output.is_some() {
                    return Err(MediaProcessingError::InvalidJob(
                        "probe jobs do not produce an output file".to_owned(),
                    ));
                }
                if self.transcode.is_some() {
                    return Err(MediaProcessingError::InvalidJob(
                        "probe jobs cannot contain transcode settings".to_owned(),
                    ));
                }
            }
            MediaProcessingOperation::Mux => {
                if self.inputs.len() < 2 {
                    return Err(MediaProcessingError::InvalidJob(
                        "mux jobs require at least two inputs".to_owned(),
                    ));
                }
                self.require_output()?;
                if self.transcode.is_some() {
                    return Err(MediaProcessingError::InvalidJob(
                        "mux jobs must preserve encoded packets; use transcode for codec changes"
                            .to_owned(),
                    ));
                }
            }
            MediaProcessingOperation::Remux
            | MediaProcessingOperation::ExtractAudio
            | MediaProcessingOperation::AssembleStream => {
                self.require_output()?;
                if self.transcode.is_some() {
                    return Err(MediaProcessingError::InvalidJob(
                        "packet-preserving operations cannot contain transcode settings".to_owned(),
                    ));
                }
            }
            MediaProcessingOperation::Transcode => {
                self.require_output()?;
                let settings = self.transcode.as_ref().ok_or_else(|| {
                    MediaProcessingError::InvalidJob(
                        "transcode jobs require codec settings".to_owned(),
                    )
                })?;
                if settings.video_codec.is_none() && settings.audio_codec.is_none() {
                    return Err(MediaProcessingError::InvalidJob(
                        "transcode jobs require at least one target codec".to_owned(),
                    ));
                }
            }
        }

        Ok(())
    }

    fn require_output(&self) -> Result<(), MediaProcessingError> {
        if self.output.is_none() {
            Err(MediaProcessingError::InvalidJob(
                "this processing operation requires an output file".to_owned(),
            ))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> MediaInput {
        MediaInput::new(name)
    }

    fn output() -> MediaOutput {
        MediaOutput {
            path: PathBuf::from("out.mp4"),
            container: MediaContainer::Mp4,
        }
    }

    #[test]
    fn mux_requires_multiple_inputs_and_no_transcode_settings() {
        let invalid = MediaProcessingJob {
            operation: MediaProcessingOperation::Mux,
            inputs: vec![input("video.mp4")],
            output: Some(output()),
            transcode: None,
            preserve_metadata: true,
        };
        assert!(invalid.validate().is_err());

        let valid = MediaProcessingJob {
            operation: MediaProcessingOperation::Mux,
            inputs: vec![input("video.mp4"), input("audio.m4a")],
            output: Some(output()),
            transcode: None,
            preserve_metadata: true,
        };
        assert_eq!(valid.validate(), Ok(()));
    }

    #[test]
    fn transcode_requires_target_codec() {
        let job = MediaProcessingJob {
            operation: MediaProcessingOperation::Transcode,
            inputs: vec![input("input.mkv")],
            output: Some(output()),
            transcode: Some(TranscodeSettings {
                video_codec: None,
                audio_codec: None,
                video_bitrate_bps: None,
                audio_bitrate_bps: None,
            }),
            preserve_metadata: true,
        };
        assert!(job.validate().is_err());
    }
}
