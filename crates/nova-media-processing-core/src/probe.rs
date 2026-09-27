use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::{MediaContainer, MediaProcessingError};

const PROBE_PREFIX_BYTES: usize = 4096;

/// Read a small prefix from a local media file and identify its container
/// without invoking an external probing executable.
pub fn probe_file_container(path: &Path) -> Result<MediaContainer, MediaProcessingError> {
    let mut file = File::open(path).map_err(|error| MediaProcessingError::Io(error.to_string()))?;
    let mut prefix = vec![0_u8; PROBE_PREFIX_BYTES];
    let read = file
        .read(&mut prefix)
        .map_err(|error| MediaProcessingError::Io(error.to_string()))?;
    prefix.truncate(read);

    sniff_media_container(&prefix).ok_or_else(|| {
        MediaProcessingError::Probe(format!(
            "container signature is not recognized for {}",
            path.display()
        ))
    })
}

/// Detect common media containers using bytes from the beginning of a file.
///
/// This is deliberately conservative: it only returns a concrete type when a
/// stable container signature is present. Full track/codec probing belongs to
/// the demux implementations added in subsequent stages.
pub fn sniff_media_container(bytes: &[u8]) -> Option<MediaContainer> {
    if is_isobmff(bytes) {
        return Some(MediaContainer::Mp4);
    }
    if is_ebml(bytes) {
        return sniff_ebml_container(bytes);
    }
    if is_mpeg_ts(bytes) {
        return Some(MediaContainer::MpegTs);
    }
    if is_adts(bytes) {
        return Some(MediaContainer::AdtsAac);
    }
    if bytes.starts_with(b"fLaC") {
        return Some(MediaContainer::Flac);
    }
    if bytes.starts_with(b"OggS") {
        return Some(MediaContainer::Ogg);
    }
    if bytes.starts_with(b"ID3") || is_mpeg_audio_frame(bytes) {
        return Some(MediaContainer::Mp3);
    }

    None
}

fn is_isobmff(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[4..8] == b"ftyp"
}

fn is_ebml(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3])
}

fn sniff_ebml_container(bytes: &[u8]) -> Option<MediaContainer> {
    let (header_size, size_len) = read_ebml_size(bytes, 4)?;
    let mut cursor = 4_usize.checked_add(size_len)?;
    let header_end = cursor.checked_add(header_size)?;
    if header_end > bytes.len() {
        return None;
    }

    while cursor < header_end {
        let first = *bytes.get(cursor)?;
        if first == 0 {
            return None;
        }
        let id_len = usize::try_from(first.leading_zeros() + 1).ok()?;
        if id_len == 0 || id_len > 4 {
            return None;
        }
        let id_end = cursor.checked_add(id_len)?;
        if id_end > header_end {
            return None;
        }

        let (payload_size, payload_size_len) = read_ebml_size(bytes, id_end)?;
        let payload_start = id_end.checked_add(payload_size_len)?;
        let payload_end = payload_start.checked_add(payload_size)?;
        if payload_end > header_end {
            return None;
        }

        if bytes.get(cursor..id_end) == Some(&[0x42, 0x82][..]) {
            let doc_type = std::str::from_utf8(bytes.get(payload_start..payload_end)?).ok()?;
            if doc_type.eq_ignore_ascii_case("webm") {
                return Some(MediaContainer::WebM);
            }
            if doc_type.eq_ignore_ascii_case("matroska") {
                return Some(MediaContainer::Matroska);
            }
            return None;
        }

        cursor = payload_end;
    }

    None
}

fn read_ebml_size(bytes: &[u8], offset: usize) -> Option<(usize, usize)> {
    let first = *bytes.get(offset)?;
    if first == 0 {
        return None;
    }
    let length = usize::try_from(first.leading_zeros() + 1).ok()?;
    if length == 0 || length > 8 {
        return None;
    }
    let marker = 0x80_u8 >> (length - 1);
    let mut value = u64::from(first & (marker - 1));
    for index in 1..length {
        value = (value << 8) | u64::from(*bytes.get(offset.checked_add(index)?)?);
    }
    let unknown_max = (1_u64 << (7 * length)) - 1;
    if value == unknown_max {
        return None;
    }
    Some((usize::try_from(value).ok()?, length))
}

fn is_mpeg_ts(bytes: &[u8]) -> bool {
    if bytes.len() < 188 || bytes.first() != Some(&0x47) {
        return false;
    }
    if bytes.len() > 188 && bytes.get(188) != Some(&0x47) {
        return false;
    }
    if bytes.len() > 376 && bytes.get(376) != Some(&0x47) {
        return false;
    }
    true
}

fn is_adts(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xF6) == 0xF0
}

fn is_mpeg_audio_frame(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn sniffs_iso_bmff_mp4() {
        let bytes = [
            0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm',
        ];
        assert_eq!(sniff_media_container(&bytes), Some(MediaContainer::Mp4));
    }

    #[test]
    fn distinguishes_webm_ebml_header() {
        let bytes = [
            0x1A, 0x45, 0xDF, 0xA3, 0x87,
            0x42, 0x82, 0x84, b'w', b'e', b'b', b'm',
        ];
        assert_eq!(sniff_media_container(&bytes), Some(MediaContainer::WebM));
    }

    #[test]
    fn distinguishes_matroska_ebml_header() {
        let bytes = [
            0x1A, 0x45, 0xDF, 0xA3, 0x8B,
            0x42, 0x82, 0x88, b'm', b'a', b't', b'r', b'o', b's', b'k', b'a',
        ];
        assert_eq!(
            sniff_media_container(&bytes),
            Some(MediaContainer::Matroska)
        );
    }

    #[test]
    fn unknown_ebml_doctype_is_not_guessed_as_matroska() {
        let bytes = [
            0x1A, 0x45, 0xDF, 0xA3, 0x86,
            0x42, 0x82, 0x83, b'f', b'o', b'o',
        ];
        assert_eq!(sniff_media_container(&bytes), None);
    }

    #[test]
    fn sniffs_mpeg_ts_with_packet_sync() {
        let mut bytes = vec![0_u8; 376];
        bytes[0] = 0x47;
        bytes[188] = 0x47;
        assert_eq!(
            sniff_media_container(&bytes),
            Some(MediaContainer::MpegTs)
        );
    }

    #[test]
    fn probes_real_file_prefix() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nova-probe-{unique}.mp4"));
        fs::write(
            &path,
            [0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
        )
        .expect("write fixture");

        assert_eq!(probe_file_container(&path), Ok(MediaContainer::Mp4));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn unknown_bytes_are_not_guessed() {
        assert_eq!(sniff_media_container(b"not-media"), None);
    }
}
