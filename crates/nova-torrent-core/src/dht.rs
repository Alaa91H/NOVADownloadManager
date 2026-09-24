use crate::InfoHash;
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const MAX_DHT_PACKET_BYTES: usize = 65_507;
pub const MAX_DHT_TRANSACTION_BYTES: usize = 16;
pub const MAX_DHT_TOKEN_BYTES: usize = 64;
pub const MAX_DHT_NODES: usize = 2_048;
pub const MAX_DHT_PEERS: usize = 2_048;
const MAX_DHT_BENCODE_DEPTH: usize = 16;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DhtNodeId([u8; 20]);

impl DhtNodeId {
    pub const fn new(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    pub fn xor_distance(self, target: InfoHash) -> [u8; 20] {
        let mut distance = [0u8; 20];
        for (index, byte) in distance.iter_mut().enumerate() {
            *byte = self.0[index] ^ target.as_bytes()[index];
        }
        distance
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct DhtNode {
    pub id: DhtNodeId,
    pub address: SocketAddr,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DhtQuery {
    Ping {
        id: DhtNodeId,
    },
    FindNode {
        id: DhtNodeId,
        target: DhtNodeId,
    },
    GetPeers {
        id: DhtNodeId,
        info_hash: InfoHash,
    },
    AnnouncePeer {
        id: DhtNodeId,
        info_hash: InfoHash,
        port: u16,
        token: Vec<u8>,
        implied_port: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DhtResponse {
    pub id: DhtNodeId,
    pub token: Option<Vec<u8>>,
    pub nodes: Vec<DhtNode>,
    pub peers: Vec<SocketAddr>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DhtMessage {
    Query {
        transaction_id: Vec<u8>,
        query: DhtQuery,
    },
    Response {
        transaction_id: Vec<u8>,
        response: DhtResponse,
    },
    Error {
        transaction_id: Vec<u8>,
        code: i64,
        message: String,
    },
}

impl DhtMessage {
    pub fn encode(&self) -> Result<Vec<u8>, DhtError> {
        let mut out = Vec::new();
        match self {
            Self::Query {
                transaction_id,
                query,
            } => {
                validate_transaction(transaction_id)?;
                out.push(b'd');
                bstr(&mut out, b"a");
                encode_query_args(&mut out, query)?;
                bstr(&mut out, b"q");
                bstr(&mut out, query_name(query));
                bstr(&mut out, b"t");
                bstr(&mut out, transaction_id);
                bstr(&mut out, b"y");
                bstr(&mut out, b"q");
                out.push(b'e');
            }
            Self::Response {
                transaction_id,
                response,
            } => {
                validate_transaction(transaction_id)?;
                out.push(b'd');
                bstr(&mut out, b"r");
                encode_response(&mut out, response)?;
                bstr(&mut out, b"t");
                bstr(&mut out, transaction_id);
                bstr(&mut out, b"y");
                bstr(&mut out, b"r");
                out.push(b'e');
            }
            Self::Error {
                transaction_id,
                code,
                message,
            } => {
                validate_transaction(transaction_id)?;
                out.push(b'd');
                bstr(&mut out, b"e");
                out.push(b'l');
                bint(&mut out, *code);
                bstr(&mut out, message.as_bytes());
                out.push(b'e');
                bstr(&mut out, b"t");
                bstr(&mut out, transaction_id);
                bstr(&mut out, b"y");
                bstr(&mut out, b"e");
                out.push(b'e');
            }
        }

        if out.len() > MAX_DHT_PACKET_BYTES {
            return Err(DhtError::PacketTooLarge(out.len()));
        }
        Ok(out)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, DhtError> {
        if bytes.is_empty() {
            return Err(DhtError::InvalidBencode("empty DHT packet".to_owned()));
        }
        if bytes.len() > MAX_DHT_PACKET_BYTES {
            return Err(DhtError::PacketTooLarge(bytes.len()));
        }

        let mut parser = Parser::new(bytes);
        let value = parser.parse_value(0)?;
        parser.finish()?;
        let root = value
            .as_dict()
            .ok_or_else(|| DhtError::InvalidBencode("DHT packet must be a dictionary".to_owned()))?;

        let transaction_id = dict_bytes(root, b"t")
            .ok_or(DhtError::MissingField("t"))?
            .to_vec();
        validate_transaction(&transaction_id)?;
        let kind = dict_bytes(root, b"y").ok_or(DhtError::MissingField("y"))?;

        match kind {
            b"q" => parse_query(root, transaction_id),
            b"r" => parse_response(root, transaction_id),
            b"e" => parse_error(root, transaction_id),
            _ => Err(DhtError::InvalidMessageType),
        }
    }
}

fn query_name(query: &DhtQuery) -> &'static [u8] {
    match query {
        DhtQuery::Ping { .. } => b"ping",
        DhtQuery::FindNode { .. } => b"find_node",
        DhtQuery::GetPeers { .. } => b"get_peers",
        DhtQuery::AnnouncePeer { .. } => b"announce_peer",
    }
}

fn encode_query_args(out: &mut Vec<u8>, query: &DhtQuery) -> Result<(), DhtError> {
    out.push(b'd');
    match query {
        DhtQuery::Ping { id } => {
            bstr(out, b"id");
            bstr(out, id.as_bytes());
        }
        DhtQuery::FindNode { id, target } => {
            bstr(out, b"id");
            bstr(out, id.as_bytes());
            bstr(out, b"target");
            bstr(out, target.as_bytes());
        }
        DhtQuery::GetPeers { id, info_hash } => {
            bstr(out, b"id");
            bstr(out, id.as_bytes());
            bstr(out, b"info_hash");
            bstr(out, info_hash.as_bytes());
        }
        DhtQuery::AnnouncePeer {
            id,
            info_hash,
            port,
            token,
            implied_port,
        } => {
            if token.is_empty() || token.len() > MAX_DHT_TOKEN_BYTES {
                return Err(DhtError::InvalidTokenLength(token.len()));
            }
            if *port == 0 && !*implied_port {
                return Err(DhtError::InvalidPort);
            }
            bstr(out, b"id");
            bstr(out, id.as_bytes());
            if *implied_port {
                bstr(out, b"implied_port");
                bint(out, 1);
            }
            bstr(out, b"info_hash");
            bstr(out, info_hash.as_bytes());
            bstr(out, b"port");
            bint(out, i64::from(*port));
            bstr(out, b"token");
            bstr(out, token);
        }
    }
    out.push(b'e');
    Ok(())
}

fn encode_response(out: &mut Vec<u8>, response: &DhtResponse) -> Result<(), DhtError> {
    if response.nodes.len() > MAX_DHT_NODES {
        return Err(DhtError::TooManyNodes(response.nodes.len()));
    }
    if response.peers.len() > MAX_DHT_PEERS {
        return Err(DhtError::TooManyPeers(response.peers.len()));
    }
    if response
        .token
        .as_ref()
        .is_some_and(|token| token.is_empty() || token.len() > MAX_DHT_TOKEN_BYTES)
    {
        return Err(DhtError::InvalidTokenLength(
            response.token.as_ref().map_or(0, Vec::len),
        ));
    }

    out.push(b'd');
    bstr(out, b"id");
    bstr(out, response.id.as_bytes());

    let nodes4 = encode_nodes_v4(&response.nodes);
    if !nodes4.is_empty() {
        bstr(out, b"nodes");
        bstr(out, &nodes4);
    }
    let nodes6 = encode_nodes_v6(&response.nodes);
    if !nodes6.is_empty() {
        bstr(out, b"nodes6");
        bstr(out, &nodes6);
    }
    if let Some(token) = &response.token {
        bstr(out, b"token");
        bstr(out, token);
    }
    if !response.peers.is_empty() {
        bstr(out, b"values");
        out.push(b'l');
        for peer in &response.peers {
            match peer {
                SocketAddr::V4(address) => {
                    let mut compact = Vec::with_capacity(6);
                    compact.extend_from_slice(&address.ip().octets());
                    compact.extend_from_slice(&address.port().to_be_bytes());
                    bstr(out, &compact);
                }
                SocketAddr::V6(address) => {
                    let mut compact = Vec::with_capacity(18);
                    compact.extend_from_slice(&address.ip().octets());
                    compact.extend_from_slice(&address.port().to_be_bytes());
                    bstr(out, &compact);
                }
            }
        }
        out.push(b'e');
    }

    out.push(b'e');
    Ok(())
}

fn parse_query(
    root: &BTreeMap<&[u8], BValue<'_>>,
    transaction_id: Vec<u8>,
) -> Result<DhtMessage, DhtError> {
    let query_name = dict_bytes(root, b"q").ok_or(DhtError::MissingField("q"))?;
    let args = dict_get(root, b"a")
        .and_then(BValue::as_dict)
        .ok_or(DhtError::MissingField("a"))?;
    let id = parse_node_id(dict_bytes(args, b"id").ok_or(DhtError::MissingField("a.id"))?)?;

    let query = match query_name {
        b"ping" => DhtQuery::Ping { id },
        b"find_node" => DhtQuery::FindNode {
            id,
            target: parse_node_id(
                dict_bytes(args, b"target").ok_or(DhtError::MissingField("a.target"))?,
            )?,
        },
        b"get_peers" => DhtQuery::GetPeers {
            id,
            info_hash: parse_info_hash(
                dict_bytes(args, b"info_hash")
                    .ok_or(DhtError::MissingField("a.info_hash"))?,
            )?,
        },
        b"announce_peer" => {
            let info_hash = parse_info_hash(
                dict_bytes(args, b"info_hash")
                    .ok_or(DhtError::MissingField("a.info_hash"))?,
            )?;
            let implied_port = dict_int(args, b"implied_port").unwrap_or(0) != 0;
            let port = dict_int(args, b"port")
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(0);
            if port == 0 && !implied_port {
                return Err(DhtError::InvalidPort);
            }
            let token = dict_bytes(args, b"token")
                .ok_or(DhtError::MissingField("a.token"))?
                .to_vec();
            if token.is_empty() || token.len() > MAX_DHT_TOKEN_BYTES {
                return Err(DhtError::InvalidTokenLength(token.len()));
            }
            DhtQuery::AnnouncePeer {
                id,
                info_hash,
                port,
                token,
                implied_port,
            }
        }
        _ => return Err(DhtError::UnsupportedQuery),
    };

    Ok(DhtMessage::Query {
        transaction_id,
        query,
    })
}

fn parse_response(
    root: &BTreeMap<&[u8], BValue<'_>>,
    transaction_id: Vec<u8>,
) -> Result<DhtMessage, DhtError> {
    let response = dict_get(root, b"r")
        .and_then(BValue::as_dict)
        .ok_or(DhtError::MissingField("r"))?;
    let id = parse_node_id(dict_bytes(response, b"id").ok_or(DhtError::MissingField("r.id"))?)?;

    let mut nodes = Vec::new();
    if let Some(bytes) = dict_bytes(response, b"nodes") {
        parse_nodes_v4(bytes, &mut nodes)?;
    }
    if let Some(bytes) = dict_bytes(response, b"nodes6") {
        parse_nodes_v6(bytes, &mut nodes)?;
    }
    nodes.sort_by_key(|node| node.address);
    nodes.dedup_by_key(|node| node.address);
    nodes.truncate(MAX_DHT_NODES);

    let mut peers = Vec::new();
    if let Some(values) = dict_get(response, b"values").and_then(BValue::as_list) {
        if values.len() > MAX_DHT_PEERS {
            return Err(DhtError::TooManyPeers(values.len()));
        }
        for value in values {
            let Some(bytes) = value.as_bytes() else {
                continue;
            };
            match bytes.len() {
                6 => {
                    let port = u16::from_be_bytes([bytes[4], bytes[5]]);
                    if port != 0 {
                        peers.push(SocketAddr::new(
                            IpAddr::V4(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3])),
                            port,
                        ));
                    }
                }
                18 => {
                    let mut octets = [0u8; 16];
                    octets.copy_from_slice(&bytes[..16]);
                    let port = u16::from_be_bytes([bytes[16], bytes[17]]);
                    if port != 0 {
                        peers.push(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(octets)), port));
                    }
                }
                _ => return Err(DhtError::InvalidCompactPeers),
            }
        }
    }
    peers.sort_unstable();
    peers.dedup();
    peers.truncate(MAX_DHT_PEERS);

    let token = dict_bytes(response, b"token").map(|token| token.to_vec());
    if token
        .as_ref()
        .is_some_and(|token| token.is_empty() || token.len() > MAX_DHT_TOKEN_BYTES)
    {
        return Err(DhtError::InvalidTokenLength(
            token.as_ref().map_or(0, Vec::len),
        ));
    }

    Ok(DhtMessage::Response {
        transaction_id,
        response: DhtResponse {
            id,
            token,
            nodes,
            peers,
        },
    })
}

fn parse_error(
    root: &BTreeMap<&[u8], BValue<'_>>,
    transaction_id: Vec<u8>,
) -> Result<DhtMessage, DhtError> {
    let values = dict_get(root, b"e")
        .and_then(BValue::as_list)
        .ok_or(DhtError::MissingField("e"))?;
    if values.len() != 2 {
        return Err(DhtError::InvalidErrorResponse);
    }
    let code = values[0]
        .as_int()
        .ok_or(DhtError::InvalidErrorResponse)?;
    let raw = values[1]
        .as_bytes()
        .ok_or(DhtError::InvalidErrorResponse)?;
    let message = String::from_utf8_lossy(&raw[..raw.len().min(256)]).into_owned();
    Ok(DhtMessage::Error {
        transaction_id,
        code,
        message,
    })
}

fn parse_node_id(bytes: &[u8]) -> Result<DhtNodeId, DhtError> {
    if bytes.len() != 20 {
        return Err(DhtError::InvalidNodeIdLength(bytes.len()));
    }
    let mut id = [0u8; 20];
    id.copy_from_slice(bytes);
    Ok(DhtNodeId::new(id))
}

fn parse_info_hash(bytes: &[u8]) -> Result<InfoHash, DhtError> {
    if bytes.len() != 20 {
        return Err(DhtError::InvalidInfoHashLength(bytes.len()));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(bytes);
    Ok(InfoHash::new(hash))
}

fn parse_nodes_v4(bytes: &[u8], output: &mut Vec<DhtNode>) -> Result<(), DhtError> {
    if bytes.len() % 26 != 0 {
        return Err(DhtError::InvalidCompactNodes("IPv4"));
    }
    if bytes.len() / 26 > MAX_DHT_NODES {
        return Err(DhtError::TooManyNodes(bytes.len() / 26));
    }
    for chunk in bytes.chunks_exact(26) {
        let id = parse_node_id(&chunk[..20])?;
        let port = u16::from_be_bytes([chunk[24], chunk[25]]);
        if port == 0 {
            continue;
        }
        output.push(DhtNode {
            id,
            address: SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(chunk[20], chunk[21], chunk[22], chunk[23])),
                port,
            ),
        });
    }
    Ok(())
}

fn parse_nodes_v6(bytes: &[u8], output: &mut Vec<DhtNode>) -> Result<(), DhtError> {
    if bytes.len() % 38 != 0 {
        return Err(DhtError::InvalidCompactNodes("IPv6"));
    }
    if bytes.len() / 38 > MAX_DHT_NODES {
        return Err(DhtError::TooManyNodes(bytes.len() / 38));
    }
    for chunk in bytes.chunks_exact(38) {
        let id = parse_node_id(&chunk[..20])?;
        let mut octets = [0u8; 16];
        octets.copy_from_slice(&chunk[20..36]);
        let port = u16::from_be_bytes([chunk[36], chunk[37]]);
        if port == 0 {
            continue;
        }
        output.push(DhtNode {
            id,
            address: SocketAddr::new(IpAddr::V6(Ipv6Addr::from(octets)), port),
        });
    }
    Ok(())
}

fn encode_nodes_v4(nodes: &[DhtNode]) -> Vec<u8> {
    let mut out = Vec::new();
    for node in nodes {
        let SocketAddr::V4(address) = node.address else {
            continue;
        };
        out.extend_from_slice(node.id.as_bytes());
        out.extend_from_slice(&address.ip().octets());
        out.extend_from_slice(&address.port().to_be_bytes());
    }
    out
}

fn encode_nodes_v6(nodes: &[DhtNode]) -> Vec<u8> {
    let mut out = Vec::new();
    for node in nodes {
        let SocketAddr::V6(address) = node.address else {
            continue;
        };
        out.extend_from_slice(node.id.as_bytes());
        out.extend_from_slice(&address.ip().octets());
        out.extend_from_slice(&address.port().to_be_bytes());
    }
    out
}

fn validate_transaction(transaction_id: &[u8]) -> Result<(), DhtError> {
    if transaction_id.is_empty() || transaction_id.len() > MAX_DHT_TRANSACTION_BYTES {
        Err(DhtError::InvalidTransactionLength(transaction_id.len()))
    } else {
        Ok(())
    }
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
    List(Vec<BValue<'a>>),
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

    fn as_list(&self) -> Option<&[BValue<'a>]> {
        match self {
            Self::List(value) => Some(value),
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
        .find_map(|(entry_key, value)| (**entry_key == *key).then_some(value))
}

fn dict_bytes<'a>(
    dictionary: &BTreeMap<&'a [u8], BValue<'a>>,
    key: &[u8],
) -> Option<&'a [u8]> {
    dict_get(dictionary, key).and_then(BValue::as_bytes)
}

fn dict_int(dictionary: &BTreeMap<&[u8], BValue<'_>>, key: &[u8]) -> Option<i64> {
    dict_get(dictionary, key).and_then(BValue::as_int)
}

struct Parser<'a> {
    input: &'a [u8],
    position: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a [u8]) -> Self {
        Self { input, position: 0 }
    }

    fn parse_value(&mut self, depth: usize) -> Result<BValue<'a>, DhtError> {
        if depth > MAX_DHT_BENCODE_DEPTH {
            return Err(DhtError::InvalidBencode(
                "maximum DHT bencode depth exceeded".to_owned(),
            ));
        }
        match self.input.get(self.position).copied() {
            Some(b'i') => self.parse_int().map(BValue::Int),
            Some(b'l') => self.parse_list(depth).map(BValue::List),
            Some(b'd') => self.parse_dict(depth).map(BValue::Dict),
            Some(byte) if byte.is_ascii_digit() => self.parse_bytes().map(BValue::Bytes),
            Some(byte) => Err(DhtError::InvalidBencode(format!(
                "unexpected byte 0x{byte:02x}"
            ))),
            None => Err(DhtError::InvalidBencode(
                "unexpected end of DHT packet".to_owned(),
            )),
        }
    }

