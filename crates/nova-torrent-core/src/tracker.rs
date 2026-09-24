use crate::InfoHash;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use url::Url;

pub const MAX_TRACKER_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TRACKER_PEERS: usize = 10_000;
const MAX_TRACKER_BENCODE_DEPTH: usize = 16;
const UDP_TRACKER_PROTOCOL_ID: u64 = 0x4172_7101_980;
const UDP_CONNECT_ACTION: u32 = 0;
const UDP_ANNOUNCE_ACTION: u32 = 1;
const UDP_ERROR_ACTION: u32 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrackerEvent {
    None,
    Completed,
    Started,
    Stopped,
}

impl TrackerEvent {
    fn udp_code(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Completed => 1,
            Self::Started => 2,
            Self::Stopped => 3,
        }
    }

    fn http_value(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Completed => Some("completed"),
            Self::Started => Some("started"),
            Self::Stopped => Some("stopped"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrackerAnnounceRequest {
    pub info_hash: InfoHash,
    pub peer_id: [u8; 20],
    pub port: u16,
    pub uploaded: u64,
    pub downloaded: u64,
    pub left: u64,
    pub event: TrackerEvent,
    pub key: u32,
    pub num_want: Option<u32>,
}

impl TrackerAnnounceRequest {
    pub fn to_http_url(&self, base: &str) -> Result<String, TrackerProtocolError> {
        if self.port == 0 {
            return Err(TrackerProtocolError::InvalidPort);
        }
        let mut url = Url::parse(base)
            .map_err(|_| TrackerProtocolError::InvalidTrackerUrl(base.to_owned()))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(TrackerProtocolError::InvalidTrackerUrl(base.to_owned()));
        }

        let mut fields = Vec::new();
        if let Some(existing) = url.query() {
            if !existing.is_empty() {
                fields.push(existing.to_owned());
            }
        }
        fields.push(format!(
            "info_hash={}",
            percent_encode_bytes(self.info_hash.as_bytes())
        ));
        fields.push(format!("peer_id={}", percent_encode_bytes(&self.peer_id)));
        fields.push(format!("port={}", self.port));
        fields.push(format!("uploaded={}", self.uploaded));
        fields.push(format!("downloaded={}", self.downloaded));
        fields.push(format!("left={}", self.left));
        fields.push("compact=1".to_owned());
        fields.push("no_peer_id=1".to_owned());
        fields.push(format!("key={:08x}", self.key));
        if let Some(num_want) = self.num_want {
            fields.push(format!("numwant={}", num_want.min(MAX_TRACKER_PEERS as u32)));
        }
        if let Some(event) = self.event.http_value() {
            fields.push(format!("event={event}"));
        }

        url.set_query(Some(&fields.join("&")));
        Ok(url.to_string())
    }

    pub fn to_udp_announce_packet(
        &self,
        connection_id: u64,
        transaction_id: u32,
    ) -> Result<[u8; 98], TrackerProtocolError> {
        if self.port == 0 {
            return Err(TrackerProtocolError::InvalidPort);
        }

        let mut output = [0u8; 98];
        output[0..8].copy_from_slice(&connection_id.to_be_bytes());
        output[8..12].copy_from_slice(&UDP_ANNOUNCE_ACTION.to_be_bytes());
        output[12..16].copy_from_slice(&transaction_id.to_be_bytes());
        output[16..36].copy_from_slice(self.info_hash.as_bytes());
        output[36..56].copy_from_slice(&self.peer_id);
        output[56..64].copy_from_slice(&self.downloaded.to_be_bytes());
        output[64..72].copy_from_slice(&self.left.to_be_bytes());
        output[72..80].copy_from_slice(&self.uploaded.to_be_bytes());
        output[80..84].copy_from_slice(&self.event.udp_code().to_be_bytes());
        // 0.0.0.0 asks the tracker to infer our external IPv4 address.
        output[84..88].copy_from_slice(&0u32.to_be_bytes());
        output[88..92].copy_from_slice(&self.key.to_be_bytes());
        let num_want = self
            .num_want
            .map(|value| value.min(MAX_TRACKER_PEERS as u32) as i32)
            .unwrap_or(-1);
        output[92..96].copy_from_slice(&num_want.to_be_bytes());
        output[96..98].copy_from_slice(&self.port.to_be_bytes());
        Ok(output)
    }
}

pub fn udp_connect_packet(transaction_id: u32) -> [u8; 16] {
    let mut output = [0u8; 16];
    output[0..8].copy_from_slice(&UDP_TRACKER_PROTOCOL_ID.to_be_bytes());
    output[8..12].copy_from_slice(&UDP_CONNECT_ACTION.to_be_bytes());
    output[12..16].copy_from_slice(&transaction_id.to_be_bytes());
    output
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UdpConnectResponse {
    pub transaction_id: u32,
    pub connection_id: u64,
}

impl UdpConnectResponse {
    pub fn parse(
        bytes: &[u8],
        expected_transaction_id: u32,
    ) -> Result<Self, TrackerProtocolError> {
        ensure_response_size(bytes)?;
        if bytes.len() < 8 {
            return Err(TrackerProtocolError::TruncatedUdpResponse {
                needed: 8,
                actual: bytes.len(),
            });
        }
        let action = read_u32(bytes, 0);
        let transaction_id = read_u32(bytes, 4);
        validate_udp_transaction(transaction_id, expected_transaction_id)?;
        if action == UDP_ERROR_ACTION {
            return Err(TrackerProtocolError::TrackerFailure(
                decode_udp_error(&bytes[8..]),
            ));
        }
        if action != UDP_CONNECT_ACTION {
            return Err(TrackerProtocolError::UnexpectedUdpAction {
                expected: UDP_CONNECT_ACTION,
                actual: action,
            });
        }
        if bytes.len() != 16 {
            return Err(TrackerProtocolError::InvalidUdpLength {
                expected: 16,
                actual: bytes.len(),
            });
        }
        Ok(Self {
            transaction_id,
            connection_id: read_u64(bytes, 8),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrackerPeer {
    pub address: SocketAddr,
    pub peer_id: Option<[u8; 20]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UdpAnnounceResponse {
    pub transaction_id: u32,
    pub interval_seconds: u32,
    pub leechers: u32,
    pub seeders: u32,
    pub peers: Vec<TrackerPeer>,
}

impl UdpAnnounceResponse {
    pub fn parse(
        bytes: &[u8],
        expected_transaction_id: u32,
    ) -> Result<Self, TrackerProtocolError> {
        ensure_response_size(bytes)?;
        if bytes.len() < 8 {
            return Err(TrackerProtocolError::TruncatedUdpResponse {
                needed: 8,
                actual: bytes.len(),
            });
        }
        let action = read_u32(bytes, 0);
        let transaction_id = read_u32(bytes, 4);
        validate_udp_transaction(transaction_id, expected_transaction_id)?;
        if action == UDP_ERROR_ACTION {
            return Err(TrackerProtocolError::TrackerFailure(
                decode_udp_error(&bytes[8..]),
            ));
        }
        if action != UDP_ANNOUNCE_ACTION {
            return Err(TrackerProtocolError::UnexpectedUdpAction {
                expected: UDP_ANNOUNCE_ACTION,
                actual: action,
            });
        }
        if bytes.len() < 20 {
            return Err(TrackerProtocolError::TruncatedUdpResponse {
                needed: 20,
                actual: bytes.len(),
            });
        }
        let peers = parse_compact_ipv4(&bytes[20..])?;
        Ok(Self {
            transaction_id,
            interval_seconds: read_u32(bytes, 8),
            leechers: read_u32(bytes, 12),
            seeders: read_u32(bytes, 16),
            peers,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpTrackerResponse {
    pub interval_seconds: u32,
    pub min_interval_seconds: Option<u32>,
    pub complete: Option<u32>,
    pub incomplete: Option<u32>,
    pub warning: Option<String>,
    pub peers: Vec<TrackerPeer>,
}

impl HttpTrackerResponse {
    pub fn parse(bytes: &[u8]) -> Result<Self, TrackerProtocolError> {
        ensure_response_size(bytes)?;
        let mut parser = TrackerBencodeParser::new(bytes);
        let root = parser.parse_value(0)?;
        if parser.position != bytes.len() {
            return Err(TrackerProtocolError::InvalidBencode(
                "trailing bytes after tracker response".to_owned(),
            ));
        }
        let dict = match root {
            TrackerBValue::Dict(entries) => entries,
            _ => {
                return Err(TrackerProtocolError::InvalidBencode(
                    "tracker response must be a dictionary".to_owned(),
                ))
            }
        };

        if let Some(reason) = dict_bytes(&dict, b"failure reason") {
            return Err(TrackerProtocolError::TrackerFailure(
                String::from_utf8_lossy(reason).into_owned(),
            ));
        }

        let interval = dict_int(&dict, b"interval")
            .ok_or(TrackerProtocolError::MissingTrackerField("interval"))?;
        let interval_seconds = bounded_u32(interval, "interval")?;
        if interval_seconds == 0 {
            return Err(TrackerProtocolError::InvalidTrackerField {
                field: "interval",
                message: "must be greater than zero".to_owned(),
            });
        }

        let mut peers = Vec::new();
        if let Some(value) = dict_get(&dict, b"peers") {
            match value {
                TrackerBValue::Bytes(bytes) => peers.extend(parse_compact_ipv4(bytes)?),
                TrackerBValue::List(values) => peers.extend(parse_peer_list(values)?),
                _ => {
                    return Err(TrackerProtocolError::InvalidTrackerField {
                        field: "peers",
                        message: "must be a compact byte string or peer list".to_owned(),
                    })
                }
            }
        }
        if let Some(bytes) = dict_bytes(&dict, b"peers6") {
            peers.extend(parse_compact_ipv6(bytes)?);
        }
        deduplicate_peers(&mut peers);
        if peers.len() > MAX_TRACKER_PEERS {
            peers.truncate(MAX_TRACKER_PEERS);
        }

        Ok(Self {
            interval_seconds,
            min_interval_seconds: dict_int(&dict, b"min interval")
                .map(|value| bounded_u32(value, "min interval"))
                .transpose()?,
            complete: dict_int(&dict, b"complete")
                .map(|value| bounded_u32(value, "complete"))
                .transpose()?,
            incomplete: dict_int(&dict, b"incomplete")
                .map(|value| bounded_u32(value, "incomplete"))
                .transpose()?,
            warning: dict_bytes(&dict, b"warning message")
                .map(|value| String::from_utf8_lossy(value).into_owned()),
            peers,
        })
    }
}

fn percent_encode_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut output = String::with_capacity(bytes.len() * 3);
    for byte in bytes {
        output.push('%');
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn ensure_response_size(bytes: &[u8]) -> Result<(), TrackerProtocolError> {
    if bytes.len() > MAX_TRACKER_RESPONSE_BYTES {
        return Err(TrackerProtocolError::ResponseTooLarge {
            actual: bytes.len(),
            limit: MAX_TRACKER_RESPONSE_BYTES,
        });
    }
    Ok(())
}

fn validate_udp_transaction(
    actual: u32,
    expected: u32,
) -> Result<(), TrackerProtocolError> {
    if actual != expected {
        return Err(TrackerProtocolError::TransactionMismatch { expected, actual });
    }
    Ok(())
}

fn decode_udp_error(bytes: &[u8]) -> String {
    let limited = &bytes[..bytes.len().min(1024)];
    String::from_utf8_lossy(limited).into_owned()
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("validated tracker packet"),
    )
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("validated tracker packet"),
    )
}

fn parse_compact_ipv4(bytes: &[u8]) -> Result<Vec<TrackerPeer>, TrackerProtocolError> {
    if bytes.len() % 6 != 0 {
        return Err(TrackerProtocolError::InvalidCompactPeers {
            family: "IPv4",
            length: bytes.len(),
        });
    }
    let count = bytes.len() / 6;
    if count > MAX_TRACKER_PEERS {
        return Err(TrackerProtocolError::TooManyPeers(count));
    }

    let mut peers = Vec::with_capacity(count);
    for chunk in bytes.chunks_exact(6) {
        let ip = Ipv4Addr::new(chunk[0], chunk[1], chunk[2], chunk[3]);
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        if port != 0 {
            peers.push(TrackerPeer {
                address: SocketAddr::new(IpAddr::V4(ip), port),
                peer_id: None,
            });
        }
    }
    Ok(peers)
}

fn parse_compact_ipv6(bytes: &[u8]) -> Result<Vec<TrackerPeer>, TrackerProtocolError> {
    if bytes.len() % 18 != 0 {
        return Err(TrackerProtocolError::InvalidCompactPeers {
            family: "IPv6",
            length: bytes.len(),
        });
    }
    let count = bytes.len() / 18;
    if count > MAX_TRACKER_PEERS {
        return Err(TrackerProtocolError::TooManyPeers(count));
    }

    let mut peers = Vec::with_capacity(count);
    for chunk in bytes.chunks_exact(18) {
        let mut octets = [0u8; 16];
        octets.copy_from_slice(&chunk[..16]);
        let port = u16::from_be_bytes([chunk[16], chunk[17]]);
        if port != 0 {
            peers.push(TrackerPeer {
                address: SocketAddr::new(IpAddr::V6(Ipv6Addr::from(octets)), port),
                peer_id: None,
            });
        }
    }
    Ok(peers)
}

fn parse_peer_list(values: &[TrackerBValue<'_>]) -> Result<Vec<TrackerPeer>, TrackerProtocolError> {
    if values.len() > MAX_TRACKER_PEERS {
        return Err(TrackerProtocolError::TooManyPeers(values.len()));
    }
    let mut peers = Vec::with_capacity(values.len());
    for value in values {
        let entries = match value {
            TrackerBValue::Dict(entries) => entries,
            _ => continue,
        };
        let Some(ip_bytes) = dict_bytes(entries, b"ip") else {
            continue;
        };
        let Ok(ip_text) = std::str::from_utf8(ip_bytes) else {
            continue;
        };
        let Ok(ip) = ip_text.parse::<IpAddr>() else {
            continue;
        };
        let Some(port) = dict_int(entries, b"port")
            .and_then(|value| u16::try_from(value).ok())
            .filter(|port| *port != 0)
        else {
            continue;
        };
        let peer_id = dict_bytes(entries, b"peer id").and_then(|bytes| {
            if bytes.len() == 20 {
                let mut id = [0u8; 20];
                id.copy_from_slice(bytes);
                Some(id)
            } else {
                None
            }
        });
        peers.push(TrackerPeer {
            address: SocketAddr::new(ip, port),
            peer_id,
        });
    }
    Ok(peers)
}

fn deduplicate_peers(peers: &mut Vec<TrackerPeer>) {
    let mut seen = HashSet::new();
    peers.retain(|peer| seen.insert(peer.address));
}

fn bounded_u32(value: i64, field: &'static str) -> Result<u32, TrackerProtocolError> {
    u32::try_from(value).map_err(|_| TrackerProtocolError::InvalidTrackerField {
        field,
        message: format!("value {value} is outside u32 range"),
    })
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum TrackerProtocolError {
    #[error("invalid tracker URL: {0}")]
    InvalidTrackerUrl(String),
    #[error("tracker announce port cannot be zero")]
    InvalidPort,
    #[error("tracker response exceeds limit: {actual} bytes > {limit} bytes")]
    ResponseTooLarge { actual: usize, limit: usize },
    #[error("invalid tracker bencode: {0}")]
    InvalidBencode(String),
    #[error("tracker failed: {0}")]
    TrackerFailure(String),
    #[error("tracker response is missing field: {0}")]
    MissingTrackerField(&'static str),
    #[error("invalid tracker field {field}: {message}")]
    InvalidTrackerField {
        field: &'static str,
        message: String,
    },
    #[error("invalid compact {family} peer list length: {length}")]
    InvalidCompactPeers {
        family: &'static str,
        length: usize,
    },
    #[error("tracker returned too many peers: {0}")]
    TooManyPeers(usize),
    #[error("UDP tracker transaction mismatch: expected {expected}, got {actual}")]
    TransactionMismatch { expected: u32, actual: u32 },
    #[error("unexpected UDP tracker action: expected {expected}, got {actual}")]
    UnexpectedUdpAction { expected: u32, actual: u32 },
    #[error("truncated UDP tracker response: need {needed} bytes, got {actual}")]
    TruncatedUdpResponse { needed: usize, actual: usize },
    #[error("invalid UDP tracker response length: expected {expected}, got {actual}")]
    InvalidUdpLength { expected: usize, actual: usize },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TrackerBValue<'a> {
    Int(i64),
    Bytes(&'a [u8]),
    List(Vec<TrackerBValue<'a>>),
    Dict(Vec<(&'a [u8], TrackerBValue<'a>)>),
}

struct TrackerBencodeParser<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> TrackerBencodeParser<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, position: 0 }
    }

    fn parse_value(&mut self, depth: usize) -> Result<TrackerBValue<'a>, TrackerProtocolError> {
        if depth > MAX_TRACKER_BENCODE_DEPTH {
            return Err(TrackerProtocolError::InvalidBencode(
                "maximum tracker bencode depth exceeded".to_owned(),
            ));
        }
        match self.input.get(self.position).copied() {
            Some(b'i') => self.parse_int().map(TrackerBValue::Int),
            Some(b'l') => self.parse_list(depth).map(TrackerBValue::List),
            Some(b'd') => self.parse_dict(depth).map(TrackerBValue::Dict),
            Some(byte) if byte.is_ascii_digit() => self.parse_bytes().map(TrackerBValue::Bytes),
            Some(byte) => Err(TrackerProtocolError::InvalidBencode(format!(
                "unexpected byte 0x{byte:02x} at offset {}",
                self.position
            ))),
            None => Err(TrackerProtocolError::InvalidBencode(
                "unexpected end of tracker response".to_owned(),
            )),
        }
    }

    fn parse_int(&mut self) -> Result<i64, TrackerProtocolError> {
        self.expect(b'i')?;
        let start = self.position;
        while self.input.get(self.position).copied() != Some(b'e') {
            if self.position >= self.input.len() {
                return Err(TrackerProtocolError::InvalidBencode(
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
            return Err(TrackerProtocolError::InvalidBencode(
                "non-canonical integer".to_owned(),
            ));
        }
        let text = std::str::from_utf8(raw)
            .map_err(|_| TrackerProtocolError::InvalidBencode("invalid integer".to_owned()))?;
        text.parse::<i64>()
            .map_err(|_| TrackerProtocolError::InvalidBencode("integer overflow".to_owned()))
    }

    fn parse_bytes(&mut self) -> Result<&'a [u8], TrackerProtocolError> {
        let start = self.position;
        while let Some(byte) = self.input.get(self.position).copied() {
            if byte == b':' {
                break;
            }
            if !byte.is_ascii_digit() {
                return Err(TrackerProtocolError::InvalidBencode(
                    "invalid byte-string length".to_owned(),
                ));
            }
            self.position += 1;
        }
        let digits = &self.input[start..self.position];
        self.expect(b':')?;
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
            return Err(TrackerProtocolError::InvalidBencode(
                "non-canonical byte-string length".to_owned(),
            ));
        }
        let length = std::str::from_utf8(digits)
            .ok()
            .and_then(|text| text.parse::<usize>().ok())
            .ok_or_else(|| {
                TrackerProtocolError::InvalidBencode("byte-string length overflow".to_owned())
            })?;
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| TrackerProtocolError::InvalidBencode("length overflow".to_owned()))?;
        let value = self.input.get(self.position..end).ok_or_else(|| {
            TrackerProtocolError::InvalidBencode("truncated byte string".to_owned())
        })?;
        self.position = end;
        Ok(value)
    }

    fn parse_list(&mut self, depth: usize) -> Result<Vec<TrackerBValue<'a>>, TrackerProtocolError> {
        self.expect(b'l')?;
        let mut values = Vec::new();
        while self.input.get(self.position).copied() != Some(b'e') {
            if values.len() >= MAX_TRACKER_PEERS.saturating_mul(4) {
                return Err(TrackerProtocolError::InvalidBencode(
                    "tracker list is too large".to_owned(),
                ));
            }
            values.push(self.parse_value(depth + 1)?);
        }
        self.expect(b'e')?;
        Ok(values)
    }

    fn parse_dict(
        &mut self,
        depth: usize,
    ) -> Result<Vec<(&'a [u8], TrackerBValue<'a>)>, TrackerProtocolError> {
        self.expect(b'd')?;
        let mut entries = Vec::new();
        let mut seen = HashSet::<Vec<u8>>::new();
        while self.input.get(self.position).copied() != Some(b'e') {
            if entries.len() >= 256 {
                return Err(TrackerProtocolError::InvalidBencode(
                    "tracker dictionary is too large".to_owned(),
                ));
            }
            let key = self.parse_bytes()?;
            if !seen.insert(key.to_vec()) {
                return Err(TrackerProtocolError::InvalidBencode(
                    "duplicate tracker dictionary key".to_owned(),
                ));
            }
            let value = self.parse_value(depth + 1)?;
            entries.push((key, value));
        }
        self.expect(b'e')?;
        Ok(entries)
    }

    fn expect(&mut self, expected: u8) -> Result<(), TrackerProtocolError> {
        match self.input.get(self.position).copied() {
            Some(actual) if actual == expected => {
                self.position += 1;
                Ok(())
            }
            Some(actual) => Err(TrackerProtocolError::InvalidBencode(format!(
                "expected 0x{expected:02x}, got 0x{actual:02x} at offset {}",
                self.position
            ))),
            None => Err(TrackerProtocolError::InvalidBencode(
                "unexpected end of tracker response".to_owned(),
            )),
        }
    }
}

fn dict_get<'a, 'b>(
    dictionary: &'b [(&'a [u8], TrackerBValue<'a>)],
    key: &[u8],
) -> Option<&'b TrackerBValue<'a>> {
    dictionary
        .iter()
        .find_map(|(entry_key, value)| (*entry_key == key).then_some(value))
}

fn dict_int(dictionary: &[(&[u8], TrackerBValue<'_>)], key: &[u8]) -> Option<i64> {
    match dict_get(dictionary, key) {
        Some(TrackerBValue::Int(value)) => Some(*value),
        _ => None,
    }
}

fn dict_bytes<'data>(
    dictionary: &[(&'data [u8], TrackerBValue<'data>)],
    key: &[u8],
) -> Option<&'data [u8]> {
    match dict_get(dictionary, key) {
        Some(TrackerBValue::Bytes(value)) => Some(*value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> TrackerAnnounceRequest {
        TrackerAnnounceRequest {
            info_hash: InfoHash::new([0x01; 20]),
            peer_id: *b"-NV0001-123456789012",
            port: 6881,
            uploaded: 3,
            downloaded: 4,
            left: 5,
            event: TrackerEvent::Started,
            key: 0x1234_abcd,
            num_want: Some(50),
        }
    }

    #[test]
    fn http_announce_percent_encodes_binary_identity() {
        let url = request()
            .to_http_url("https://tracker.test/announce?token=abc")
            .expect("http tracker");
        assert!(url.contains("token=abc&info_hash=%01%01%01"));
        assert!(url.contains("peer_id=%2D%4E%56%30"));
        assert!(url.contains("event=started"));
        assert!(url.contains("compact=1"));
    }

    #[test]
    fn parses_http_compact_ipv4_and_ipv6_peers() {
        let mut response = b"d8:completei2e10:incompletei3e8:intervali1800e5:peers12:".to_vec();
        response.extend_from_slice(&[1, 2, 3, 4, 0x1a, 0xe1]);
        response.extend_from_slice(&[5, 6, 7, 8, 0x1a, 0xe2]);
        response.extend_from_slice(b"6:peers618:");
        response.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        response.extend_from_slice(&6883u16.to_be_bytes());
        response.push(b'e');

        let parsed = HttpTrackerResponse::parse(&response).expect("tracker response");
        assert_eq!(parsed.interval_seconds, 1800);
        assert_eq!(parsed.complete, Some(2));
        assert_eq!(parsed.incomplete, Some(3));
        assert_eq!(parsed.peers.len(), 3);
        assert_eq!(
            parsed.peers[0].address,
            "1.2.3.4:6881".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(parsed.peers[2].address.port(), 6883);
        assert!(parsed.peers[2].address.is_ipv6());
    }

    #[test]
    fn tracker_failure_reason_is_returned_as_error() {
        let bytes = b"d14:failure reason11:temporarilye";
        assert_eq!(
            HttpTrackerResponse::parse(bytes).expect_err("failure"),
            TrackerProtocolError::TrackerFailure("temporarily".to_owned())
        );
    }

    #[test]
    fn udp_connect_round_trip_fields_are_network_order() {
        let packet = udp_connect_packet(0x0102_0304);
        assert_eq!(read_u64(&packet, 0), UDP_TRACKER_PROTOCOL_ID);
        assert_eq!(read_u32(&packet, 8), UDP_CONNECT_ACTION);
        assert_eq!(read_u32(&packet, 12), 0x0102_0304);

        let mut response = Vec::new();
        response.extend_from_slice(&UDP_CONNECT_ACTION.to_be_bytes());
        response.extend_from_slice(&0x0102_0304u32.to_be_bytes());
        response.extend_from_slice(&0x1122_3344_5566_7788u64.to_be_bytes());
        assert_eq!(
            UdpConnectResponse::parse(&response, 0x0102_0304).unwrap(),
            UdpConnectResponse {
                transaction_id: 0x0102_0304,
                connection_id: 0x1122_3344_5566_7788,
            }
        );
    }

    #[test]
    fn udp_announce_encodes_request_and_decodes_peers() {
        let packet = request()
            .to_udp_announce_packet(0x1111_2222_3333_4444, 7)
            .expect("udp announce");
        assert_eq!(packet.len(), 98);
        assert_eq!(read_u32(&packet, 8), UDP_ANNOUNCE_ACTION);
        assert_eq!(read_u32(&packet, 12), 7);
        assert_eq!(u16::from_be_bytes([packet[96], packet[97]]), 6881);

        let mut response = Vec::new();
        response.extend_from_slice(&UDP_ANNOUNCE_ACTION.to_be_bytes());
        response.extend_from_slice(&7u32.to_be_bytes());
        response.extend_from_slice(&120u32.to_be_bytes());
        response.extend_from_slice(&4u32.to_be_bytes());
        response.extend_from_slice(&9u32.to_be_bytes());
        response.extend_from_slice(&[8, 8, 8, 8, 0x1a, 0xe1]);
        let parsed = UdpAnnounceResponse::parse(&response, 7).expect("udp response");
        assert_eq!(parsed.interval_seconds, 120);
        assert_eq!(parsed.leechers, 4);
        assert_eq!(parsed.seeders, 9);
        assert_eq!(
            parsed.peers[0].address,
            "8.8.8.8:6881".parse::<SocketAddr>().unwrap()
        );
    }

    #[test]
    fn udp_transaction_mismatch_is_rejected() {
        let mut response = Vec::new();
        response.extend_from_slice(&UDP_CONNECT_ACTION.to_be_bytes());
        response.extend_from_slice(&9u32.to_be_bytes());
        response.extend_from_slice(&123u64.to_be_bytes());
        assert_eq!(
            UdpConnectResponse::parse(&response, 7).expect_err("transaction mismatch"),
            TrackerProtocolError::TransactionMismatch {
                expected: 7,
                actual: 9,
            }
        );
    }
}
