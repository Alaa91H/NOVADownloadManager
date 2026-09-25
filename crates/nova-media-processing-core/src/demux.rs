use crate::{
    MediaPacket, MediaProbe, MediaProcessingError, MediaTimestamp,
};

/// Container-neutral packet reader used by native remux and transcode
/// pipelines. Implementations own container parsing but never perform network
/// access or spawn helper processes.
pub trait MediaDemuxer {
    fn probe(&self) -> &MediaProbe;

    fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError>;

    fn seek(&mut self, _timestamp: MediaTimestamp) -> Result<(), MediaProcessingError> {
        Err(MediaProcessingError::UnsupportedOperation(
            "seeking is not implemented by this demuxer".to_owned(),
        ))
    }
}
