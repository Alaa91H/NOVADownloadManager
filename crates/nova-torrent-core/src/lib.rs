//! Native BitTorrent domain core for NOVA Download Manager.
//!
//! This crate owns protocol parsing, metainfo validation, peer-wire framing and
//! piece scheduling. It deliberately contains no Tauri, UI, subprocess or
//! platform-specific types so desktop and mobile hosts can share the same
//! implementation.
//!
//! The crate is intentionally transport-neutral at this stage: trackers, DHT
//! sockets and peer connection orchestration are layered on top of these
//! validated primitives rather than being mixed into the data model.

mod magnet;
mod metainfo;
mod peer;
mod scheduler;
mod tracker;

pub use magnet::{MagnetLink, MagnetParseError};
pub use metainfo::{
    FileSlice, InfoHash, TorrentFile, TorrentMetainfo, TorrentMetainfoError,
    MAX_METAINFO_BYTES,
};
pub use peer::{
    PeerHandshake, PeerMessage, PeerWireError, MAX_PEER_FRAME_BYTES,
    PEER_HANDSHAKE_LEN,
};
pub use scheduler::{
    BlockRequest, PieceLayout, PieceScheduler, SchedulerError,
    DEFAULT_BLOCK_SIZE,
};
pub use tracker::{
    udp_connect_packet, HttpTrackerResponse, TrackerAnnounceRequest, TrackerEvent, TrackerPeer,
    TrackerProtocolError, UdpAnnounceResponse, UdpConnectResponse,
    MAX_TRACKER_PEERS, MAX_TRACKER_RESPONSE_BYTES,
};

/// Stable engine identifier used when the host exposes torrent tasks through
/// NOVA's existing task model.
pub const ENGINE_ID: &str = "native-torrent";

/// Foundation capabilities implemented by this crate.
///
/// Network-facing discovery and swarm orchestration are deliberately not
/// reported here until their implementations are connected and verified.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TorrentCoreCapabilities {
    pub metainfo_v1: bool,
    pub magnet_btih: bool,
    pub peer_wire_v1: bool,
    pub piece_scheduler: bool,
    pub http_tracker_protocol: bool,
    pub udp_tracker_protocol: bool,
}

impl TorrentCoreCapabilities {
    pub const fn native_foundation() -> Self {
        Self {
            metainfo_v1: true,
            magnet_btih: true,
            peer_wire_v1: true,
            piece_scheduler: true,
            http_tracker_protocol: true,
            udp_tracker_protocol: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_identity_is_stable() {
        assert_eq!(ENGINE_ID, "native-torrent");
        assert_eq!(
            TorrentCoreCapabilities::native_foundation(),
            TorrentCoreCapabilities {
                metainfo_v1: true,
                magnet_btih: true,
                peer_wire_v1: true,
                piece_scheduler: true,
                http_tracker_protocol: true,
                udp_tracker_protocol: true,
            }
        );
    }
}