    fn parse_int(&mut self) -> Result<i64, DhtError> {
        self.expect(b'i')?;
        let start = self.position;
        while self.input.get(self.position).copied() != Some(b'e') {
            if self.position >= self.input.len() {
                return Err(DhtError::InvalidBencode(
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
            return Err(DhtError::InvalidBencode(
                "non-canonical integer".to_owned(),
            ));
        }
        std::str::from_utf8(raw)
            .ok()
            .and_then(|text| text.parse::<i64>().ok())
            .ok_or_else(|| DhtError::InvalidBencode("invalid integer".to_owned()))
    }

    fn parse_bytes(&mut self) -> Result<&'a [u8], DhtError> {
        let start = self.position;
        while let Some(byte) = self.input.get(self.position).copied() {
            if byte == b':' {
                break;
            }
            if !byte.is_ascii_digit() {
                return Err(DhtError::InvalidBencode(
                    "invalid byte-string length".to_owned(),
                ));
            }
            self.position += 1;
        }
        let digits = &self.input[start..self.position];
        self.expect(b':')?;
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
            return Err(DhtError::InvalidBencode(
                "non-canonical byte-string length".to_owned(),
            ));
        }
        let length = std::str::from_utf8(digits)
            .ok()
            .and_then(|text| text.parse::<usize>().ok())
            .ok_or_else(|| DhtError::InvalidBencode("byte-string length overflow".to_owned()))?;
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| DhtError::InvalidBencode("byte-string overflow".to_owned()))?;
        let value = self
            .input
            .get(self.position..end)
            .ok_or_else(|| DhtError::InvalidBencode("truncated byte string".to_owned()))?;
        self.position = end;
        Ok(value)
    }

