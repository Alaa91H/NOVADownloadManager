use crate::{InfoHash, TorrentFile, TorrentMetainfo, MAX_PIECE_LENGTH_BYTES};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const STORAGE_MANIFEST_VERSION: u32 = 1;
const MANIFEST_MAGIC: &[u8] = b"NOVA-TORRENT-MANIFEST-1";
const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_MANIFEST_STRING_BYTES: usize = 64 * 1024;
const MAX_MANIFEST_FILES: usize = 1_000_000;
const MAX_MANIFEST_PIECES: usize = 4_000_000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TorrentStorageManifest {
    pub metainfo: TorrentMetainfo,
    /// Discovery endpoints are deliberately excluded from the storage
    /// manifest because private trackers frequently embed passkeys.
    pub had_trackers: bool,
}

impl TorrentStorageManifest {
    pub fn from_metainfo(meta: &TorrentMetainfo) -> Self {
        let mut persisted = meta.clone();
        let had_trackers = !persisted.trackers.is_empty() || !persisted.tracker_tiers.is_empty();
        persisted.trackers.clear();
        persisted.tracker_tiers.clear();
        Self {
            metainfo: persisted,
            had_trackers,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ManifestError> {
        validate_metainfo(&self.metainfo)?;
        let mut output = Vec::new();
        output.extend_from_slice(MANIFEST_MAGIC);
        put_u32(&mut output, STORAGE_MANIFEST_VERSION);
        output.extend_from_slice(self.metainfo.info_hash.as_bytes());
        put_u64(&mut output, self.metainfo.piece_length);
        put_u64(&mut output, self.metainfo.total_length);

        let mut flags = 0u8;
        if self.metainfo.private {
            flags |= 0x01;
        }
        if self.had_trackers {
            flags |= 0x02;
        }
        output.push(flags);
        put_string(&mut output, &self.metainfo.name)?;

        let piece_count = u32::try_from(self.metainfo.piece_hashes.len())
            .map_err(|_| ManifestError::TooManyPieces(self.metainfo.piece_hashes.len()))?;
        put_u32(&mut output, piece_count);
        for hash in &self.metainfo.piece_hashes {
            output.extend_from_slice(hash);
        }

        let file_count = u32::try_from(self.metainfo.files.len())
            .map_err(|_| ManifestError::TooManyFiles(self.metainfo.files.len()))?;
        put_u32(&mut output, file_count);
        for file in &self.metainfo.files {
            put_u64(&mut output, file.length);
            put_u64(&mut output, file.offset);
            put_string(&mut output, &file.path)?;
        }

        if output.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge(output.len()));
        }
        Ok(output)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge(bytes.len()));
        }
        let mut cursor = Cursor::new(bytes);
        cursor.expect(MANIFEST_MAGIC)?;
        let version = cursor.u32()?;
        if version != STORAGE_MANIFEST_VERSION {
            return Err(ManifestError::UnsupportedVersion(version));
        }

        let info_hash = {
            let raw = cursor.take(20)?;
            let mut hash = [0u8; 20];
            hash.copy_from_slice(raw);
            InfoHash::new(hash)
        };
        let piece_length = cursor.u64()?;
        let total_length = cursor.u64()?;
        let flags = cursor.byte()?;
        if flags & !0x03 != 0 {
            return Err(ManifestError::InvalidFlags(flags));
        }
        let private = flags & 0x01 != 0;
        let had_trackers = flags & 0x02 != 0;
        let name = cursor.string()?;

        let piece_count = cursor.u32()? as usize;
        if piece_count == 0 || piece_count > MAX_MANIFEST_PIECES {
            return Err(ManifestError::TooManyPieces(piece_count));
        }
        let mut piece_hashes = Vec::with_capacity(piece_count);
        for _ in 0..piece_count {
            let raw = cursor.take(20)?;
            let mut hash = [0u8; 20];
            hash.copy_from_slice(raw);
            piece_hashes.push(hash);
        }

        let file_count = cursor.u32()? as usize;
        if file_count == 0 || file_count > MAX_MANIFEST_FILES {
            return Err(ManifestError::TooManyFiles(file_count));
        }
        let mut files = Vec::with_capacity(file_count);
        for _ in 0..file_count {
            let length = cursor.u64()?;
            let offset = cursor.u64()?;
            let path = cursor.string()?;
            validate_relative_path(&path)?;
            files.push(TorrentFile {
                path,
                length,
                offset,
            });
        }
        cursor.finish()?;

        let metainfo = TorrentMetainfo {
            info_hash,
            name,
            piece_length,
            piece_hashes,
            files,
            total_length,
            trackers: Vec::new(),
            tracker_tiers: Vec::new(),
            private,
        };
        validate_metainfo(&metainfo)?;
        Ok(Self {
            metainfo,
            had_trackers,
        })
    }
}

