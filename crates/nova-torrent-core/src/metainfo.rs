use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fmt;
use std::ops::Range;
use url::Url;

pub const MAX_METAINFO_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PIECE_LENGTH_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BENCODE_DEPTH: usize = 64;
const MAX_CONTAINER_ITEMS: usize = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct InfoHash([u8; 20]);

impl InfoHash {
    pub const fn new(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(40);
        for byte in self.0 {
            output.push(HEX[(byte >> 4) as usize] as char);
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
        output
    }
}

impl fmt::Display for InfoHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_hex())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TorrentFile {
    /// Safe, normalized relative path using '/' separators.
    pub path: String,
    pub length: u64,
    /// Absolute byte offset in the torrent payload.
    pub offset: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FileSlice {
    pub file_index: usize,
    pub file_offset: u64,
    pub data_offset: u64,
    pub length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TorrentMetainfo {
    pub info_hash: InfoHash,
    pub name: String,
    pub piece_length: u64,
    pub piece_hashes: Vec<[u8; 20]>,
    pub files: Vec<TorrentFile>,
    pub total_length: u64,
    pub trackers: Vec<String>,
    #[serde(default)]
    pub tracker_tiers: Vec<Vec<String>>,
    pub private: bool,
}

impl TorrentMetainfo {
    pub fn parse(bytes: &[u8]) -> Result<Self, TorrentMetainfoError> {
        if bytes.is_empty() {
            return Err(TorrentMetainfoError::InvalidBencode(
                "metainfo is empty".to_owned(),
            ));
        }
        if bytes.len() > MAX_METAINFO_BYTES {
            return Err(TorrentMetainfoError::TooLarge {
                actual: bytes.len(),
                limit: MAX_METAINFO_BYTES,
            });
        }

        let (root, info_range) = Parser::new(bytes).parse_top_level()?;
        let root = root
            .as_dict()
            .ok_or_else(|| TorrentMetainfoError::InvalidField {
                field: "root",
                message: "top-level metainfo must be a dictionary".to_owned(),
            })?;
        let info = dict_get(root, b"info")
            .and_then(BValue::as_dict)
            .ok_or(TorrentMetainfoError::MissingField("info"))?;

        if let Some(version) = dict_get(info, b"meta version").and_then(BValue::as_int) {
            if version != 1 {
                return Err(TorrentMetainfoError::UnsupportedMetaVersion(version));
            }
        }

        let raw_info = bytes
            .get(info_range)
            .ok_or_else(|| TorrentMetainfoError::InvalidBencode("invalid info span".to_owned()))?;
        let digest = Sha1::digest(raw_info);
        let mut hash = [0u8; 20];
        hash.copy_from_slice(&digest);
        let info_hash = InfoHash::new(hash);

        let name = decode_component(
            dict_get(info, b"name")
                .and_then(BValue::as_bytes)
                .ok_or(TorrentMetainfoError::MissingField("info.name"))?,
            "info.name",
        )?;

        let piece_length_i64 = dict_get(info, b"piece length")
            .and_then(BValue::as_int)
            .ok_or(TorrentMetainfoError::MissingField("info.piece length"))?;
        let piece_length =
            u64::try_from(piece_length_i64).map_err(|_| TorrentMetainfoError::InvalidField {
                field: "info.piece length",
                message: "piece length must be positive".to_owned(),
            })?;
        if piece_length == 0 {
            return Err(TorrentMetainfoError::InvalidField {
                field: "info.piece length",
                message: "piece length must be greater than zero".to_owned(),
            });
        }
        if piece_length > MAX_PIECE_LENGTH_BYTES {
            return Err(TorrentMetainfoError::InvalidField {
                field: "info.piece length",
                message: format!(
                    "piece length exceeds {} byte safety limit",
                    MAX_PIECE_LENGTH_BYTES
                ),
            });
        }

        let piece_bytes = dict_get(info, b"pieces")
            .and_then(BValue::as_bytes)
            .ok_or(TorrentMetainfoError::MissingField("info.pieces"))?;
        if piece_bytes.is_empty() || piece_bytes.len() % 20 != 0 {
            return Err(TorrentMetainfoError::InvalidField {
                field: "info.pieces",
                message: "piece hash blob must contain one or more 20-byte SHA-1 hashes".to_owned(),
            });
        }
        let piece_hashes = piece_bytes
            .chunks_exact(20)
            .map(|chunk| {
                let mut hash = [0u8; 20];
                hash.copy_from_slice(chunk);
                hash
            })
            .collect::<Vec<_>>();

        let (files, total_length) = parse_files(info, &name)?;
        validate_output_paths(&files)?;
        if total_length == 0 {
            return Err(TorrentMetainfoError::InvalidField {
                field: "info.length/info.files",
                message: "torrent payload must contain at least one byte".to_owned(),
            });
        }

        let expected_piece_count = total_length
            .checked_add(piece_length - 1)
            .ok_or(TorrentMetainfoError::LengthOverflow)?
            / piece_length;
        if piece_hashes.len() as u64 != expected_piece_count {
            return Err(TorrentMetainfoError::PieceCountMismatch {
                expected: expected_piece_count,
                actual: piece_hashes.len(),
            });
        }

        let (trackers, tracker_tiers) = parse_trackers(root)?;
        let private = match dict_get(info, b"private").and_then(BValue::as_int) {
            None | Some(0) => false,
            Some(1) => true,
            Some(value) => {
                return Err(TorrentMetainfoError::InvalidField {
                    field: "info.private",
                    message: format!("expected 0 or 1, got {value}"),
                })
            }
        };

        Ok(Self {
            info_hash,
            name,
            piece_length,
            piece_hashes,
            files,
            total_length,
            trackers,
            tracker_tiers,
            private,
        })
    }

    /// Parse an exact raw v1 `info` dictionary obtained through BEP 9.
    ///
    /// The raw bytes are embedded without re-encoding so the info hash remains
    /// identical to the magnet BTIH. Tracker URLs are added only to the outer
    /// metainfo dictionary and therefore cannot affect the info hash.
    pub fn from_info_bytes(
        info_bytes: &[u8],
        trackers: &[String],
    ) -> Result<Self, TorrentMetainfoError> {
        if info_bytes.is_empty() {
            return Err(TorrentMetainfoError::InvalidBencode(
                "metadata info dictionary is empty".to_owned(),
            ));
        }

        let mut bytes = Vec::with_capacity(
            info_bytes
                .len()
                .saturating_add(trackers.iter().map(String::len).sum::<usize>())
                .saturating_add(128),
        );
        bytes.push(b'd');

        if let Some(first) = trackers.first() {
            bytes.extend_from_slice(b"8:announce");
            append_bencoded_bytes(&mut bytes, first.as_bytes());

            bytes.extend_from_slice(b"13:announce-listll");
            for tracker in trackers {
                append_bencoded_bytes(&mut bytes, tracker.as_bytes());
            }
            bytes.extend_from_slice(b"ee");
        }

        bytes.extend_from_slice(b"4:info");
        bytes.extend_from_slice(info_bytes);
        bytes.push(b'e');

        Self::parse(&bytes)
    }

    pub fn piece_count(&self) -> usize {
        self.piece_hashes.len()
    }

    pub fn piece_size(&self, index: usize) -> Option<u64> {
        if index >= self.piece_count() {
            return None;
        }
        let start = (index as u64).checked_mul(self.piece_length)?;
        Some(self.total_length.saturating_sub(start).min(self.piece_length))
    }

    /// Verify one completed piece against the SHA-1 digest from the metainfo.
    ///
    /// The byte length is checked before hashing so truncated or overlong peer
    /// responses cannot accidentally be accepted as a valid piece.
    pub fn verify_piece(
        &self,
        index: usize,
        bytes: &[u8],
    ) -> Result<bool, TorrentMetainfoError> {
        let expected_hash = self
            .piece_hashes
            .get(index)
            .ok_or(TorrentMetainfoError::PieceOutOfRange {
                index,
                count: self.piece_hashes.len(),
            })?;
        let expected_length = self
            .piece_size(index)
            .ok_or(TorrentMetainfoError::PieceOutOfRange {
                index,
                count: self.piece_hashes.len(),
            })?;
        if bytes.len() as u64 != expected_length {
            return Err(TorrentMetainfoError::PieceLengthMismatch {
                index,
                expected: expected_length,
                actual: bytes.len(),
            });
        }

        let digest = Sha1::digest(bytes);
        let mut actual_hash = [0u8; 20];
        actual_hash.copy_from_slice(&digest);
        Ok(&actual_hash == expected_hash)
    }

    /// Map a contiguous payload range onto one or more physical torrent files.
    ///
    /// This is the boundary used by the future peer transfer worker so a piece
    /// that crosses file boundaries can be written without unsafe path logic.
    pub fn map_range(
        &self,
        data_offset: u64,
        length: u64,
    ) -> Result<Vec<FileSlice>, TorrentMetainfoError> {
        if length == 0 {
            return Ok(Vec::new());
        }
        let end = data_offset
            .checked_add(length)
            .ok_or(TorrentMetainfoError::LengthOverflow)?;
        if data_offset >= self.total_length || end > self.total_length {
            return Err(TorrentMetainfoError::RangeOutsidePayload {
                offset: data_offset,
                length,
                total: self.total_length,
            });
        }

        let mut slices = Vec::new();
        let mut cursor = data_offset;
        let mut remaining = length;

        for (file_index, file) in self.files.iter().enumerate() {
            if remaining == 0 {
                break;
            }
            let file_end = file
                .offset
                .checked_add(file.length)
                .ok_or(TorrentMetainfoError::LengthOverflow)?;
            if cursor >= file_end || cursor < file.offset {
                continue;
            }

            let file_offset = cursor - file.offset;
            let available = file.length - file_offset;
            let take = remaining.min(available);
            if take > 0 {
                slices.push(FileSlice {
                    file_index,
                    file_offset,
                    data_offset: cursor,
                    length: take,
                });
                cursor += take;
                remaining -= take;
            }
        }

        if remaining != 0 {
            return Err(TorrentMetainfoError::RangeOutsidePayload {
                offset: data_offset,
                length,
                total: self.total_length,
            });
        }
        Ok(slices)
    }
}

fn append_bencoded_bytes(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(bytes.len().to_string().as_bytes());
    output.push(b':');
    output.extend_from_slice(bytes);
}

fn parse_files(
    info: &[(&[u8], BValue<'_>)],
    name: &str,
) -> Result<(Vec<TorrentFile>, u64), TorrentMetainfoError> {
    let single_length = dict_get(info, b"length").and_then(BValue::as_int);
    let multi_files = dict_get(info, b"files").and_then(BValue::as_list);

    match (single_length, multi_files) {
        (Some(length), None) => {
            let length =
                u64::try_from(length).map_err(|_| TorrentMetainfoError::InvalidField {
                    field: "info.length",
                    message: "file length cannot be negative".to_owned(),
                })?;
            Ok((
                vec![TorrentFile {
                    path: name.to_owned(),
                    length,
                    offset: 0,
                }],
                length,
            ))
        }
        (None, Some(files)) => {
            if files.is_empty() {
                return Err(TorrentMetainfoError::InvalidField {
                    field: "info.files",
                    message: "multi-file torrent must contain at least one file".to_owned(),
                });
            }

            let mut parsed = Vec::with_capacity(files.len());
            let mut offset = 0u64;
            for value in files {
                let file =
                    value
                        .as_dict()
                        .ok_or_else(|| TorrentMetainfoError::InvalidField {
                            field: "info.files[]",
                            message: "file entry must be a dictionary".to_owned(),
                        })?;
                let length_i64 = dict_get(file, b"length")
                    .and_then(BValue::as_int)
                    .ok_or(TorrentMetainfoError::MissingField("info.files[].length"))?;
                let length = u64::try_from(length_i64).map_err(|_| {
                    TorrentMetainfoError::InvalidField {
                        field: "info.files[].length",
                        message: "file length cannot be negative".to_owned(),
                    }
                })?;
                let path_values = dict_get(file, b"path")
                    .and_then(BValue::as_list)
                    .ok_or(TorrentMetainfoError::MissingField("info.files[].path"))?;
                if path_values.is_empty() {
                    return Err(TorrentMetainfoError::UnsafePath(
                        "file path cannot be empty".to_owned(),
                    ));
                }

                let mut components = Vec::with_capacity(path_values.len() + 1);
                components.push(name.to_owned());
                for component in path_values {
                    components.push(decode_component(
                        component
                            .as_bytes()
                            .ok_or_else(|| TorrentMetainfoError::InvalidField {
                                field: "info.files[].path[]",
                                message: "path component must be a byte string".to_owned(),
                            })?,
                        "info.files[].path[]",
                    )?);
                }
                let path = components.join("/");
                parsed.push(TorrentFile {
                    path,
                    length,
                    offset,
                });
                offset = offset
                    .checked_add(length)
                    .ok_or(TorrentMetainfoError::LengthOverflow)?;
            }
            Ok((parsed, offset))
        }
        (Some(_), Some(_)) => Err(TorrentMetainfoError::InvalidField {
            field: "info",
            message: "torrent cannot contain both length and files".to_owned(),
        }),
        (None, None) => Err(TorrentMetainfoError::MissingField(
            "info.length or info.files",
        )),
    }
}

fn decode_component(bytes: &[u8], field: &'static str) -> Result<String, TorrentMetainfoError> {
    let value = std::str::from_utf8(bytes).map_err(|_| TorrentMetainfoError::InvalidField {
        field,
        message: "path/name must be valid UTF-8".to_owned(),
    })?;
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('/')
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(|character| character == '\0' || character.is_control())
        || value.ends_with(' ')
        || value.ends_with('.')
        || is_windows_reserved_component(value)
    {
        return Err(TorrentMetainfoError::UnsafePath(value.to_owned()));
    }
    Ok(value.to_owned())
}

fn is_windows_reserved_component(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn validate_output_paths(files: &[TorrentFile]) -> Result<(), TorrentMetainfoError> {
    let mut paths = files
        .iter()
        .map(|file| file.path.to_lowercase())
        .collect::<Vec<_>>();
    paths.sort();

    for pair in paths.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        if current == previous
            || current
                .strip_prefix(previous)
                .is_some_and(|suffix| suffix.starts_with('/'))
        {
            return Err(TorrentMetainfoError::UnsafePath(format!(
                "colliding torrent output paths: {previous} and {current}"
            )));
        }
    }
    Ok(())
}

fn parse_trackers(
    root: &[(&[u8], BValue<'_>)],
) -> Result<(Vec<String>, Vec<Vec<String>>), TorrentMetainfoError> {
    let announce = dict_get(root, b"announce")
        .and_then(BValue::as_bytes)
        .map(parse_tracker_url)
        .transpose()?;

    let mut tiers = Vec::<Vec<String>>::new();
    if let Some(raw_tiers) = dict_get(root, b"announce-list").and_then(BValue::as_list) {
        for raw_tier in raw_tiers {
            let mut tier = Vec::new();
            match raw_tier {
                BValue::List(values) => {
                    for value in values {
                        if let Some(bytes) = value.as_bytes() {
                            let tracker = parse_tracker_url(bytes)?;
                            if !tier.iter().any(|existing| existing == &tracker) {
                                tier.push(tracker);
                            }
                        }
                    }
                }
                BValue::Bytes(bytes) => {
                    tier.push(parse_tracker_url(bytes)?);
                }
                _ => {}
            }
            if !tier.is_empty() {
                tiers.push(tier);
            }
        }
    }

    if let Some(announce) = announce {
        let already_present = tiers
            .iter()
            .flatten()
            .any(|tracker| tracker == &announce);
        if tiers.is_empty() {
            tiers.push(vec![announce]);
        } else if !already_present {
            tiers.insert(0, vec![announce]);
        }
    }

    let mut trackers = Vec::new();
    for tracker in tiers.iter().flatten() {
        if !trackers.iter().any(|existing| existing == tracker) {
            trackers.push(tracker.clone());
        }
    }

    Ok((trackers, tiers))
}

fn parse_tracker_url(raw: &[u8]) -> Result<String, TorrentMetainfoError> {
    let tracker =
        std::str::from_utf8(raw).map_err(|_| TorrentMetainfoError::InvalidField {
            field: "announce",
            message: "tracker URL must be valid UTF-8".to_owned(),
        })?;
    let parsed =
        Url::parse(tracker).map_err(|_| TorrentMetainfoError::InvalidTracker(tracker.to_owned()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "udp") || parsed.host_str().is_none() {
        return Err(TorrentMetainfoError::InvalidTracker(tracker.to_owned()));
    }
    Ok(tracker.to_owned())
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum TorrentMetainfoError {
    #[error("torrent metainfo exceeds limit: {actual} bytes > {limit} bytes")]
    TooLarge { actual: usize, limit: usize },
    #[error("invalid bencode: {0}")]
    InvalidBencode(String),
    #[error("missing torrent field: {0}")]
    MissingField(&'static str),
    #[error("invalid torrent field {field}: {message}")]
    InvalidField {
        field: &'static str,
        message: String,
    },
    #[error("unsupported torrent meta version: {0}")]
    UnsupportedMetaVersion(i64),
    #[error("unsafe torrent path component: {0}")]
    UnsafePath(String),
    #[error("invalid tracker URL: {0}")]
    InvalidTracker(String),
    #[error("torrent payload length overflow")]
    LengthOverflow,
    #[error("torrent piece count mismatch: expected {expected}, got {actual}")]
    PieceCountMismatch { expected: u64, actual: usize },
    #[error("torrent piece index {index} is outside piece count {count}")]
    PieceOutOfRange { index: usize, count: usize },
    #[error("torrent piece {index} has invalid length: expected {expected}, got {actual}")]
    PieceLengthMismatch {
        index: usize,
        expected: u64,
        actual: usize,
    },
    #[error("torrent range {offset}+{length} exceeds payload length {total}")]
    RangeOutsidePayload {
        offset: u64,
        length: u64,
        total: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BValue<'a> {
    Int(i64),
    Bytes(&'a [u8]),
    List(Vec<BValue<'a>>),
    Dict(Vec<(&'a [u8], BValue<'a>)>),
}

impl<'a> BValue<'a> {
    fn as_int(&self) -> Option<i64> {
        if let Self::Int(value) = self {
            Some(*value)
        } else {
            None
        }
    }

    fn as_bytes(&self) -> Option<&'a [u8]> {
        if let Self::Bytes(value) = self {
            Some(*value)
        } else {
            None
        }
    }

    fn as_list(&self) -> Option<&[BValue<'a>]> {
        if let Self::List(value) = self {
            Some(value)
        } else {
            None
        }
    }

    fn as_dict(&self) -> Option<&[(&'a [u8], BValue<'a>)]> {
        if let Self::Dict(value) = self {
            Some(value)
        } else {
            None
        }
    }
}

fn dict_get<'a, 'b>(
    dictionary: &'b [(&'a [u8], BValue<'a>)],
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

    fn parse_top_level(
        mut self,
    ) -> Result<(BValue<'a>, Range<usize>), TorrentMetainfoError> {
        if self.take_byte() != Some(b'd') {
            return Err(TorrentMetainfoError::InvalidBencode(
                "top-level value must be a dictionary".to_owned(),
            ));
        }

        let mut entries = Vec::new();
        let mut previous_key: Option<&[u8]> = None;
        let mut info_range = None;

        while self.peek_byte() != Some(b'e') {
            if entries.len() >= MAX_CONTAINER_ITEMS {
                return Err(TorrentMetainfoError::InvalidBencode(
                    "dictionary contains too many entries".to_owned(),
                ));
            }
            let key = self.parse_bytes()?;
            validate_dictionary_key_order(previous_key, key)?;
            previous_key = Some(key);

            let start = self.position;
            let value = self.parse_value(1)?;
            let end = self.position;
            if key == b"info" {
                if info_range.is_some() {
                    return Err(TorrentMetainfoError::InvalidBencode(
                        "duplicate info dictionary".to_owned(),
                    ));
                }
                info_range = Some(start..end);
            }
            entries.push((key, value));
        }
        self.expect_byte(b'e')?;
        if self.position != self.input.len() {
            return Err(TorrentMetainfoError::InvalidBencode(
                "trailing data after top-level dictionary".to_owned(),
            ));
        }

        Ok((
            BValue::Dict(entries),
            info_range.ok_or(TorrentMetainfoError::MissingField("info"))?,
        ))
    }

    fn parse_value(&mut self, depth: usize) -> Result<BValue<'a>, TorrentMetainfoError> {
        if depth > MAX_BENCODE_DEPTH {
            return Err(TorrentMetainfoError::InvalidBencode(
                "maximum bencode nesting depth exceeded".to_owned(),
            ));
        }
        match self.peek_byte() {
            Some(b'i') => self.parse_int().map(BValue::Int),
            Some(b'l') => self.parse_list(depth).map(BValue::List),
            Some(b'd') => self.parse_dict(depth).map(BValue::Dict),
            Some(byte) if byte.is_ascii_digit() => self.parse_bytes().map(BValue::Bytes),
            Some(byte) => Err(TorrentMetainfoError::InvalidBencode(format!(
                "unexpected byte 0x{byte:02x} at offset {}",
                self.position
            ))),
            None => Err(TorrentMetainfoError::InvalidBencode(
                "unexpected end of input".to_owned(),
            )),
        }
    }

    fn parse_int(&mut self) -> Result<i64, TorrentMetainfoError> {
        self.expect_byte(b'i')?;
        let start = self.position;
        while let Some(byte) = self.peek_byte() {
            if byte == b'e' {
                break;
            }
            self.position += 1;
        }
        let end = self.position;
        self.expect_byte(b'e')?;
        let raw = self
            .input
            .get(start..end)
            .ok_or_else(|| TorrentMetainfoError::InvalidBencode("invalid integer".to_owned()))?;
        if raw.is_empty()
            || raw == b"-0"
            || (raw.len() > 1 && raw[0] == b'0')
            || (raw.len() > 2 && raw[0] == b'-' && raw[1] == b'0')
        {
            return Err(TorrentMetainfoError::InvalidBencode(
                "non-canonical bencode integer".to_owned(),
            ));
        }
        let text = std::str::from_utf8(raw)
            .map_err(|_| TorrentMetainfoError::InvalidBencode("invalid integer bytes".to_owned()))?;
        text.parse::<i64>()
            .map_err(|_| TorrentMetainfoError::InvalidBencode("integer overflow".to_owned()))
    }

    fn parse_bytes(&mut self) -> Result<&'a [u8], TorrentMetainfoError> {
        let start = self.position;
        while let Some(byte) = self.peek_byte() {
            if byte == b':' {
                break;
            }
            if !byte.is_ascii_digit() {
                return Err(TorrentMetainfoError::InvalidBencode(
                    "byte string length contains a non-digit".to_owned(),
                ));
            }
            self.position += 1;
        }
        let digits_end = self.position;
        self.expect_byte(b':')?;
        let digits = self.input.get(start..digits_end).ok_or_else(|| {
            TorrentMetainfoError::InvalidBencode("invalid byte string length".to_owned())
        })?;
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
            return Err(TorrentMetainfoError::InvalidBencode(
                "non-canonical byte string length".to_owned(),
            ));
        }
        let length_text = std::str::from_utf8(digits).map_err(|_| {
            TorrentMetainfoError::InvalidBencode("invalid byte string length".to_owned())
        })?;
        let length = length_text.parse::<usize>().map_err(|_| {
            TorrentMetainfoError::InvalidBencode("byte string length overflow".to_owned())
        })?;
        let end = self.position.checked_add(length).ok_or_else(|| {
            TorrentMetainfoError::InvalidBencode("byte string length overflow".to_owned())
        })?;
        let value = self.input.get(self.position..end).ok_or_else(|| {
            TorrentMetainfoError::InvalidBencode("truncated byte string".to_owned())
        })?;
        self.position = end;
        Ok(value)
    }

    fn parse_list(&mut self, depth: usize) -> Result<Vec<BValue<'a>>, TorrentMetainfoError> {
        self.expect_byte(b'l')?;
        let mut values = Vec::new();
        while self.peek_byte() != Some(b'e') {
            if values.len() >= MAX_CONTAINER_ITEMS {
                return Err(TorrentMetainfoError::InvalidBencode(
                    "list contains too many entries".to_owned(),
                ));
            }
            values.push(self.parse_value(depth + 1)?);
        }
        self.expect_byte(b'e')?;
        Ok(values)
    }

    fn parse_dict(
        &mut self,
        depth: usize,
    ) -> Result<Vec<(&'a [u8], BValue<'a>)>, TorrentMetainfoError> {
        self.expect_byte(b'd')?;
        let mut entries = Vec::new();
        let mut previous_key: Option<&[u8]> = None;
        while self.peek_byte() != Some(b'e') {
            if entries.len() >= MAX_CONTAINER_ITEMS {
                return Err(TorrentMetainfoError::InvalidBencode(
                    "dictionary contains too many entries".to_owned(),
                ));
            }
            let key = self.parse_bytes()?;
            validate_dictionary_key_order(previous_key, key)?;
            previous_key = Some(key);
            let value = self.parse_value(depth + 1)?;
            entries.push((key, value));
        }
        self.expect_byte(b'e')?;
        Ok(entries)
    }

    fn peek_byte(&self) -> Option<u8> {
        self.input.get(self.position).copied()
    }

    fn take_byte(&mut self) -> Option<u8> {
        let byte = self.peek_byte()?;
        self.position += 1;
        Some(byte)
    }

    fn expect_byte(&mut self, expected: u8) -> Result<(), TorrentMetainfoError> {
        match self.take_byte() {
            Some(actual) if actual == expected => Ok(()),
            Some(actual) => Err(TorrentMetainfoError::InvalidBencode(format!(
                "expected 0x{expected:02x}, got 0x{actual:02x} at offset {}",
                self.position.saturating_sub(1)
            ))),
            None => Err(TorrentMetainfoError::InvalidBencode(
                "unexpected end of input".to_owned(),
            )),
        }
    }
}

fn validate_dictionary_key_order(
    previous: Option<&[u8]>,
    current: &[u8],
) -> Result<(), TorrentMetainfoError> {
    if previous.is_some_and(|previous| previous >= current) {
        return Err(TorrentMetainfoError::InvalidBencode(
            "dictionary keys must be strictly sorted".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single_file_torrent() -> Vec<u8> {
        // info = d6:lengthi5e4:name8:file.bin12:piece lengthi4e6:pieces40:<2 hashes>e
        let mut bytes = b"d8:announce26:https://tracker.test/a.php4:info".to_vec();
        bytes.extend_from_slice(b"d6:lengthi5e4:name8:file.bin12:piece lengthi4e6:pieces40:");
        bytes.extend_from_slice(&[1u8; 20]);
        bytes.extend_from_slice(&[2u8; 20]);
        bytes.extend_from_slice(b"ee");
        bytes
    }

    #[test]
    fn parses_exact_bep9_info_dictionary_with_magnet_trackers() {
        let mut info = b"d6:lengthi5e4:name8:file.bin12:piece lengthi4e6:pieces40:".to_vec();
        info.extend_from_slice(&[1u8; 20]);
        info.extend_from_slice(&[2u8; 20]);
        info.push(b'e');

        let torrent = TorrentMetainfo::from_info_bytes(
            &info,
            &[
                "https://tracker-a.test/announce".to_owned(),
                "udp://tracker-b.test:6969/announce".to_owned(),
            ],
        )
        .expect("parse BEP9 info");

        let digest = Sha1::digest(&info);
        let mut expected = [0u8; 20];
        expected.copy_from_slice(&digest);
        assert_eq!(torrent.info_hash.as_bytes(), &expected);
        assert_eq!(torrent.trackers.len(), 2);
        assert_eq!(torrent.total_length, 5);
    }

    #[test]
    fn parses_single_file_metainfo_and_maps_cross_piece_ranges() {
        let torrent = TorrentMetainfo::parse(&single_file_torrent()).expect("parse torrent");
        assert_eq!(torrent.name, "file.bin");
        assert_eq!(torrent.total_length, 5);
        assert_eq!(torrent.piece_length, 4);
        assert_eq!(torrent.piece_count(), 2);
        assert_eq!(torrent.piece_size(0), Some(4));
        assert_eq!(torrent.piece_size(1), Some(1));
        assert_eq!(torrent.trackers, vec!["https://tracker.test/a.php"]);
        assert_eq!(
            torrent.tracker_tiers,
            vec![vec!["https://tracker.test/a.php".to_owned()]]
        );
        assert_eq!(
            torrent.map_range(1, 4).expect("map range"),
            vec![FileSlice {
                file_index: 0,
                file_offset: 1,
                data_offset: 1,
                length: 4,
            }]
        );
    }

    #[test]
    fn preserves_announce_list_tiers_for_failover() {
        let mut bytes = b"d8:announce22:https://primary.test/a13:announce-listll21:https://tier-a.test/a21:https://tier-b.test/ael32:udp://tracker.test:6969/announceee4:info".to_vec();
        bytes.extend_from_slice(b"d6:lengthi1e4:name1:x12:piece lengthi1e6:pieces20:");
        bytes.extend_from_slice(&[3u8; 20]);
        bytes.extend_from_slice(b"ee");

        let torrent = TorrentMetainfo::parse(&bytes).expect("parse tiered torrent");
        assert_eq!(torrent.tracker_tiers.len(), 3);
        assert_eq!(
            torrent.tracker_tiers[0],
            vec!["https://primary.test/a".to_owned()]
        );
        assert_eq!(torrent.tracker_tiers[1].len(), 2);
        assert_eq!(
            torrent.tracker_tiers[2],
            vec!["udp://tracker.test:6969/announce".to_owned()]
        );
    }

    #[test]
    fn rejects_path_traversal_in_multifile_torrent() {
        let mut bytes = b"d4:infod5:filesld6:lengthi1e4:pathl2:..1:xeee4:name4:root12:piece lengthi1e6:pieces20:".to_vec();
        bytes.extend_from_slice(&[7u8; 20]);
        bytes.extend_from_slice(b"ee");
        let error = TorrentMetainfo::parse(&bytes).expect_err("unsafe path must fail");
        assert!(matches!(error, TorrentMetainfoError::UnsafePath(_)));
    }

    #[test]
    fn rejects_windows_reserved_device_name() {
        let mut bytes =
            b"d4:infod6:lengthi1e4:name3:CON12:piece lengthi1e6:pieces20:".to_vec();
        bytes.extend_from_slice(&[7u8; 20]);
        bytes.extend_from_slice(b"ee");
        assert!(matches!(
            TorrentMetainfo::parse(&bytes),
            Err(TorrentMetainfoError::UnsafePath(_))
        ));
    }

    #[test]
    fn rejects_case_insensitive_and_parent_file_collisions() {
        let duplicate = vec![
            TorrentFile {
                path: "root/A.bin".to_owned(),
                length: 1,
                offset: 0,
            },
            TorrentFile {
                path: "root/a.BIN".to_owned(),
                length: 1,
                offset: 1,
            },
        ];
        assert!(matches!(
            validate_output_paths(&duplicate),
            Err(TorrentMetainfoError::UnsafePath(_))
        ));

        let parent_collision = vec![
            TorrentFile {
                path: "root/a".to_owned(),
                length: 1,
                offset: 0,
            },
            TorrentFile {
                path: "root/a/b.bin".to_owned(),
                length: 1,
                offset: 1,
            },
        ];
        assert!(matches!(
            validate_output_paths(&parent_collision),
            Err(TorrentMetainfoError::UnsafePath(_))
        ));
    }

    #[test]
    fn rejects_excessive_piece_length() {
        let bytes = format!(
            "d4:infod6:lengthi1e4:name1:x12:piece lengthi{}e6:pieces20:",
            MAX_PIECE_LENGTH_BYTES + 1
        );
        let mut torrent = bytes.into_bytes();
        torrent.extend_from_slice(&[9u8; 20]);
        torrent.extend_from_slice(b"ee");
        assert!(matches!(
            TorrentMetainfo::parse(&torrent),
            Err(TorrentMetainfoError::InvalidField {
                field: "info.piece length",
                ..
            })
        ));
    }

    #[test]
    fn rejects_piece_count_mismatch() {
        let mut bytes = b"d4:infod6:lengthi9e4:name1:x12:piece lengthi4e6:pieces20:".to_vec();
        bytes.extend_from_slice(&[9u8; 20]);
        bytes.extend_from_slice(b"ee");
        assert_eq!(
            TorrentMetainfo::parse(&bytes).expect_err("piece mismatch"),
            TorrentMetainfoError::PieceCountMismatch {
                expected: 3,
                actual: 1,
            }
        );
    }

    #[test]
    fn verifies_piece_digest_and_length() {
        let torrent = TorrentMetainfo::parse(&single_file_torrent()).expect("parse torrent");
        assert!(!torrent.verify_piece(0, &[0, 0, 0, 0]).expect("verify"));
        assert!(matches!(
            torrent.verify_piece(1, &[0, 0]),
            Err(TorrentMetainfoError::PieceLengthMismatch { .. })
        ));
    }

    #[test]
    fn info_hash_is_computed_from_exact_raw_info_bytes() {
        let bytes = single_file_torrent();
        let torrent = TorrentMetainfo::parse(&bytes).expect("parse torrent");
        let marker = b"4:info";
        let marker_pos = bytes
            .windows(marker.len())
            .position(|window| window == marker)
            .expect("info marker");
        let info_start = marker_pos + marker.len();
        let info_end = bytes.len() - 1;
        let digest = Sha1::digest(&bytes[info_start..info_end]);
        let mut expected = [0u8; 20];
        expected.copy_from_slice(&digest);
        assert_eq!(torrent.info_hash.as_bytes(), &expected);
    }
}
