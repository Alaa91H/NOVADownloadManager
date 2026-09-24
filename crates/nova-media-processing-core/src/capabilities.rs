use serde::{Deserialize, Serialize};

/// Compile-time capabilities implemented by NOVA's in-process media
/// processing core.
///
/// A capability is only set to true when the implementation exists in this
/// crate. Higher layers must gate UI and execution from this structure instead
/// of assuming feature availability from file extensions.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NativeMediaProcessingCapabilities {
    pub job_planning: bool,
    pub container_sniffing: bool,
    pub packet_model: bool,
    pub mp4_demux: bool,
    pub mp4_mux: bool,
    pub fragmented_mp4_demux: bool,
    pub mpeg_ts_demux: bool,
    pub webm_demux: bool,
    pub webm_mux: bool,
    pub matroska_demux: bool,
    pub matroska_mux: bool,
    pub native_remux: bool,
    pub native_audio_transcode: bool,
    pub native_video_transcode: bool,
    pub hardware_acceleration: bool,
}

pub const fn native_media_processing_capabilities() -> NativeMediaProcessingCapabilities {
    NativeMediaProcessingCapabilities {
        job_planning: true,
        container_sniffing: true,
        packet_model: true,
        mp4_demux: true,
        mp4_mux: true,
        fragmented_mp4_demux: true,
        mpeg_ts_demux: false,
        webm_demux: false,
        webm_mux: false,
        matroska_demux: false,
        matroska_mux: false,
        native_remux: true,
        native_audio_transcode: false,
        native_video_transcode: false,
        hardware_acceleration: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_matrix_never_claims_unimplemented_processing() {
        let caps = native_media_processing_capabilities();
        assert!(caps.job_planning);
        assert!(caps.container_sniffing);
        assert!(caps.packet_model);
        assert!(caps.mp4_demux);
        assert!(caps.fragmented_mp4_demux);
        assert!(caps.mp4_mux);
        assert!(caps.native_remux);
        assert!(!caps.native_audio_transcode);
        assert!(!caps.native_video_transcode);
    }
}
