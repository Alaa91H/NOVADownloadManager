use std::path::Path;

use crate::{
    probe_file_container, MatroskaDemuxer, MediaContainer, MediaDemuxer,
    MediaProcessingError, Mp4Demuxer, WebmDemuxer,
};

/// Open an input that NOVA can packet-preservingly remux into MP4.
///
/// Container sniffing is content-based, so staging files do not need a useful
/// extension. WebM and supported Matroska inputs are opened through explicit
/// MP4 compatibility bridges, which normalize codec initialization metadata
/// and decode timing before the muxer sees the tracks.
pub fn open_mp4_remux_demuxer(
    path: &Path,
) -> Result<Box<dyn MediaDemuxer>, MediaProcessingError> {
    match probe_file_container(path)? {
        MediaContainer::Mp4 | MediaContainer::FragmentedMp4 => {
            Ok(Box::new(Mp4Demuxer::open(path)?))
        }
        MediaContainer::WebM => Ok(Box::new(WebmDemuxer::open_for_mp4_remux(path)?)),
        MediaContainer::Matroska => {
            Ok(Box::new(MatroskaDemuxer::open_for_mp4_remux(path)?))
        }
        container => Err(MediaProcessingError::UnsupportedContainer(format!(
            "{container:?} cannot be remuxed to MP4 by the native bridge"
        ))),
    }
}