pub fn load_storage_manifest(path: &Path) -> Result<TorrentStorageManifest, ManifestError> {
    let bytes = std::fs::read(path)
        .map_err(|error| ManifestError::Io(path.to_path_buf(), error.to_string()))?;
    TorrentStorageManifest::parse(&bytes)
}

pub fn load_storage_manifest_recovering(
    path: &Path,
) -> Result<TorrentStorageManifest, ManifestError> {
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
        match load_storage_manifest(&candidate) {
            Ok(manifest) => return Ok(manifest),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    Err(first_error.unwrap_or_else(|| {
        ManifestError::Io(path.to_path_buf(), "storage manifest is missing".to_owned())
    }))
}

pub fn save_storage_manifest_atomic(
    path: &Path,
    manifest: &TorrentStorageManifest,
) -> Result<(), ManifestError> {
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|error| ManifestError::Io(parent.to_path_buf(), error.to_string()))?;
    }
    let payload = manifest.encode()?;
    let tmp = append_suffix(path, ".tmp");
    let backup = append_suffix(path, ".bak");

    {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|error| ManifestError::Io(tmp.clone(), error.to_string()))?;
        file.write_all(&payload)
            .and_then(|_| file.sync_all())
            .map_err(|error| ManifestError::Io(tmp.clone(), error.to_string()))?;
    }

    if let Err(first_error) = std::fs::rename(&tmp, path) {
        if !path.exists() {
            let _ = std::fs::remove_file(&tmp);
            return Err(ManifestError::Io(path.to_path_buf(), first_error.to_string()));
        }
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(path, &backup)
            .map_err(|error| ManifestError::Io(backup.clone(), error.to_string()))?;
        if let Err(error) = std::fs::rename(&tmp, path) {
            let _ = std::fs::rename(&backup, path);
            let _ = std::fs::remove_file(&tmp);
            return Err(ManifestError::Io(path.to_path_buf(), error.to_string()));
        }
        let _ = std::fs::remove_file(&backup);
    }

    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn validate_metainfo(meta: &TorrentMetainfo) -> Result<(), ManifestError> {
    if meta.name.is_empty()
        || meta.name.chars().any(|value| value == '\0' || value.is_control())
        || meta.name.contains('/')
        || meta.name.contains('\\')
    {
        return Err(ManifestError::UnsafeName(meta.name.clone()));
    }
    if meta.total_length == 0 {
        return Err(ManifestError::InvalidGeometry);
    }
    if meta.piece_length == 0 || meta.piece_length > MAX_PIECE_LENGTH_BYTES {
        return Err(ManifestError::InvalidGeometry);
    }
    let expected = meta
        .total_length
        .checked_add(meta.piece_length - 1)
        .ok_or(ManifestError::InvalidGeometry)?
        / meta.piece_length;
    if expected as usize != meta.piece_hashes.len()
        || meta.piece_hashes.is_empty()
        || meta.piece_hashes.len() > MAX_MANIFEST_PIECES
    {
        return Err(ManifestError::InvalidGeometry);
    }
    if meta.files.is_empty() || meta.files.len() > MAX_MANIFEST_FILES {
        return Err(ManifestError::InvalidGeometry);
    }

    let mut expected_offset = 0u64;
    let mut normalized_paths = Vec::with_capacity(meta.files.len());
    for file in &meta.files {
        validate_relative_path(&file.path)?;
        normalized_paths.push(file.path.to_lowercase());
        if file.offset != expected_offset {
            return Err(ManifestError::InvalidGeometry);
        }
        expected_offset = expected_offset
            .checked_add(file.length)
            .ok_or(ManifestError::InvalidGeometry)?;
    }
    if expected_offset != meta.total_length {
        return Err(ManifestError::InvalidGeometry);
    }

    normalized_paths.sort();
    for pair in normalized_paths.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        if current == previous
            || current
                .strip_prefix(previous)
                .is_some_and(|suffix| suffix.starts_with('/'))
        {
            return Err(ManifestError::UnsafePath(format!(
                "colliding manifest output paths: {previous} and {current}"
            )));
        }
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), ManifestError> {
    if path.is_empty() || path.len() > MAX_MANIFEST_STRING_BYTES {
        return Err(ManifestError::UnsafePath(path.to_owned()));
    }
    let value = Path::new(path);
    if value.is_absolute() {
        return Err(ManifestError::UnsafePath(path.to_owned()));
    }
    let mut count = 0usize;
    for component in value.components() {
        let Component::Normal(component) = component else {
            return Err(ManifestError::UnsafePath(path.to_owned()));
        };
        let component = component
            .to_str()
            .ok_or_else(|| ManifestError::UnsafePath(path.to_owned()))?;
        if component.is_empty()
            || component == "."
            || component == ".."
            || is_windows_reserved_component(component)
            || component.contains(':')
            || component.contains('/')
            || component.contains('\\')
            || component.ends_with(' ')
            || component.ends_with('.')
            || component
                .chars()
                .any(|character| character == '\0' || character.is_control())
        {
            return Err(ManifestError::UnsafePath(path.to_owned()));
        }
        count += 1;
        if count > 1024 {
            return Err(ManifestError::UnsafePath(path.to_owned()));
        }
    }
    if count == 0 {
        return Err(ManifestError::UnsafePath(path.to_owned()));
    }
    Ok(())
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

fn put_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn put_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn put_string(output: &mut Vec<u8>, value: &str) -> Result<(), ManifestError> {
    if value.len() > MAX_MANIFEST_STRING_BYTES {
        return Err(ManifestError::StringTooLarge(value.len()));
    }
    let length = u32::try_from(value.len()).map_err(|_| ManifestError::StringTooLarge(value.len()))?;
    put_u32(output, length);
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn expect(&mut self, expected: &[u8]) -> Result<(), ManifestError> {
        let actual = self.take(expected.len())?;
        if actual == expected {
            Ok(())
        } else {
            Err(ManifestError::InvalidMagic)
        }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ManifestError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(ManifestError::Truncated)?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or(ManifestError::Truncated)?;
        self.position = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, ManifestError> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, ManifestError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| ManifestError::Truncated)?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, ManifestError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| ManifestError::Truncated)?;
        Ok(u64::from_be_bytes(bytes))
    }

    fn string(&mut self) -> Result<String, ManifestError> {
        let length = self.u32()? as usize;
        if length > MAX_MANIFEST_STRING_BYTES {
            return Err(ManifestError::StringTooLarge(length));
        }
        let bytes = self.take(length)?;
        let value = std::str::from_utf8(bytes).map_err(|_| ManifestError::InvalidUtf8)?;
        Ok(value.to_owned())
    }

    fn finish(&self) -> Result<(), ManifestError> {
        if self.position == self.bytes.len() {
            Ok(())
        } else {
            Err(ManifestError::TrailingBytes)
        }
    }
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum ManifestError {
    #[error("unsupported torrent storage manifest version {0}")]
    UnsupportedVersion(u32),
    #[error("torrent storage manifest exceeds safe size: {0} bytes")]
    TooLarge(usize),
    #[error("torrent storage manifest contains too many files: {0}")]
    TooManyFiles(usize),
    #[error("torrent storage manifest contains too many pieces: {0}")]
    TooManyPieces(usize),
    #[error("torrent storage manifest string exceeds safe size: {0} bytes")]
    StringTooLarge(usize),
    #[error("torrent storage manifest has invalid magic")]
    InvalidMagic,
    #[error("torrent storage manifest is truncated")]
    Truncated,
    #[error("torrent storage manifest has trailing bytes")]
    TrailingBytes,
    #[error("torrent storage manifest has invalid UTF-8")]
    InvalidUtf8,
    #[error("torrent storage manifest has invalid flags 0x{0:02x}")]
    InvalidFlags(u8),
    #[error("torrent storage manifest geometry is invalid")]
    InvalidGeometry,
    #[error("torrent storage manifest contains unsafe torrent name: {0}")]
    UnsafeName(String),
    #[error("torrent storage manifest contains unsafe path: {0}")]
    UnsafePath(String),
    #[error("torrent storage manifest I/O error at {0}: {1}")]
    Io(PathBuf, String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha1::{Digest, Sha1};

    fn hash(bytes: &[u8]) -> [u8; 20] {
        let digest = Sha1::digest(bytes);
        let mut value = [0u8; 20];
        value.copy_from_slice(&digest);
        value
    }

    fn meta() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([9u8; 20]),
            name: "bundle".to_owned(),
            piece_length: 4,
            piece_hashes: vec![hash(b"abcd"), hash(b"efgh")],
            files: vec![
                TorrentFile {
                    path: "bundle/a.bin".to_owned(),
                    length: 3,
                    offset: 0,
                },
                TorrentFile {
                    path: "bundle/b.bin".to_owned(),
                    length: 5,
                    offset: 3,
                },
            ],
            total_length: 8,
            trackers: vec!["https://secret.example/announce?passkey=x".to_owned()],
            tracker_tiers: vec![vec!["https://secret.example/announce?passkey=x".to_owned()]],
            private: true,
        }
    }

    #[test]
    fn manifest_round_trip_preserves_transfer_geometry_but_redacts_trackers() {
        let manifest = TorrentStorageManifest::from_metainfo(&meta());
        let parsed = TorrentStorageManifest::parse(&manifest.encode().unwrap()).unwrap();
        assert_eq!(parsed.metainfo.info_hash, manifest.metainfo.info_hash);
        assert_eq!(parsed.metainfo.piece_hashes, manifest.metainfo.piece_hashes);
        assert_eq!(parsed.metainfo.files, manifest.metainfo.files);
        assert!(parsed.metainfo.private);
        assert!(parsed.had_trackers);
        assert!(parsed.metainfo.trackers.is_empty());
        assert!(parsed.metainfo.tracker_tiers.is_empty());
    }

    #[test]
    fn recovering_loader_accepts_valid_backup_after_corrupt_primary() {
        let dir = std::env::temp_dir().join(format!(
            "nova-manifest-recovery-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("manifest.bin");
        let manifest = TorrentStorageManifest::from_metainfo(&meta());
        std::fs::write(&path, b"corrupt").unwrap();
        std::fs::write(append_suffix(&path, ".bak"), manifest.encode().unwrap()).unwrap();

        let recovered = load_storage_manifest_recovering(&path).unwrap();
        assert_eq!(recovered.metainfo.info_hash, manifest.metainfo.info_hash);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn manifest_rejects_windows_device_and_case_colliding_paths() {
        let mut manifest = TorrentStorageManifest::from_metainfo(&meta());
        manifest.metainfo.files[0].path = "bundle/CON.txt".to_owned();
        assert!(matches!(
            manifest.encode(),
            Err(ManifestError::UnsafePath(_))
        ));

        let mut manifest = TorrentStorageManifest::from_metainfo(&meta());
        manifest.metainfo.files[1].path = "BUNDLE/A.BIN".to_owned();
        assert!(matches!(
            manifest.encode(),
            Err(ManifestError::UnsafePath(_))
        ));
    }

    #[test]
    fn manifest_rejects_path_traversal() {
        let mut manifest = TorrentStorageManifest::from_metainfo(&meta());
        manifest.metainfo.files[0].path = "../escape.bin".to_owned();
        assert!(matches!(
            manifest.encode(),
            Err(ManifestError::UnsafePath(_))
        ));
    }
}