    fn parse_list(&mut self, depth: usize) -> Result<Vec<BValue<'a>>, DhtError> {
        self.expect(b'l')?;
        let mut values = Vec::new();
        while self.input.get(self.position).copied() != Some(b'e') {
            if values.len() >= MAX_DHT_PEERS.max(MAX_DHT_NODES) {
                return Err(DhtError::InvalidBencode("DHT list too large".to_owned()));
            }
            values.push(self.parse_value(depth + 1)?);
        }
        self.expect(b'e')?;
        Ok(values)
    }

    fn parse_dict(
        &mut self,
        depth: usize,
    ) -> Result<BTreeMap<&'a [u8], BValue<'a>>, DhtError> {
        self.expect(b'd')?;
        let mut entries = BTreeMap::new();
        let mut previous: Option<&[u8]> = None;
        while self.input.get(self.position).copied() != Some(b'e') {
            if entries.len() >= 128 {
                return Err(DhtError::InvalidBencode(
                    "DHT dictionary too large".to_owned(),
                ));
            }
            let key = self.parse_bytes()?;
            if previous.is_some_and(|previous| previous >= key) {
                return Err(DhtError::InvalidBencode(
                    "DHT dictionary keys must be strictly sorted".to_owned(),
                ));
            }
            previous = Some(key);
            let value = self.parse_value(depth + 1)?;
            entries.insert(key, value);
        }
        self.expect(b'e')?;
        Ok(entries)
    }

    fn expect(&mut self, expected: u8) -> Result<(), DhtError> {
        match self.input.get(self.position).copied() {
            Some(actual) if actual == expected => {
                self.position += 1;
                Ok(())
            }
            Some(actual) => Err(DhtError::InvalidBencode(format!(
                "expected 0x{expected:02x}, got 0x{actual:02x}"
            ))),
            None => Err(DhtError::InvalidBencode(
                "unexpected end of DHT packet".to_owned(),
            )),
        }
    }

    fn finish(&self) -> Result<(), DhtError> {
        if self.position == self.input.len() {
            Ok(())
        } else {
            Err(DhtError::InvalidBencode(
                "trailing bytes after DHT packet".to_owned(),
            ))
        }
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum DhtError {
    #[error("DHT packet exceeds UDP safety limit: {0} bytes")]
    PacketTooLarge(usize),
    #[error("invalid DHT bencode: {0}")]
    InvalidBencode(String),
    #[error("DHT packet is missing field {0}")]
    MissingField(&'static str),
    #[error("invalid DHT message type")]
    InvalidMessageType,
    #[error("unsupported DHT query")]
    UnsupportedQuery,
    #[error("invalid DHT transaction id length: {0}")]
    InvalidTransactionLength(usize),
    #[error("invalid DHT node id length: {0}")]
    InvalidNodeIdLength(usize),
    #[error("invalid DHT info hash length: {0}")]
    InvalidInfoHashLength(usize),
    #[error("invalid DHT token length: {0}")]
    InvalidTokenLength(usize),
    #[error("invalid DHT announce port")]
    InvalidPort,
    #[error("invalid compact DHT nodes for {0}")]
    InvalidCompactNodes(&'static str),
    #[error("invalid compact DHT peer value")]
    InvalidCompactPeers,
    #[error("DHT response contains too many nodes: {0}")]
    TooManyNodes(usize),
    #[error("DHT response contains too many peers: {0}")]
    TooManyPeers(usize),
    #[error("invalid DHT error response")]
    InvalidErrorResponse,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node_id(byte: u8) -> DhtNodeId {
        DhtNodeId::new([byte; 20])
    }

    #[test]
    fn get_peers_query_round_trip() {
        let message = DhtMessage::Query {
            transaction_id: vec![1, 2],
            query: DhtQuery::GetPeers {
                id: node_id(7),
                info_hash: InfoHash::new([9u8; 20]),
            },
        };
        let encoded = message.encode().expect("encode");
        assert_eq!(DhtMessage::parse(&encoded).expect("parse"), message);
    }

    #[test]
    fn response_round_trip_with_ipv4_ipv6_nodes_and_peers() {
        let message = DhtMessage::Response {
            transaction_id: b"aa".to_vec(),
            response: DhtResponse {
                id: node_id(1),
                token: Some(vec![4, 5, 6]),
                nodes: vec![
                    DhtNode {
                        id: node_id(2),
                        address: "1.2.3.4:6881".parse().unwrap(),
                    },
                    DhtNode {
                        id: node_id(3),
                        address: "[2001:db8::1]:6882".parse().unwrap(),
                    },
                ],
                peers: vec![
                    "8.8.8.8:51413".parse().unwrap(),
                    "[2001:4860:4860::8888]:51413".parse().unwrap(),
                ],
            },
        };

        let encoded = message.encode().expect("encode response");
        let parsed = DhtMessage::parse(&encoded).expect("parse response");
        assert_eq!(parsed, message);
    }

    #[test]
    fn announce_peer_round_trip() {
        let message = DhtMessage::Query {
            transaction_id: vec![9, 9],
            query: DhtQuery::AnnouncePeer {
                id: node_id(4),
                info_hash: InfoHash::new([5u8; 20]),
                port: 6881,
                token: vec![1, 2, 3, 4],
                implied_port: false,
            },
        };
        let encoded = message.encode().expect("encode announce");
        assert_eq!(DhtMessage::parse(&encoded).expect("parse announce"), message);
    }

    #[test]
    fn rejects_invalid_compact_node_length() {
        let bytes = b"d1:rd2:id20:123456789012345678905:nodes1:xe1:t2:aa1:y1:re";
        assert!(matches!(
            DhtMessage::parse(bytes),
            Err(DhtError::InvalidCompactNodes("IPv4"))
        ));
    }

    #[test]
    fn xor_distance_is_deterministic() {
        let id = DhtNodeId::new([0xff; 20]);
        assert_eq!(id.xor_distance(InfoHash::new([0x0f; 20])), [0xf0; 20]);
    }
}
