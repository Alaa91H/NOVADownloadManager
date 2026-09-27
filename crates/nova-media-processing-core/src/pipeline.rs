use serde::{Deserialize, Serialize};

use crate::{
    MediaProcessingError, MediaProcessingJob, MediaProcessingOperation,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaPipelineStage {
    Probe,
    Demux,
    Decode,
    Filter,
    Encode,
    Mux,
    Finalize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaPipelinePlan {
    pub operation: MediaProcessingOperation,
    pub stages: Vec<MediaPipelineStage>,
    pub packet_preserving: bool,
}

pub fn plan_media_pipeline(
    job: &MediaProcessingJob,
) -> Result<MediaPipelinePlan, MediaProcessingError> {
    job.validate()?;

    let (stages, packet_preserving) = match job.operation {
        MediaProcessingOperation::Probe => (vec![MediaPipelineStage::Probe], true),
        MediaProcessingOperation::Mux => (
            vec![
                MediaPipelineStage::Probe,
                MediaPipelineStage::Demux,
                MediaPipelineStage::Mux,
                MediaPipelineStage::Finalize,
            ],
            true,
        ),
        MediaProcessingOperation::Remux | MediaProcessingOperation::AssembleStream => (
            vec![
                MediaPipelineStage::Probe,
                MediaPipelineStage::Demux,
                MediaPipelineStage::Mux,
                MediaPipelineStage::Finalize,
            ],
            true,
        ),
        MediaProcessingOperation::ExtractAudio => (
            vec![
                MediaPipelineStage::Probe,
                MediaPipelineStage::Demux,
                MediaPipelineStage::Mux,
                MediaPipelineStage::Finalize,
            ],
            true,
        ),
        MediaProcessingOperation::Transcode => (
            vec![
                MediaPipelineStage::Probe,
                MediaPipelineStage::Demux,
                MediaPipelineStage::Decode,
                MediaPipelineStage::Filter,
                MediaPipelineStage::Encode,
                MediaPipelineStage::Mux,
                MediaPipelineStage::Finalize,
            ],
            false,
        ),
    };

    Ok(MediaPipelinePlan {
        operation: job.operation,
        stages,
        packet_preserving,
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::{MediaContainer, MediaInput, MediaOutput, TranscodeSettings};

    #[test]
    fn remux_plan_never_decodes_or_encodes() {
        let job = MediaProcessingJob {
            operation: MediaProcessingOperation::Remux,
            inputs: vec![MediaInput::new("input.mkv")],
            output: Some(MediaOutput {
                path: PathBuf::from("output.mp4"),
                container: MediaContainer::Mp4,
            }),
            transcode: None,
            preserve_metadata: true,
        };

        let plan = plan_media_pipeline(&job).expect("valid remux plan");
        assert!(plan.packet_preserving);
        assert!(!plan.stages.contains(&MediaPipelineStage::Decode));
        assert!(!plan.stages.contains(&MediaPipelineStage::Encode));
        assert!(plan.stages.contains(&MediaPipelineStage::Mux));
    }

    #[test]
    fn transcode_plan_contains_decode_and_encode() {
        let job = MediaProcessingJob {
            operation: MediaProcessingOperation::Transcode,
            inputs: vec![MediaInput::new("input.mkv")],
            output: Some(MediaOutput {
                path: PathBuf::from("output.mp4"),
                container: MediaContainer::Mp4,
            }),
            transcode: Some(TranscodeSettings {
                video_codec: Some(crate::MediaCodec::H264),
                audio_codec: None,
                video_bitrate_bps: Some(4_000_000),
                audio_bitrate_bps: None,
            }),
            preserve_metadata: true,
        };

        let plan = plan_media_pipeline(&job).expect("valid transcode plan");
        assert!(!plan.packet_preserving);
        assert!(plan.stages.contains(&MediaPipelineStage::Decode));
        assert!(plan.stages.contains(&MediaPipelineStage::Encode));
    }
}
