use crate::InfoHash;

pub const PEER_HANDSHAKE_LEN: usize = 68;
pub const MAX_PEER_FRAME_BYTES: usize = 2 * 1024 * 1024;
const BITTORRENT_PROTOCOL: &[u8; 19] = b"BitTorrent protocol";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerHandshake {
    pub reserved: [u8; 8],
    pub info_hash: InfoHash,
    pub peer_id: [u8; 20],
}

impl PeerHandshake {
    pub fn new(info_hash: InfoHash, peer_id: [u8; 20]) -> Self {
        Self {
            reserved: [0u8; 8],
            info_hash,
            peer_id,
        }
    }

    pub fn encode(&self) -> [u8; PEER_HANDSHAKE_LEN] {
        let mut output = [0u8; PEER_HANDSHAKE_LEN];
        output[0] = BITTORRENT_PROTOCOL.len() as u8;
        output[1..20].copy_from_slice(BITTORRENT_PROTOCOL);
        output[20..28].copy_from_slice(&self.reserved);
        output[28..48].copy_from_slice(self.info_hash.as_bytes());
        output[48..68].copy_from_slice(&self.peer_id);
        output
    }

    pub fn decode(input: &[u8]) -> Result<Self, PeerWireError> {
        if input.len() < PEER_HANDSHAKE_LEN {
            return Err(PeerWireError::IncompleteFrame {
                needed: PEER_HANDSHAKE_LEN,
                available: input.len(),
            });
        }
        if input[0] as usize != BITTORRENT_PROTOCOL.len()
            || &input[1..20] != BITTORRENT_PROTOCOL
        {
            return Err(PeerWireError::InvalidHandshake);
        }

        let mut reserved = [0u8; 8];
        reserved.copy_from_slice(&input[20..28]);
        let mut info_hash = [0u8; 20];
        info_hash.copy_from_slice(&input[28..48]);
        let mut peer_id = [0u8; 20];
        peer_id.copy_from_slice(&input[48..68]);

        Ok(Self {
            reserved,
            info_hash: InfoHash::new(info_hash),
            peer_id,
        })
    }

    pub fn supports_extension_protocol(&self) -> bool {
        self.reserved[5] & 0x10 != 0
    }

