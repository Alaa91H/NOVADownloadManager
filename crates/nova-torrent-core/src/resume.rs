use crate::{FilePriority, InfoHash, TorrentMetainfo, TorrentSelection};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const RESUME_FORMAT_VERSION: u32 = 1;
const RESUME_MAGIC: &str = "NOVA-TORRENT-RESUME-1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PieceBitmap {
    piece_count: usize,
    bytes: Vec<u8>,
}

impl PieceBitmap {
    pub fn new(piece_count: usize) -> Self {
        Self {
            piece_count,
            bytes: vec![0; piece_count.div_ceil(8)],
        }
    }

    pub fn from_bytes(piece_count: usize, bytes: Vec<u8>) -> Result<Self, ResumeError> {
        let expected = piece_count.div_ceil(8);
        if bytes.len() != expected {
            return Err(ResumeError::BitmapLengthMismatch {
                expected,
                actual: bytes.len(),
            });
        }
        if piece_count != 0 && !bytes.is_empty() {
            let used_bits = piece_count % 8;
            if used_bits != 0 {
                let unused_mask = (1u8 << (8 - used_bits)) - 1;
                if bytes[bytes.len() - 1] & unused_mask != 0 {
                    return Err(ResumeError::BitmapPaddingSet);
                }
            }
        }
        Ok(Self { piece_count, bytes })
    }

