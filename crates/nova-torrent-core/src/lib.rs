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

mod dht;
mod extension;
mod magnet;
mod manifest;
mod metainfo;
mod peer;
mod resume;
mod scheduler;
mod selection;
mod storage;
mod tracker;

pub use dht::{
    DhtError, DhtMessage, DhtNode, DhtNodeId, DhtQuery, DhtResponse, MAX_DHT_NODES,
    MAX_DHT_PACKET_BYTES, MAX_DHT_PEERS, MAX_DHT_TOKEN_BYTES, MAX_DHT_TRANSACTION_BYTES,
};
pub use extension::{
    ExtendedHandshake, ExtensionError, MetadataAssembler, MetadataMessage, PeerExchange,
    EXTENSION_HANDSHAKE_ID, LOCAL_UT_METADATA_ID, LOCAL_UT_PEX_ID, MAX_EXTENDED_HANDSHAKE_BYTES,
    MAX_METADATA_SIZE, MAX_PEX_PEERS, METADATA_PIECE_SIZE,
};
pub use magnet::{
    MagnetLink, MagnetParseError, MAX_MAGNET_TRACKERS, MAX_MAGNET_URI_BYTES,
    MAX_MAGNET_WEB_SEEDS,
};
pub use manifest::{
    load_storage_manifest, load_storage_manifest_recovering, save_storage_manifest_atomic,
    ManifestError, TorrentStorageManifest,
    STORAGE_MANIFEST_VERSION,
};
pub use metainfo::{
    FileSlice, InfoHash, TorrentFile, TorrentMetainfo, TorrentMetainfoError,
    MAX_METAINFO_BYTES, MAX_PIECE_LENGTH_BYTES,
};
pub use peer::{
    PeerHandshake, PeerMessage, PeerState, PeerWireError, MAX_PEER_FRAME_BYTES,
    PEER_HANDSHAKE_LEN,
};
pub use resume::{
    load_checkpoint_recovering, save_checkpoint_atomic, PieceBitmap, ResumeError,
    TorrentResumeCheckpoint, RESUME_FORMAT_VERSION,
};
pub use scheduler::{
    BlockRequest, PieceLayout, PieceScheduler, SchedulerError,
    DEFAULT_BLOCK_SIZE,
};
pub use selection::{FilePriority, SelectionError, TorrentSelection};
pub use storage::{
    AllocationMode, PieceCommit, RecheckMode, RecheckReport, StorageError, TorrentStorage,
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
    pub extension_protocol: bool,
    pub metadata_exchange_protocol: bool,
    pub pex_protocol: bool,
    pub dht_krpc_protocol: bool,
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
            extension_protocol: true,
            metadata_exchange_protocol: true,
            pex_protocol: true,
            dht_krpc_protocol: true,
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
                extension_protocol: true,
                metadata_exchange_protocol: true,
                pex_protocol: true,
                dht_krpc_protocol: true,
            }
        );
    }
}