    pub fn supports_dht_port(&self) -> bool {
        self.reserved[7] & 0x01 != 0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PeerMessage {
    KeepAlive,
    Choke,
    Unchoke,
    Interested,
    NotInterested,
    Have(u32),
    Bitfield(Vec<u8>),
    Request {
        piece_index: u32,
        begin: u32,
        length: u32,
    },
    Piece {
        piece_index: u32,
        begin: u32,
        block: Vec<u8>,
    },
    Cancel {
        piece_index: u32,
        begin: u32,
        length: u32,
    },
    Port(u16),
    Extended {
        extension_id: u8,
        payload: Vec<u8>,
    },
}

impl PeerMessage {
    pub fn encode(&self) -> Result<Vec<u8>, PeerWireError> {
        let mut output = Vec::new();
        match self {
            Self::KeepAlive => {
                output.extend_from_slice(&0u32.to_be_bytes());
            }
            Self::Choke => encode_empty_message(&mut output, 0),
            Self::Unchoke => encode_empty_message(&mut output, 1),
            Self::Interested => encode_empty_message(&mut output, 2),
            Self::NotInterested => encode_empty_message(&mut output, 3),
            Self::Have(piece_index) => {
                output.extend_from_slice(&5u32.to_be_bytes());
                output.push(4);
                output.extend_from_slice(&piece_index.to_be_bytes());
            }
            Self::Bitfield(bitfield) => {
                let frame_length = bitfield
                    .len()
                    .checked_add(1)
                    .ok_or(PeerWireError::FrameTooLarge(usize::MAX))?;
                ensure_frame_size(frame_length)?;
                output.extend_from_slice(&(frame_length as u32).to_be_bytes());
                output.push(5);
                output.extend_from_slice(bitfield);
            }
            Self::Request {
                piece_index,
                begin,
                length,
            } => encode_request_like(&mut output, 6, *piece_index, *begin, *length),
            Self::Piece {
                piece_index,
                begin,
                block,
            } => {
                let frame_length = block
                    .len()
                    .checked_add(9)
                    .ok_or(PeerWireError::FrameTooLarge(usize::MAX))?;
                ensure_frame_size(frame_length)?;
                output.extend_from_slice(&(frame_length as u32).to_be_bytes());
                output.push(7);
                output.extend_from_slice(&piece_index.to_be_bytes());
                output.extend_from_slice(&begin.to_be_bytes());
                output.extend_from_slice(block);
            }
            Self::Cancel {
                piece_index,
                begin,
                length,
            } => encode_request_like(&mut output, 8, *piece_index, *begin, *length),
            Self::Port(port) => {
                output.extend_from_slice(&3u32.to_be_bytes());
                output.push(9);
                output.extend_from_slice(&port.to_be_bytes());
            }
            Self::Extended {
                extension_id,
                payload,
            } => {
                let frame_length = payload
                    .len()
                    .checked_add(2)
                    .ok_or(PeerWireError::FrameTooLarge(usize::MAX))?;
                ensure_frame_size(frame_length)?;
                output.extend_from_slice(&(frame_length as u32).to_be_bytes());
                output.push(20);
                output.push(*extension_id);
                output.extend_from_slice(payload);
            }
        }
        Ok(output)
    }

    /// Decode one length-prefixed peer-wire frame.
    ///
    /// The returned usize is the exact number of bytes consumed, allowing the
    /// caller to retain additional frames already buffered from the socket.
    pub fn decode_frame(input: &[u8]) -> Result<(Self, usize), PeerWireError> {
        if input.len() < 4 {
            return Err(PeerWireError::IncompleteFrame {
                needed: 4,
                available: input.len(),
            });
        }

        let length = u32::from_be_bytes(input[0..4].try_into().expect("four bytes")) as usize;
        if length == 0 {
            return Ok((Self::KeepAlive, 4));
        }
        ensure_frame_size(length)?;

        let total = length
            .checked_add(4)
            .ok_or(PeerWireError::FrameTooLarge(length))?;
        if input.len() < total {
            return Err(PeerWireError::IncompleteFrame {
                needed: total,
                available: input.len(),
            });
        }

        let id = input[4];
        let payload = &input[5..total];
        let message = match id {
            0 => {
                ensure_payload_len(id, payload, 0)?;
                Self::Choke
            }
            1 => {
                ensure_payload_len(id, payload, 0)?;
                Self::Unchoke
            }
            2 => {
                ensure_payload_len(id, payload, 0)?;
                Self::Interested
            }
            3 => {
                ensure_payload_len(id, payload, 0)?;
                Self::NotInterested
            }
            4 => {
                ensure_payload_len(id, payload, 4)?;
                Self::Have(read_u32(payload, 0))
            }
            5 => Self::Bitfield(payload.to_vec()),
            6 => {
                ensure_payload_len(id, payload, 12)?;
                Self::Request {
                    piece_index: read_u32(payload, 0),
                    begin: read_u32(payload, 4),
                    length: read_u32(payload, 8),
                }
            }
            7 => {
                if payload.len() < 9 {
                    return Err(PeerWireError::InvalidPayloadLength {
                        id,
                        expected: 9,
                        actual: payload.len(),
                    });
                }
                Self::Piece {
                    piece_index: read_u32(payload, 0),
                    begin: read_u32(payload, 4),
                    block: payload[8..].to_vec(),
                }
            }
            8 => {
                ensure_payload_len(id, payload, 12)?;
                Self::Cancel {
                    piece_index: read_u32(payload, 0),
                    begin: read_u32(payload, 4),
                    length: read_u32(payload, 8),
                }
            }
            9 => {
                ensure_payload_len(id, payload, 2)?;
                Self::Port(u16::from_be_bytes([payload[0], payload[1]]))
            }
            20 => {
                if payload.is_empty() {
                    return Err(PeerWireError::InvalidPayloadLength {
                        id,
                        expected: 1,
                        actual: 0,
                    });
                }
                Self::Extended {
                    extension_id: payload[0],
                    payload: payload[1..].to_vec(),
                }
            }
            other => return Err(PeerWireError::UnsupportedMessage(other)),
        };

        Ok((message, total))
    }
}

fn encode_empty_message(output: &mut Vec<u8>, id: u8) {
    output.extend_from_slice(&1u32.to_be_bytes());
    output.push(id);
}

fn encode_request_like(
    output: &mut Vec<u8>,
    id: u8,
    piece_index: u32,
    begin: u32,
    length: u32,
) {
    output.extend_from_slice(&13u32.to_be_bytes());
    output.push(id);
    output.extend_from_slice(&piece_index.to_be_bytes());
    output.extend_from_slice(&begin.to_be_bytes());
    output.extend_from_slice(&length.to_be_bytes());
}

fn ensure_frame_size(length: usize) -> Result<(), PeerWireError> {
    if length > MAX_PEER_FRAME_BYTES {
        return Err(PeerWireError::FrameTooLarge(length));
    }
    Ok(())
}

fn ensure_payload_len(id: u8, payload: &[u8], expected: usize) -> Result<(), PeerWireError> {
    if payload.len() != expected {
        return Err(PeerWireError::InvalidPayloadLength {
            id,
            expected,
            actual: payload.len(),
        });
    }
    Ok(())
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated peer payload"),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeerState {
    piece_count: u32,
    peer_choking: bool,
    peer_interested: bool,
    am_choking: bool,
    am_interested: bool,
    bitfield: Vec<u8>,
}

impl PeerState {
    pub fn new(piece_count: u32) -> Self {
        let bitfield_len = (piece_count as usize).div_ceil(8);
        Self {
            piece_count,
            peer_choking: true,
            peer_interested: false,
            am_choking: true,
            am_interested: false,
            bitfield: vec![0u8; bitfield_len],
        }
    }

    pub const fn peer_choking(&self) -> bool {
        self.peer_choking
    }

    pub const fn peer_interested(&self) -> bool {
        self.peer_interested
    }

    pub const fn am_choking(&self) -> bool {
        self.am_choking
    }

    pub const fn am_interested(&self) -> bool {
        self.am_interested
    }

    pub fn set_am_choking(&mut self, value: bool) {
        self.am_choking = value;
    }

    pub fn set_am_interested(&mut self, value: bool) {
        self.am_interested = value;
    }

    pub fn bitfield(&self) -> &[u8] {
        &self.bitfield
    }

    pub fn has_piece(&self, piece_index: u32) -> bool {
        if piece_index >= self.piece_count {
            return false;
        }
        bit_is_set(&self.bitfield, piece_index as usize)
    }

    pub fn apply(&mut self, message: &PeerMessage) -> Result<(), PeerWireError> {
        match message {
            PeerMessage::Choke => self.peer_choking = true,
            PeerMessage::Unchoke => self.peer_choking = false,
            PeerMessage::Interested => self.peer_interested = true,
            PeerMessage::NotInterested => self.peer_interested = false,
            PeerMessage::Have(piece_index) => {
                if *piece_index >= self.piece_count {
                    return Err(PeerWireError::PieceOutOfRange {
                        piece_index: *piece_index,
                        piece_count: self.piece_count,
                    });
                }
                set_bit(&mut self.bitfield, *piece_index as usize);
            }
            PeerMessage::Bitfield(bitfield) => {
                validate_bitfield(bitfield, self.piece_count)?;
                self.bitfield.clone_from(bitfield);
            }
            PeerMessage::KeepAlive
            | PeerMessage::Request { .. }
            | PeerMessage::Piece { .. }
            | PeerMessage::Cancel { .. }
            | PeerMessage::Port(_)
            | PeerMessage::Extended { .. } => {}
        }
        Ok(())
    }
}

fn validate_bitfield(bitfield: &[u8], piece_count: u32) -> Result<(), PeerWireError> {
    let expected = (piece_count as usize).div_ceil(8);
    if bitfield.len() != expected {
        return Err(PeerWireError::InvalidBitfieldLength {
            expected,
            actual: bitfield.len(),
        });
    }
    if piece_count == 0 || bitfield.is_empty() {
        return Ok(());
    }

    let used_bits = (piece_count as usize) % 8;
    if used_bits != 0 {
        let unused_mask = (1u8 << (8 - used_bits)) - 1;
        if bitfield[bitfield.len() - 1] & unused_mask != 0 {
            return Err(PeerWireError::InvalidBitfieldPadding);
        }
    }
    Ok(())
}

fn bit_is_set(bitfield: &[u8], piece_index: usize) -> bool {
    let byte_index = piece_index / 8;
    let bit_index = piece_index % 8;
    bitfield
        .get(byte_index)
        .is_some_and(|byte| byte & (0x80 >> bit_index) != 0)
}

fn set_bit(bitfield: &mut [u8], piece_index: usize) {
    let byte_index = piece_index / 8;
    let bit_index = piece_index % 8;
    if let Some(byte) = bitfield.get_mut(byte_index) {
        *byte |= 0x80 >> bit_index;
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum PeerWireError {
    #[error("invalid BitTorrent peer handshake")]
    InvalidHandshake,
    #[error("incomplete peer frame: need {needed} bytes, have {available}")]
    IncompleteFrame { needed: usize, available: usize },
    #[error("peer frame is too large: {0} bytes")]
    FrameTooLarge(usize),
    #[error("unsupported peer message id: {0}")]
    UnsupportedMessage(u8),
    #[error("peer piece index {piece_index} is outside piece count {piece_count}")]
    PieceOutOfRange {
        piece_index: u32,
        piece_count: u32,
    },
    #[error("peer bitfield length mismatch: expected {expected}, got {actual}")]
    InvalidBitfieldLength { expected: usize, actual: usize },
    #[error("peer bitfield sets padding bits outside the torrent piece count")]
    InvalidBitfieldPadding,
    #[error("peer message {id} has invalid payload length: expected {expected}, got {actual}")]
    InvalidPayloadLength {
        id: u8,
        expected: usize,
        actual: usize,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash() -> InfoHash {
        InfoHash::new([7u8; 20])
    }

    #[test]
    fn handshake_round_trip_preserves_feature_bits() {
        let mut handshake = PeerHandshake::new(hash(), *b"-NV0001-123456789012");
        handshake.reserved[5] |= 0x10;
        handshake.reserved[7] |= 0x01;
        let encoded = handshake.encode();
        let decoded = PeerHandshake::decode(&encoded).expect("decode handshake");
        assert_eq!(decoded, handshake);
        assert!(decoded.supports_extension_protocol());
        assert!(decoded.supports_dht_port());
    }

    #[test]
    fn request_round_trip() {
        let message = PeerMessage::Request {
            piece_index: 12,
            begin: 16_384,
            length: 16_384,
        };
        let encoded = message.encode().expect("encode");
        let (decoded, consumed) = PeerMessage::decode_frame(&encoded).expect("decode");
        assert_eq!(decoded, message);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn piece_frame_can_be_followed_by_another_buffered_frame() {
        let piece = PeerMessage::Piece {
            piece_index: 2,
            begin: 0,
            block: vec![1, 2, 3, 4],
        }
        .encode()
        .expect("piece");
        let interested = PeerMessage::Interested.encode().expect("interested");
        let mut buffer = piece.clone();
        buffer.extend_from_slice(&interested);

        let (decoded, consumed) = PeerMessage::decode_frame(&buffer).expect("first frame");
        assert_eq!(
            decoded,
            PeerMessage::Piece {
                piece_index: 2,
                begin: 0,
                block: vec![1, 2, 3, 4],
            }
        );
        assert_eq!(consumed, piece.len());
    }

    #[test]
    fn extended_message_round_trip() {
        let message = PeerMessage::Extended {
            extension_id: 3,
            payload: b"d1:ai1ee".to_vec(),
        };
        let encoded = message.encode().expect("encode extended");
        let (decoded, consumed) = PeerMessage::decode_frame(&encoded).expect("decode extended");
        assert_eq!(decoded, message);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn peer_state_tracks_choke_interest_and_piece_availability() {
        let mut state = PeerState::new(10);
        assert!(state.peer_choking());
        assert!(!state.peer_interested());
        state.apply(&PeerMessage::Unchoke).unwrap();
        state.apply(&PeerMessage::Interested).unwrap();
        state.apply(&PeerMessage::Have(9)).unwrap();
        assert!(!state.peer_choking());
        assert!(state.peer_interested());
        assert!(state.has_piece(9));
        assert!(!state.has_piece(10));
    }

    #[test]
    fn peer_state_validates_bitfield_shape_and_padding() {
        let mut state = PeerState::new(10);
        assert_eq!(
            state.apply(&PeerMessage::Bitfield(vec![0xff])),
            Err(PeerWireError::InvalidBitfieldLength {
                expected: 2,
                actual: 1,
            })
        );
        assert_eq!(
            state.apply(&PeerMessage::Bitfield(vec![0xff, 0x3f])),
            Err(PeerWireError::InvalidBitfieldPadding)
        );
        state
            .apply(&PeerMessage::Bitfield(vec![0xff, 0xc0]))
            .expect("valid bitfield");
        assert!(state.has_piece(0));
        assert!(state.has_piece(9));
    }

    #[test]
    fn peer_state_rejects_out_of_range_have() {
        let mut state = PeerState::new(2);
        assert_eq!(
            state.apply(&PeerMessage::Have(2)),
            Err(PeerWireError::PieceOutOfRange {
                piece_index: 2,
                piece_count: 2,
            })
        );
    }

    #[test]
    fn oversized_frame_is_rejected_before_allocation() {
        let length = (MAX_PEER_FRAME_BYTES as u32) + 1;
        let input = length.to_be_bytes();
        assert_eq!(
            PeerMessage::decode_frame(&input).expect_err("oversized"),
            PeerWireError::FrameTooLarge(length as usize)
        );
    }
}