    pub const fn piece_count(&self) -> usize {
        self.piece_count
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn is_set(&self, index: usize) -> Result<bool, ResumeError> {
        self.validate(index)?;
        let byte = self.bytes[index / 8];
        Ok(byte & (0x80 >> (index % 8)) != 0)
    }

    pub fn set(&mut self, index: usize, value: bool) -> Result<(), ResumeError> {
        self.validate(index)?;
        let byte = &mut self.bytes[index / 8];
        let mask = 0x80 >> (index % 8);
        if value {
            *byte |= mask;
        } else {
            *byte &= !mask;
        }
        Ok(())
    }

    pub fn count_set(&self) -> usize {
        (0..self.piece_count)
            .filter(|index| self.is_set(*index).unwrap_or(false))
            .count()
    }

    pub fn to_bools(&self) -> Vec<bool> {
        (0..self.piece_count)
            .map(|index| self.is_set(index).unwrap_or(false))
            .collect()
    }

    fn validate(&self, index: usize) -> Result<(), ResumeError> {
        if index >= self.piece_count {
            Err(ResumeError::PieceOutOfRange {
                index,
                count: self.piece_count,
            })
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TorrentResumeCheckpoint {
    pub version: u32,
    pub info_hash: InfoHash,
    pub total_length: u64,
    pub piece_length: u64,
    pub piece_count: usize,
    pub file_count: usize,
    pub generation: u64,
    pub priorities: Vec<FilePriority>,
    pub owned_files: PieceBitmap,
    pub verified: PieceBitmap,
    pub boundary_cache: PieceBitmap,
}

impl TorrentResumeCheckpoint {
    pub fn new(
        meta: &TorrentMetainfo,
        selection: &TorrentSelection,
    ) -> Result<Self, ResumeError> {
        if selection.priorities().len() != meta.files.len() {
            return Err(ResumeError::FileCountMismatch {
                expected: meta.files.len(),
                actual: selection.priorities().len(),
            });
        }
        Ok(Self {
            version: RESUME_FORMAT_VERSION,
            info_hash: meta.info_hash,
            total_length: meta.total_length,
            piece_length: meta.piece_length,
            piece_count: meta.piece_count(),
            file_count: meta.files.len(),
            generation: 0,
            priorities: selection.priorities().to_vec(),
            owned_files: PieceBitmap::new(meta.files.len()),
            verified: PieceBitmap::new(meta.piece_count()),
            boundary_cache: PieceBitmap::new(meta.piece_count()),
        })
    }

    pub fn validate_against(&self, meta: &TorrentMetainfo) -> Result<(), ResumeError> {
        if self.version != RESUME_FORMAT_VERSION {
            return Err(ResumeError::UnsupportedVersion(self.version));
        }
        if self.info_hash != meta.info_hash {
            return Err(ResumeError::InfoHashMismatch);
        }
        if self.total_length != meta.total_length
            || self.piece_length != meta.piece_length
            || self.piece_count != meta.piece_count()
        {
            return Err(ResumeError::GeometryMismatch);
        }
        if self.file_count != meta.files.len() || self.priorities.len() != meta.files.len() {
            return Err(ResumeError::FileCountMismatch {
                expected: meta.files.len(),
                actual: self.priorities.len(),
            });
        }
        if self.owned_files.piece_count() != meta.files.len()
            || self.verified.piece_count() != meta.piece_count()
            || self.boundary_cache.piece_count() != meta.piece_count()
        {
            return Err(ResumeError::GeometryMismatch);
        }
        Ok(())
    }

    pub fn selection(&self, meta: &TorrentMetainfo) -> Result<TorrentSelection, ResumeError> {
        self.validate_against(meta)?;
        TorrentSelection::new(meta, self.priorities.clone())
            .map_err(|error| ResumeError::InvalidSelection(error.to_string()))
    }

    pub fn next_generation(&mut self) -> Result<u64, ResumeError> {
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or(ResumeError::GenerationOverflow)?;
        Ok(self.generation)
    }

    pub fn encode(&self) -> String {
        let priorities = self
            .priorities
            .iter()
            .map(|priority| match priority {
                FilePriority::Skip => '0',
                FilePriority::Normal => '1',
                FilePriority::High => '2',
            })
            .collect::<String>();

        format!(
            "{RESUME_MAGIC}\nversion={}\ninfo_hash={}\ntotal_length={}\npiece_length={}\npiece_count={}\nfile_count={}\ngeneration={}\npriorities={}\nowned_files={}\nverified={}\nboundary_cache={}\n",
            self.version,
            self.info_hash.to_hex(),
            self.total_length,
            self.piece_length,
            self.piece_count,
            self.file_count,
            self.generation,
            priorities,
            encode_hex(self.owned_files.as_bytes()),
            encode_hex(self.verified.as_bytes()),
            encode_hex(self.boundary_cache.as_bytes()),
        )
    }

    pub fn parse(input: &str, meta: &TorrentMetainfo) -> Result<Self, ResumeError> {
        let mut lines = input.lines();
        if lines.next() != Some(RESUME_MAGIC) {
            return Err(ResumeError::InvalidFormat("invalid resume magic".to_owned()));
        }

        let mut fields = BTreeMap::<&str, &str>::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            let (key, value) = line
                .split_once('=')
                .ok_or_else(|| ResumeError::InvalidFormat(format!("invalid resume line '{line}'")))?;
            if fields.insert(key, value).is_some() {
                return Err(ResumeError::InvalidFormat(format!(
                    "duplicate resume field '{key}'"
                )));
            }
        }

        let version = parse_field::<u32>(&fields, "version")?;
        if version != RESUME_FORMAT_VERSION {
            return Err(ResumeError::UnsupportedVersion(version));
        }
        let info_hash = decode_info_hash(required(&fields, "info_hash")?)?;
        let total_length = parse_field::<u64>(&fields, "total_length")?;
        let piece_length = parse_field::<u64>(&fields, "piece_length")?;
        let piece_count = parse_field::<usize>(&fields, "piece_count")?;
        let file_count = parse_field::<usize>(&fields, "file_count")?;
        let generation = parse_field::<u64>(&fields, "generation")?;

        let priorities_raw = required(&fields, "priorities")?;
        let mut priorities = Vec::with_capacity(priorities_raw.len());
        for value in priorities_raw.bytes() {
            priorities.push(match value {
                b'0' => FilePriority::Skip,
                b'1' => FilePriority::Normal,
                b'2' => FilePriority::High,
                _ => {
                    return Err(ResumeError::InvalidFormat(
                        "invalid file priority encoding".to_owned(),
                    ))
                }
            });
        }

        let owned_files = PieceBitmap::from_bytes(
            file_count,
            decode_hex(required(&fields, "owned_files")?)?,
        )?;
        let verified = PieceBitmap::from_bytes(
            piece_count,
            decode_hex(required(&fields, "verified")?)?,
        )?;
        let boundary_cache = PieceBitmap::from_bytes(
            piece_count,
            decode_hex(required(&fields, "boundary_cache")?)?,
        )?;

        let checkpoint = Self {
            version,
            info_hash,
            total_length,
            piece_length,
            piece_count,
            file_count,
            generation,
            priorities,
            owned_files,
            verified,
            boundary_cache,
        };
        checkpoint.validate_against(meta)?;
        Ok(checkpoint)
    }
}

pub fn load_checkpoint_recovering(
    path: &Path,
    meta: &TorrentMetainfo,
) -> Result<Option<TorrentResumeCheckpoint>, ResumeError> {
    let candidates = [
        path.to_path_buf(),
        append_suffix(path, ".tmp"),
        append_suffix(path, ".bak"),
    ];
    let mut first_error = None;

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        match std::fs::read_to_string(&candidate)
            .map_err(|error| ResumeError::Io(candidate.clone(), error.to_string()))
            .and_then(|payload| TorrentResumeCheckpoint::parse(&payload, meta))
        {
            Ok(checkpoint) => return Ok(Some(checkpoint)),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    if let Some(error) = first_error {
        Err(error)
    } else {
        Ok(None)
    }
}

pub fn save_checkpoint_atomic(
    path: &Path,
    checkpoint: &TorrentResumeCheckpoint,
) -> Result<(), ResumeError> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| ResumeError::Io(parent.to_path_buf(), error.to_string()))?;
    }

    let tmp = append_suffix(path, ".tmp");
    let backup = append_suffix(path, ".bak");
    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|error| ResumeError::Io(tmp.clone(), error.to_string()))?;
        file.write_all(checkpoint.encode().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| ResumeError::Io(tmp.clone(), error.to_string()))?;
    }

    if let Err(first_error) = std::fs::rename(&tmp, path) {
        if !path.exists() {
            let _ = std::fs::remove_file(&tmp);
            return Err(ResumeError::Io(path.to_path_buf(), first_error.to_string()));
        }

        let _ = std::fs::remove_file(&backup);
        std::fs::rename(path, &backup)
            .map_err(|error| ResumeError::Io(backup.clone(), error.to_string()))?;
        if let Err(replace_error) = std::fs::rename(&tmp, path) {
            let _ = std::fs::rename(&backup, path);
            let _ = std::fs::remove_file(&tmp);
            return Err(ResumeError::Io(
                path.to_path_buf(),
                replace_error.to_string(),
            ));
        }
        let _ = std::fs::remove_file(&backup);
    }

    sync_parent(path);
    Ok(())
}

