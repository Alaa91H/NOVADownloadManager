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
    fn oversized_frame_is_rejected_before_allocation() {
        let length = (MAX_PEER_FRAME_BYTES as u32) + 1;
        let input = length.to_be_bytes();
        assert_eq!(
            PeerMessage::decode_frame(&input).expect_err("oversized"),
            PeerWireError::FrameTooLarge(length as usize)
        );
    }
}
