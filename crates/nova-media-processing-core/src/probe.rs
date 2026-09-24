use crate::MediaContainer;

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
        return Some(MediaContainer::Matroska);
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

fn is_mpeg_ts(bytes: &[u8]) -> bool {
    if bytes.first() != Some(&0x47) {
        return false;
    }
    bytes.len() < 189 || bytes.get(188) == Some(&0x47)
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

    #[test]
    fn sniffs_iso_bmff_mp4() {
        let bytes = [
            0, 0, 0, 24, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm',
        ];
        assert_eq!(sniff_media_container(&bytes), Some(MediaContainer::Mp4));
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
    fn unknown_bytes_are_not_guessed() {
        assert_eq!(sniff_media_container(b"not-media"), None);
    }
}