fn required<'a>(
    fields: &'a BTreeMap<&str, &str>,
    key: &'static str,
) -> Result<&'a str, ResumeError> {
    fields
        .get(key)
        .copied()
        .ok_or(ResumeError::MissingField(key))
}

fn parse_field<T>(
    fields: &BTreeMap<&str, &str>,
    key: &'static str,
) -> Result<T, ResumeError>
where
    T: std::str::FromStr,
{
    required(fields, key)?
        .parse()
        .map_err(|_| ResumeError::InvalidField(key))
}

fn decode_info_hash(value: &str) -> Result<InfoHash, ResumeError> {
    let bytes = decode_hex(value)?;
    if bytes.len() != 20 {
        return Err(ResumeError::InvalidField("info_hash"));
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&bytes);
    Ok(InfoHash::new(hash))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ResumeError> {
    if value.len() % 2 != 0 {
        return Err(ResumeError::InvalidFormat(
            "hex field has odd length".to_owned(),
        ));
    }
    let mut output = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let high = hex_nibble(pair[0]).ok_or_else(|| {
            ResumeError::InvalidFormat("hex field contains invalid character".to_owned())
        })?;
        let low = hex_nibble(pair[1]).ok_or_else(|| {
            ResumeError::InvalidFormat("hex field contains invalid character".to_owned())
        })?;
        output.push((high << 4) | low);
    }
    Ok(output)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn sync_parent(path: &Path) {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum ResumeError {
    #[error("unsupported torrent resume version {0}")]
    UnsupportedVersion(u32),
    #[error("torrent resume info hash does not match metainfo")]
    InfoHashMismatch,
    #[error("torrent resume geometry does not match metainfo")]
    GeometryMismatch,
    #[error("torrent resume file count mismatch: expected {expected}, got {actual}")]
    FileCountMismatch { expected: usize, actual: usize },
    #[error("torrent resume bitmap length mismatch: expected {expected}, got {actual}")]
    BitmapLengthMismatch { expected: usize, actual: usize },
    #[error("torrent resume bitmap has non-zero padding bits")]
    BitmapPaddingSet,
    #[error("torrent resume piece {index} is outside piece count {count}")]
    PieceOutOfRange { index: usize, count: usize },
    #[error("torrent resume generation overflow")]
    GenerationOverflow,
    #[error("torrent resume is missing field {0}")]
    MissingField(&'static str),
    #[error("torrent resume field {0} is invalid")]
    InvalidField(&'static str),
    #[error("invalid torrent resume format: {0}")]
    InvalidFormat(String),
    #[error("invalid torrent selection in resume state: {0}")]
    InvalidSelection(String),
    #[error("torrent resume I/O error at {0}: {1}")]
    Io(PathBuf, String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TorrentFile, TorrentMetainfo};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn meta() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([0xabu8; 20]),
            name: "resume".to_owned(),
            piece_length: 4,
            piece_hashes: vec![[1u8; 20], [2u8; 20], [3u8; 20]],
            files: vec![
                TorrentFile {
                    path: "resume/a.bin".to_owned(),
                    length: 4,
                    offset: 0,
                },
                TorrentFile {
                    path: "resume/b.bin".to_owned(),
                    length: 5,
                    offset: 4,
                },
            ],
            total_length: 9,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private: false,
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "nova-torrent-resume-{}-{stamp}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn bitmap_round_trip_and_padding_validation() {
        let mut bitmap = PieceBitmap::new(9);
        bitmap.set(0, true).unwrap();
        bitmap.set(8, true).unwrap();
        assert!(bitmap.is_set(0).unwrap());
        assert!(bitmap.is_set(8).unwrap());
        assert_eq!(bitmap.count_set(), 2);
        assert_eq!(
            PieceBitmap::from_bytes(9, vec![0, 0x01]),
            Err(ResumeError::BitmapPaddingSet)
        );
    }

    #[test]
    fn checkpoint_text_round_trip_preserves_generation_and_priorities() {
        let meta = meta();
        let selection = TorrentSelection::new(
            &meta,
            vec![FilePriority::High, FilePriority::Skip],
        )
        .unwrap();
        let mut checkpoint = TorrentResumeCheckpoint::new(&meta, &selection).unwrap();
        checkpoint.next_generation().unwrap();
        checkpoint.owned_files.set(0, true).unwrap();
        checkpoint.verified.set(1, true).unwrap();
        checkpoint.boundary_cache.set(1, true).unwrap();

        let parsed = TorrentResumeCheckpoint::parse(&checkpoint.encode(), &meta).unwrap();
        assert_eq!(parsed, checkpoint);
    }

    #[test]
    fn atomic_checkpoint_recovers_from_backup_candidate() {
        let meta = meta();
        let selection = TorrentSelection::all(&meta);
        let checkpoint = TorrentResumeCheckpoint::new(&meta, &selection).unwrap();
        let dir = temp_path("atomic");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("resume.state");
        save_checkpoint_atomic(&path, &checkpoint).unwrap();

        std::fs::write(&path, "corrupt").unwrap();
        std::fs::write(append_suffix(&path, ".bak"), checkpoint.encode()).unwrap();
        let loaded = load_checkpoint_recovering(&path, &meta)
            .unwrap()
            .expect("checkpoint");
        assert_eq!(loaded, checkpoint);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn checkpoint_rejects_wrong_torrent_identity() {
        let meta = meta();
        let selection = TorrentSelection::all(&meta);
        let checkpoint = TorrentResumeCheckpoint::new(&meta, &selection).unwrap();
        let mut other = meta.clone();
        other.info_hash = InfoHash::new([7u8; 20]);
        assert_eq!(
            TorrentResumeCheckpoint::parse(&checkpoint.encode(), &other),
            Err(ResumeError::InfoHashMismatch)
        );
    }
}
