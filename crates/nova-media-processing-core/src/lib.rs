#![forbid(unsafe_code)]

//! Native in-process media processing foundation for NOVA Download Manager.
//!
//! This crate owns container/packet processing contracts that replace external
//! post-processing executables over time. It deliberately contains no Tauri,
//! shell, subprocess, network resolver, or UI dependency.

mod capabilities;
mod demux;
mod error;
mod job;
mod mux;
mod mp4;
mod pipeline;
mod probe;
mod progress;
mod remux;
mod types;
mod webm;

pub use demux::MediaDemuxer;
pub use mux::{MediaMuxResult, MediaMuxer};
pub use mp4::{
    mux_demuxers_to_mp4, mux_demuxers_to_mp4_controlled, probe_mp4_file, Mp4Demuxer, Mp4Muxer,
    Mp4Sample, Mp4TrackIndex, ParsedMp4,
};
pub use capabilities::{
    native_media_processing_capabilities, NativeMediaProcessingCapabilities,
};
pub use error::MediaProcessingError;
pub use job::{
    MediaInput, MediaOutput, MediaProcessingJob, MediaProcessingOperation, TranscodeSettings,
};
pub use pipeline::{plan_media_pipeline, MediaPipelinePlan, MediaPipelineStage};
pub use probe::{probe_file_container, sniff_media_container};
pub use remux::open_mp4_remux_demuxer;
pub use progress::{
    MediaProcessingControl, MediaProcessingPhase, MediaProcessingProgress, MediaProgressSink,
};
pub use types::{
    AudioParameters, MediaCodec, MediaContainer, MediaPacket, MediaPacketFlags, MediaProbe,
    MediaTimeBase, MediaTimestamp, MediaTrack, MediaTrackKind, VideoParameters,
};
pub use webm::{
    prepare_webm_track_for_mp4, probe_matroska_file, probe_webm_file, MatroskaDemuxer,
    WebmDemuxer,
};

/// Stable version for the internal processing contract. Increment only when
/// serialized job/packet semantics change incompatibly.
pub const MEDIA_PROCESSING_CORE_ABI_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn processing_core_starts_without_external_runtime_requirements() {
        let capabilities = native_media_processing_capabilities();
        assert!(capabilities.job_planning);
        assert!(capabilities.container_sniffing);
        assert_eq!(MEDIA_PROCESSING_CORE_ABI_VERSION, 1);
    }
}
