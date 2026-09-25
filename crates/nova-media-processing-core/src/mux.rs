use crate::{MediaPacket, MediaProcessingError, MediaTrack};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MediaMuxResult {
    pub packets_written: u64,
    pub bytes_written: u64,
    pub tracks_written: u32,
}

/// Container-neutral packet writer used by packet-preserving mux/remux
/// operations and by the output side of future transcode pipelines.
pub trait MediaMuxer {
    /// Register an output track and return the destination track id.
    fn add_track(&mut self, track: &MediaTrack) -> Result<u32, MediaProcessingError>;

    /// Write one already-encoded packet. Muxers must reject packets whose
    /// destination track was not registered.
    fn write_packet(&mut self, packet: &MediaPacket) -> Result<(), MediaProcessingError>;

    /// Flush tables/indexes and make the container durable.
    fn finalize(&mut self) -> Result<MediaMuxResult, MediaProcessingError>;
}
