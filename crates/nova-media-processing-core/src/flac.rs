#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FlacStreamInfo {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
}

pub(crate) fn parse_native_flac_codec_private(
    data: &[u8],
) -> Result<FlacStreamInfo, String> {
    if data.len() < 42 || !data.starts_with(b"fLaC") {
        return Err(
            "FLAC CodecPrivate must begin with the fLaC signature and STREAMINFO".to_owned(),
        );
    }

    let header = &data[4..8];
    if header[0] & 0x7f != 0 {
        return Err("FLAC CodecPrivate first metadata block must be STREAMINFO".to_owned());
    }
    let length = (usize::from(header[1]) << 16)
        | (usize::from(header[2]) << 8)
        | usize::from(header[3]);
    if length != 34 {
        return Err(format!(
            "FLAC STREAMINFO metadata block must be 34 bytes, got {length}"
        ));
    }
    if data.len() < 8 + length {
        return Err("FLAC STREAMINFO metadata block is truncated".to_owned());
    }

    validate_metadata_blocks(&data[4..])?;

    let streaminfo = &data[8..42];
    let sample_rate_hz = (u32::from(streaminfo[10]) << 12)
        | (u32::from(streaminfo[11]) << 4)
        | (u32::from(streaminfo[12]) >> 4);
    if sample_rate_hz == 0 {
        return Err("FLAC STREAMINFO sample rate must be positive".to_owned());
    }

    let channels = u16::from(((streaminfo[12] >> 1) & 0x07) + 1);
    let bits_per_sample =
        u16::from((((streaminfo[12] & 0x01) << 4) | (streaminfo[13] >> 4)) + 1);
    if !(1..=8).contains(&channels) {
        return Err("FLAC STREAMINFO channel count is outside 1..=8".to_owned());
    }
    if !(4..=32).contains(&bits_per_sample) {
        return Err("FLAC STREAMINFO bit depth is outside 4..=32".to_owned());
    }

    Ok(FlacStreamInfo {
        sample_rate_hz,
        channels,
        bits_per_sample,
    })
}

fn validate_metadata_blocks(data: &[u8]) -> Result<(), String> {
    let mut cursor = 0_usize;
    let mut saw_last = false;
    let mut block_index = 0_usize;

    while cursor < data.len() {
        if saw_last {
            return Err("FLAC CodecPrivate contains data after the last metadata block".to_owned());
        }
        let header = data
            .get(cursor..cursor.saturating_add(4))
            .ok_or_else(|| "FLAC metadata block header is truncated".to_owned())?;
        let is_last = header[0] & 0x80 != 0;
        let block_type = header[0] & 0x7f;
        if block_type == 127 {
            return Err("FLAC metadata block type 127 is forbidden".to_owned());
        }
        if block_index > 0 && block_type == 0 {
            return Err("FLAC CodecPrivate contains more than one STREAMINFO block".to_owned());
        }
        let length = (usize::from(header[1]) << 16)
            | (usize::from(header[2]) << 8)
            | usize::from(header[3]);
        cursor = cursor
            .checked_add(4)
            .and_then(|value| value.checked_add(length))
            .filter(|value| *value <= data.len())
            .ok_or_else(|| "FLAC metadata block payload is truncated".to_owned())?;
        saw_last = is_last;
        block_index += 1;
    }

    if !saw_last {
        return Err("FLAC CodecPrivate metadata chain has no last-block marker".to_owned());
    }
    Ok(())
}

pub(crate) fn flac_metadata_blocks(data: &[u8]) -> Result<&[u8], String> {
    let _ = parse_native_flac_codec_private(data)?;
    Ok(&data[4..])
}

pub(crate) fn native_flac_codec_private_from_dfla(
    data: &[u8],
) -> Result<Vec<u8>, String> {
    if data.len() < 8 {
        return Err("FLAC dfLa box is too short".to_owned());
    }
    if data[0] != 0 || &data[1..4] != b"\0\0\0" {
        return Err("FLAC dfLa FullBox must use version 0 and flags 0".to_owned());
    }

    let mut codec_private = Vec::with_capacity(data.len());
    codec_private.extend_from_slice(b"fLaC");
    codec_private.extend_from_slice(&data[4..]);
    let _ = parse_native_flac_codec_private(&codec_private)?;
    Ok(codec_private)
}

pub(crate) fn flac_sample_entry_rate(sample_rate_hz: u32) -> u16 {
    if let Ok(rate) = u16::try_from(sample_rate_hz) {
        return rate;
    }

    // The FLAC-in-MP4 mapping asks for the greatest expressible regular
    // division when the real rate cannot fit the 16.16 sample-entry field.
    // These are the regular FLAC/base audio rates below 65,536 Hz.
    const REGULAR_RATES: [u32; 9] = [
        48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    ];
    REGULAR_RATES
        .into_iter()
        .find(|rate| sample_rate_hz % rate == 0)
        .and_then(|rate| u16::try_from(rate).ok())
        .unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codec_private(sample_rate_hz: u32, channels: u8, bits_per_sample: u8) -> Vec<u8> {
        let mut streaminfo = vec![0_u8; 34];
        streaminfo[0..2].copy_from_slice(&4096_u16.to_be_bytes());
        streaminfo[2..4].copy_from_slice(&4096_u16.to_be_bytes());
        let packed = (u64::from(sample_rate_hz) << 44)
            | (u64::from(channels - 1) << 41)
            | (u64::from(bits_per_sample - 1) << 36);
        streaminfo[10..18].copy_from_slice(&packed.to_be_bytes());

        let mut result = b"fLaC".to_vec();
        result.extend_from_slice(&[0x80, 0x00, 0x00, 34]);
        result.extend_from_slice(&streaminfo);
        result
    }

    #[test]
    fn parses_streaminfo_and_reduces_high_sample_entry_rate() {
        let private = codec_private(192_000, 2, 24);
        let info = parse_native_flac_codec_private(&private).expect("STREAMINFO");
        assert_eq!(info.sample_rate_hz, 192_000);
        assert_eq!(info.channels, 2);
        assert_eq!(info.bits_per_sample, 24);
        assert_eq!(flac_sample_entry_rate(info.sample_rate_hz), 48_000);
        assert_eq!(flac_sample_entry_rate(88_200), 44_100);
        assert_eq!(flac_sample_entry_rate(144_000), 48_000);
        assert_eq!(flac_sample_entry_rate(65_537), u16::MAX);
    }

    #[test]
    fn rejects_metadata_after_last_block() {
        let mut private = codec_private(48_000, 2, 16);
        private.extend_from_slice(&[0x84, 0, 0, 0]);
        assert!(parse_native_flac_codec_private(&private).is_err());
    }

    #[test]
    fn dfla_round_trip_restores_native_flac_signature() {
        let private = codec_private(48_000, 2, 16);
        let mut dfla = vec![0, 0, 0, 0];
        dfla.extend_from_slice(flac_metadata_blocks(&private).expect("metadata"));
        assert_eq!(
            native_flac_codec_private_from_dfla(&dfla).expect("native private"),
            private
        );
    }
}
