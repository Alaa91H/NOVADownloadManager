use crate::InfoHash;
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;

pub const EXTENSION_HANDSHAKE_ID: u8 = 0;
pub const LOCAL_UT_METADATA_ID: u8 = 1;
pub const LOCAL_UT_PEX_ID: u8 = 2;
pub const METADATA_PIECE_SIZE: usize = 16 * 1024;
pub const MAX_METADATA_SIZE: usize = 4 * 1024 * 1024;
pub const MAX_EXTENDED_HANDSHAKE_BYTES: usize = 64 * 1024;
pub const MAX_PEX_PEERS: usize = 2_048;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExtendedHandshake {
    pub ut_metadata: Option<u8>,
    pub ut_pex: Option<u8>,
    pub metadata_size: Option<usize>,
    pub request_queue: Option<u32>,
    pub client_name: Option<String>,
}

impl ExtendedHandshake {
    pub fn local(metadata_size: Option<usize>) -> Self {
        Self {
            ut_metadata: Some(LOCAL_UT_METADATA_ID),
            ut_pex: Some(LOCAL_UT_PEX_ID),
            metadata_size,
            request_queue: Some(32),
            client_name: Some(format!("NOVA/{}", env!("CARGO_PKG_VERSION"))),
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ExtensionError> {
        if self
            .metadata_size
            .is_some_and(|size| size == 0 || size > MAX_METADATA_SIZE)
        {
            return Err(ExtensionError::InvalidMetadataSize(
                self.metadata_size.unwrap_or_default(),
            ));
        }

        let mut out = Vec::new();
        out.push(b'd');

        // Keys are encoded in canonical byte order: m, metadata_size, reqq, v.
        bstr(&mut out, b"m");
        out.push(b'd');
        if let Some(ut_metadata) = self.ut_metadata {
            validate_extension_id("ut_metadata", ut_metadata)?;
            bstr(&mut out, b"ut_metadata");
            bint(&mut out, i64::from(ut_metadata));
        }
        if let Some(ut_pex) = self.ut_pex {
            validate_extension_id("ut_pex", ut_pex)?;
            bstr(&mut out, b"ut_pex");
            bint(&mut out, i64::from(ut_pex));
        }
        out.push(b'e');

        if let Some(metadata_size) = self.metadata_size {
            bstr(&mut out, b"metadata_size");
            bint(&mut out, metadata_size as i64);
        }

        if let Some(reqq) = self.request_queue {
            bstr(&mut out, b"reqq");
            bint(&mut out, i64::from(reqq));
        }

        if let Some(client_name) = &self.client_name {
            bstr(&mut out, b"v");
            bstr(&mut out, client_name.as_bytes());
        }

        out.push(b'e');
        if out.len() > MAX_EXTENDED_HANDSHAKE_BYTES {
            return Err(ExtensionError::HandshakeTooLarge(out.len()));
        }
        Ok(out)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ExtensionError> {
        if bytes.len() > MAX_EXTENDED_HANDSHAKE_BYTES {
            return Err(ExtensionError::HandshakeTooLarge(bytes.len()));
        }
        let mut parser = Parser::new(bytes);
        let value = parser.parse_value(0)?;
        parser.finish()?;
        let dict = value
            .as_dict()
            .ok_or_else(|| ExtensionError::InvalidBencode("extended handshake must be a dictionary".to_owned()))?;

        let mut handshake = Self::default();

        if let Some(value) = dict_get(dict, b"metadata_size").and_then(BValue::as_int) {
            let size = usize::try_from(value)
                .map_err(|_| ExtensionError::InvalidMetadataSize(usize::MAX))?;
            if size == 0 || size > MAX_METADATA_SIZE {
                return Err(ExtensionError::InvalidMetadataSize(size));
            }
            handshake.metadata_size = Some(size);
        }

        if let Some(map) = dict_get(dict, b"m").and_then(BValue::as_dict) {
            if let Some(value) = dict_get(map, b"ut_metadata").and_then(BValue::as_int) {
                let id = u8::try_from(value)
                    .map_err(|_| ExtensionError::InvalidExtensionId("ut_metadata"))?;
                validate_extension_id("ut_metadata", id)?;
                handshake.ut_metadata = Some(id);
            }
            if let Some(value) = dict_get(map, b"ut_pex").and_then(BValue::as_int) {
                let id = u8::try_from(value)
                    .map_err(|_| ExtensionError::InvalidExtensionId("ut_pex"))?;
                validate_extension_id("ut_pex", id)?;
                handshake.ut_pex = Some(id);
            }
        }

        if let Some(value) = dict_get(dict, b"reqq").and_then(BValue::as_int) {
            handshake.request_queue = u32::try_from(value).ok();
        }

        if let Some(value) = dict_get(dict, b"v").and_then(BValue::as_bytes) {
            let value = std::str::from_utf8(value)
                .map_err(|_| ExtensionError::InvalidUtf8("v"))?;
            handshake.client_name = Some(value.chars().take(128).collect());
        }

        Ok(handshake)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MetadataMessage {
    Request { piece: u32 },
    Data {
        piece: u32,
        total_size: usize,
        data: Vec<u8>,
    },
    Reject { piece: u32 },
}

impl MetadataMessage {
    pub fn request(piece: u32) -> Self {
        Self::Request { piece }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ExtensionError> {
        let mut out = Vec::new();
        match self {
            Self::Request { piece } => {
                out.extend_from_slice(b"d8:msg_typei0e5:piecei");
                out.extend_from_slice(piece.to_string().as_bytes());
                out.extend_from_slice(b"ee");
            }
            Self::Data {
                piece,
                total_size,
                data,
            } => {
                if *total_size == 0 || *total_size > MAX_METADATA_SIZE {
                    return Err(ExtensionError::InvalidMetadataSize(*total_size));
                }
                validate_metadata_piece(*piece, *total_size, data.len())?;
                out.extend_from_slice(b"d8:msg_typei1e5:piecei");
                out.extend_from_slice(piece.to_string().as_bytes());
                out.extend_from_slice(b"e10:total_sizei");
                out.extend_from_slice(total_size.to_string().as_bytes());
                out.extend_from_slice(b"ee");
                out.extend_from_slice(data);
            }
            Self::Reject { piece } => {
                out.extend_from_slice(b"d8:msg_typei2e5:piecei");
                out.extend_from_slice(piece.to_string().as_bytes());
                out.extend_from_slice(b"ee");
            }
        }
        Ok(out)
    }

    pub fn parse(payload: &[u8]) -> Result<Self, ExtensionError> {
        if payload.len() > MAX_METADATA_SIZE + 1024 {
            return Err(ExtensionError::MetadataMessageTooLarge(payload.len()));
        }

        let mut parser = Parser::new(payload);
        let header = parser.parse_value(0)?;
        let consumed = parser.position;
        let dict = header
            .as_dict()
            .ok_or_else(|| ExtensionError::InvalidBencode("ut_metadata header must be a dictionary".to_owned()))?;
        let msg_type = dict_get(dict, b"msg_type")
            .and_then(BValue::as_int)
            .ok_or(ExtensionError::MissingField("msg_type"))?;
        let piece = dict_get(dict, b"piece")
            .and_then(BValue::as_int)
            .ok_or(ExtensionError::MissingField("piece"))
            .and_then(|value| {
                u32::try_from(value).map_err(|_| ExtensionError::InvalidPieceIndex(value))
            })?;

        match msg_type {
            0 => {
                if consumed != payload.len() {
                    return Err(ExtensionError::UnexpectedMetadataPayload);
                }
                Ok(Self::Request { piece })
            }
            1 => {
                let total_size = dict_get(dict, b"total_size")
                    .and_then(BValue::as_int)
                    .ok_or(ExtensionError::MissingField("total_size"))
                    .and_then(|value| {
                        usize::try_from(value)
                            .map_err(|_| ExtensionError::InvalidMetadataSize(usize::MAX))
                    })?;
                if total_size == 0 || total_size > MAX_METADATA_SIZE {
                    return Err(ExtensionError::InvalidMetadataSize(total_size));
                }
                let data = payload[consumed..].to_vec();
                validate_metadata_piece(piece, total_size, data.len())?;
                Ok(Self::Data {
                    piece,
                    total_size,
                    data,
                })
            }
            2 => {
                if consumed != payload.len() {
                    return Err(ExtensionError::UnexpectedMetadataPayload);
                }
                Ok(Self::Reject { piece })
            }
            other => Err(ExtensionError::UnsupportedMetadataMessage(other)),
        }
    }
}

#[derive(Clone, Debug)]
pub struct MetadataAssembler {
    info_hash: InfoHash,
    total_size: usize,
    pieces: Vec<Option<Vec<u8>>>,
    received_bytes: usize,
}

impl MetadataAssembler {
    pub fn new(info_hash: InfoHash, total_size: usize) -> Result<Self, ExtensionError> {
        if total_size == 0 || total_size > MAX_METADATA_SIZE {
            return Err(ExtensionError::InvalidMetadataSize(total_size));
        }
        let count = total_size.div_ceil(METADATA_PIECE_SIZE);
        Ok(Self {
            info_hash,
            total_size,
            pieces: vec![None; count],
            received_bytes: 0,
        })
    }

    pub const fn total_size(&self) -> usize {
        self.total_size
    }

    pub fn piece_count(&self) -> usize {
        self.pieces.len()
    }

    pub const fn received_bytes(&self) -> usize {
        self.received_bytes
    }

    pub fn has_piece(&self, piece: u32) -> bool {
        self.pieces
            .get(piece as usize)
            .is_some_and(Option::is_some)
    }

    pub fn missing_pieces(&self) -> Vec<u32> {
        self.pieces
            .iter()
            .enumerate()
            .filter_map(|(index, piece)| piece.is_none().then_some(index as u32))
            .collect()
    }

    pub fn insert(
        &mut self,
        piece: u32,
        total_size: usize,
        data: Vec<u8>,
    ) -> Result<bool, ExtensionError> {
        if total_size != self.total_size {
            return Err(ExtensionError::MetadataSizeChanged {
                expected: self.total_size,
                actual: total_size,
            });
        }
        validate_metadata_piece(piece, total_size, data.len())?;
        let count = self.pieces.len();
        let index = piece as usize;
        if index >= count {
            return Err(ExtensionError::MetadataPieceOutOfRange { piece, count });
        }

        if let Some(existing) = self.pieces[index].as_ref() {
            if existing != &data {
                return Err(ExtensionError::ConflictingMetadataPiece(piece));
            }
            return Ok(self.is_complete());
        }

        self.received_bytes = self
            .received_bytes
            .checked_add(data.len())
            .ok_or(ExtensionError::MetadataLengthOverflow)?;
        self.pieces[index] = Some(data);
        Ok(self.is_complete())
    }

    pub fn is_complete(&self) -> bool {
        self.pieces.iter().all(Option::is_some)
    }

    pub fn finish(self) -> Result<Vec<u8>, ExtensionError> {
        if !self.is_complete() {
            return Err(ExtensionError::MetadataIncomplete);
        }

        let mut metadata = Vec::with_capacity(self.total_size);
        for piece in self.pieces {
            metadata.extend_from_slice(
                piece
                    .as_deref()
                    .ok_or(ExtensionError::MetadataIncomplete)?,
            );
        }
        if metadata.len() != self.total_size {
            return Err(ExtensionError::MetadataSizeChanged {
                expected: self.total_size,
                actual: metadata.len(),
            });
        }

        let digest = Sha1::digest(&metadata);
        let mut actual = [0u8; 20];
        actual.copy_from_slice(&digest);
        if actual != *self.info_hash.as_bytes() {
            return Err(ExtensionError::MetadataHashMismatch);
        }

        Ok(metadata)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PeerExchange {
    pub added: Vec<std::net::SocketAddr>,
    pub dropped: Vec<std::net::SocketAddr>,
}

impl PeerExchange {
    pub fn parse(payload: &[u8]) -> Result<Self, ExtensionError> {
        if payload.len() > 256 * 1024 {
            return Err(ExtensionError::PexMessageTooLarge(payload.len()));
        }
        let mut parser = Parser::new(payload);
        let value = parser.parse_value(0)?;
        parser.finish()?;
        let dict = value
            .as_dict()
            .ok_or_else(|| ExtensionError::InvalidBencode("ut_pex payload must be a dictionary".to_owned()))?;

        let mut added = Vec::new();
        let mut dropped = Vec::new();
        if let Some(bytes) = dict_get(dict, b"added").and_then(BValue::as_bytes) {
            parse_compact_ipv4(bytes, &mut added)?;
        }
        if let Some(bytes) = dict_get(dict, b"added6").and_then(BValue::as_bytes) {
            parse_compact_ipv6(bytes, &mut added)?;
        }
        if let Some(bytes) = dict_get(dict, b"dropped").and_then(BValue::as_bytes) {
            parse_compact_ipv4(bytes, &mut dropped)?;
        }
        if let Some(bytes) = dict_get(dict, b"dropped6").and_then(BValue::as_bytes) {
            parse_compact_ipv6(bytes, &mut dropped)?;
        }

        dedup_limit(&mut added);
        dedup_limit(&mut dropped);
        Ok(Self { added, dropped })
    }
}

fn validate_extension_id(name: &'static str, id: u8) -> Result<(), ExtensionError> {
    if id == 0 {
        Err(ExtensionError::InvalidExtensionId(name))
    } else {
        Ok(())
    }
}

fn validate_metadata_piece(
    piece: u32,
    total_size: usize,
    data_len: usize,
) -> Result<(), ExtensionError> {
    if total_size == 0 || total_size > MAX_METADATA_SIZE {
        return Err(ExtensionError::InvalidMetadataSize(total_size));
    }
    let count = total_size.div_ceil(METADATA_PIECE_SIZE);
    let index = piece as usize;
    if index >= count {
        return Err(ExtensionError::MetadataPieceOutOfRange {
            piece,
            count,
        });
    }
    let expected = if index + 1 == count {
        total_size - index * METADATA_PIECE_SIZE
    } else {
        METADATA_PIECE_SIZE
    };
    if data_len != expected {
        return Err(ExtensionError::InvalidMetadataPieceLength {
            piece,
            expected,
            actual: data_len,
        });
    }
    Ok(())
}

fn parse_compact_ipv4(
    bytes: &[u8],
    output: &mut Vec<std::net::SocketAddr>,
) -> Result<(), ExtensionError> {
    if bytes.len() % 6 != 0 {
        return Err(ExtensionError::InvalidCompactPeers("IPv4"));
    }
    for chunk in bytes.chunks_exact(6).take(MAX_PEX_PEERS) {
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        if port == 0 {
            continue;
        }
        output.push(std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(
                chunk[0], chunk[1], chunk[2], chunk[3],
            )),
            port,
        ));
    }
    Ok(())
}

fn parse_compact_ipv6(
    bytes: &[u8],
    output: &mut Vec<std::net::SocketAddr>,
) -> Result<(), ExtensionError> {
    if bytes.len() % 18 != 0 {
        return Err(ExtensionError::InvalidCompactPeers("IPv6"));
    }
    for chunk in bytes.chunks_exact(18).take(MAX_PEX_PEERS) {
        let mut octets = [0u8; 16];
        octets.copy_from_slice(&chunk[..16]);
        let port = u16::from_be_bytes([chunk[16], chunk[17]]);
        if port == 0 {
            continue;
        }
        output.push(std::net::SocketAddr::new(
            std::net::IpAddr::V6(std::net::Ipv6Addr::from(octets)),
            port,
        ));
    }
    Ok(())
}

fn dedup_limit(peers: &mut Vec<std::net::SocketAddr>) {
    peers.sort_unstable();
    peers.dedup();
    peers.truncate(MAX_PEX_PEERS);
}

fn bstr(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(value.len().to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(value);
}

fn bint(out: &mut Vec<u8>, value: i64) {
    out.push(b'i');
    out.extend_from_slice(value.to_string().as_bytes());
    out.push(b'e');
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BValue<'a> {
    Int(i64),
    Bytes(&'a [u8]),
    Dict(BTreeMap<&'a [u8], BValue<'a>>),
}

impl<'a> BValue<'a> {
    fn as_int(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }

    fn as_bytes(&self) -> Option<&'a [u8]> {
        match self {
            Self::Bytes(value) => Some(value),
            _ => None,
        }
    }

    fn as_dict(&self) -> Option<&BTreeMap<&'a [u8], BValue<'a>>> {
        match self {
            Self::Dict(value) => Some(value),
            _ => None,
        }
    }
}

fn dict_get<'a, 'b>(
    dictionary: &'b BTreeMap<&'a [u8], BValue<'a>>,
    key: &[u8],
) -> Option<&'b BValue<'a>> {
    dictionary
        .iter()
        .find_map(|(entry_key, value)| (*entry_key == key).then_some(value))
}

struct Parser<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, position: 0 }
    }

    fn parse_value(&mut self, depth: usize) -> Result<BValue<'a>, ExtensionError> {
        if depth > 16 {
            return Err(ExtensionError::InvalidBencode(
                "maximum extension bencode depth exceeded".to_owned(),
            ));
        }
        match self.input.get(self.position).copied() {
            Some(b'i') => self.parse_int().map(BValue::Int),
            Some(b'd') => self.parse_dict(depth).map(BValue::Dict),
            Some(byte) if byte.is_ascii_digit() => self.parse_bytes().map(BValue::Bytes),
            Some(byte) => Err(ExtensionError::InvalidBencode(format!(
                "unexpected extension byte 0x{byte:02x}"
            ))),
            None => Err(ExtensionError::InvalidBencode(
                "unexpected end of extension payload".to_owned(),
            )),
        }
    }

    fn parse_int(&mut self) -> Result<i64, ExtensionError> {
        self.expect(b'i')?;
        let start = self.position;
        while self.input.get(self.position).copied() != Some(b'e') {
            if self.position >= self.input.len() {
                return Err(ExtensionError::InvalidBencode(
                    "unterminated integer".to_owned(),
                ));
            }
            self.position += 1;
        }
        let raw = &self.input[start..self.position];
        self.expect(b'e')?;
        if raw.is_empty()
            || raw == b"-0"
            || (raw.len() > 1 && raw[0] == b'0')
            || (raw.len() > 2 && raw[0] == b'-' && raw[1] == b'0')
        {
            return Err(ExtensionError::InvalidBencode(
                "non-canonical integer".to_owned(),
            ));
        }
        std::str::from_utf8(raw)
            .ok()
            .and_then(|text| text.parse::<i64>().ok())
            .ok_or_else(|| ExtensionError::InvalidBencode("invalid integer".to_owned()))
    }

    fn parse_bytes(&mut self) -> Result<&'a [u8], ExtensionError> {
        let start = self.position;
        while let Some(byte) = self.input.get(self.position).copied() {
            if byte == b':' {
                break;
            }
            if !byte.is_ascii_digit() {
                return Err(ExtensionError::InvalidBencode(
                    "invalid byte-string length".to_owned(),
                ));
            }
            self.position += 1;
        }
        let digits = &self.input[start..self.position];
        self.expect(b':')?;
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
            return Err(ExtensionError::InvalidBencode(
                "non-canonical byte-string length".to_owned(),
            ));
        }
        let length = std::str::from_utf8(digits)
            .ok()
            .and_then(|text| text.parse::<usize>().ok())
            .ok_or_else(|| ExtensionError::InvalidBencode("byte-string length overflow".to_owned()))?;
        let end = self
            .position
            .checked_add(length)
            .ok_or(ExtensionError::MetadataLengthOverflow)?;
        let value = self
            .input
            .get(self.position..end)
            .ok_or_else(|| ExtensionError::InvalidBencode("truncated byte string".to_owned()))?;
        self.position = end;
        Ok(value)
    }

    fn parse_dict(
        &mut self,
        depth: usize,
    ) -> Result<BTreeMap<&'a [u8], BValue<'a>>, ExtensionError> {
        self.expect(b'd')?;
        let mut entries = BTreeMap::new();
        let mut previous: Option<&[u8]> = None;
        while self.input.get(self.position).copied() != Some(b'e') {
            if entries.len() >= 128 {
                return Err(ExtensionError::InvalidBencode(
                    "extension dictionary too large".to_owned(),
                ));
            }
            let key = self.parse_bytes()?;
            if previous.is_some_and(|previous| previous >= key) {
                return Err(ExtensionError::InvalidBencode(
                    "extension dictionary keys must be strictly sorted".to_owned(),
                ));
            }
            previous = Some(key);
            let value = self.parse_value(depth + 1)?;
            entries.insert(key, value);
        }
        self.expect(b'e')?;
        Ok(entries)
    }

    fn expect(&mut self, expected: u8) -> Result<(), ExtensionError> {
        match self.input.get(self.position).copied() {
            Some(actual) if actual == expected => {
                self.position += 1;
                Ok(())
            }
            Some(actual) => Err(ExtensionError::InvalidBencode(format!(
                "expected 0x{expected:02x}, got 0x{actual:02x}"
            ))),
            None => Err(ExtensionError::InvalidBencode(
                "unexpected end of extension payload".to_owned(),
            )),
        }
    }

    fn finish(&self) -> Result<(), ExtensionError> {
        if self.position == self.input.len() {
            Ok(())
        } else {
            Err(ExtensionError::InvalidBencode(
                "trailing bytes after bencoded value".to_owned(),
            ))
        }
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum ExtensionError {
    #[error("invalid extension bencode: {0}")]
    InvalidBencode(String),
    #[error("extended handshake exceeds safe size: {0} bytes")]
    HandshakeTooLarge(usize),
    #[error("invalid extension id for {0}")]
    InvalidExtensionId(&'static str),
    #[error("invalid UTF-8 in extension field {0}")]
    InvalidUtf8(&'static str),
    #[error("missing extension field {0}")]
    MissingField(&'static str),
    #[error("invalid metadata size: {0}")]
    InvalidMetadataSize(usize),
    #[error("metadata message exceeds safe size: {0} bytes")]
    MetadataMessageTooLarge(usize),
    #[error("invalid metadata piece index {0}")]
    InvalidPieceIndex(i64),
    #[error("metadata piece {piece} is outside piece count {count}")]
    MetadataPieceOutOfRange { piece: u32, count: usize },
    #[error("metadata piece {piece} has invalid length: expected {expected}, got {actual}")]
    InvalidMetadataPieceLength {
        piece: u32,
        expected: usize,
        actual: usize,
    },
    #[error("unexpected raw payload for metadata control message")]
    UnexpectedMetadataPayload,
    #[error("unsupported ut_metadata message type {0}")]
    UnsupportedMetadataMessage(i64),
    #[error("metadata size changed during exchange: expected {expected}, got {actual}")]
    MetadataSizeChanged { expected: usize, actual: usize },
    #[error("conflicting duplicate metadata piece {0}")]
    ConflictingMetadataPiece(u32),
    #[error("metadata length arithmetic overflow")]
    MetadataLengthOverflow,
    #[error("metadata exchange is incomplete")]
    MetadataIncomplete,
    #[error("metadata SHA-1 does not match the magnet info hash")]
    MetadataHashMismatch,
    #[error("ut_pex payload exceeds safe size: {0} bytes")]
    PexMessageTooLarge(usize),
    #[error("invalid compact {0} peer list")]
    InvalidCompactPeers(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_handshake_round_trip() {
        let handshake = ExtendedHandshake::local(Some(32_000));
        let encoded = handshake.encode().expect("encode");
        let decoded = ExtendedHandshake::parse(&encoded).expect("parse");
        assert_eq!(decoded.ut_metadata, Some(LOCAL_UT_METADATA_ID));
        assert_eq!(decoded.ut_pex, Some(LOCAL_UT_PEX_ID));
        assert_eq!(decoded.metadata_size, Some(32_000));
        assert_eq!(decoded.request_queue, Some(32));
    }

    #[test]
    fn metadata_request_round_trip() {
        let encoded = MetadataMessage::request(7).encode().expect("encode");
        assert_eq!(
            MetadataMessage::parse(&encoded).expect("parse"),
            MetadataMessage::Request { piece: 7 }
        );
    }

    #[test]
    fn metadata_data_round_trip() {
        let data = vec![3u8; 100];
        let encoded = MetadataMessage::Data {
            piece: 0,
            total_size: 100,
            data: data.clone(),
        }
        .encode()
        .expect("encode");
        assert_eq!(
            MetadataMessage::parse(&encoded).expect("parse"),
            MetadataMessage::Data {
                piece: 0,
                total_size: 100,
                data,
            }
        );
    }

    #[test]
    fn metadata_assembler_verifies_info_hash() {
        let metadata = b"d6:lengthi1e4:name1:x12:piece lengthi1e6:pieces20:12345678901234567890e";
        let digest = Sha1::digest(metadata);
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&digest);
        let mut assembler = MetadataAssembler::new(InfoHash::new(hash), metadata.len()).unwrap();
        assert!(assembler
            .insert(0, metadata.len(), metadata.to_vec())
            .unwrap());
        assert_eq!(assembler.finish().unwrap(), metadata);
    }

    #[test]
    fn metadata_assembler_rejects_hash_mismatch() {
        let metadata = b"d4:name1:xe";
        let mut assembler = MetadataAssembler::new(InfoHash::new([0u8; 20]), metadata.len()).unwrap();
        assembler
            .insert(0, metadata.len(), metadata.to_vec())
            .unwrap();
        assert_eq!(
            assembler.finish().expect_err("hash mismatch"),
            ExtensionError::MetadataHashMismatch
        );
    }

    #[test]
    fn pex_parses_ipv4_and_ipv6() {
        let mut payload = b"d5:added6:".to_vec();
        payload.extend_from_slice(&[1, 2, 3, 4, 0x1a, 0xe1]);
        payload.extend_from_slice(b"6:added618:");
        payload.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        payload.extend_from_slice(&6882u16.to_be_bytes());
        payload.push(b'e');

        let pex = PeerExchange::parse(&payload).expect("pex");
        assert_eq!(pex.added.len(), 2);
        assert_eq!(
            pex.added[0],
            "1.2.3.4:6881".parse::<std::net::SocketAddr>().unwrap()
        );
    }
}
