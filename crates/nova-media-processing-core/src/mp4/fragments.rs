use std::collections::BTreeMap;

use crate::{MediaProcessingError, MediaTimeBase};

use super::boxes::{
    child, demux_error, full_box_body, parse_boxes, read_i32, read_u32, read_u64,
    slice, FourCc,
};
use super::parser::Mp4Sample;

const TFHD_BASE_DATA_OFFSET_PRESENT: u32 = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT: u32 = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT: u32 = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT: u32 = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT: u32 = 0x000020;

const TRUN_DATA_OFFSET_PRESENT: u32 = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT: u32 = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT: u32 = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT: u32 = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT: u32 = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT: u32 = 0x000800;

const SAMPLE_IS_NON_SYNC: u32 = 0x0001_0000;
const MAX_FRAGMENT_SAMPLES: usize = 10_000_000;

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct FragmentDefaults {
    pub sample_duration: Option<u32>,
    pub sample_size: Option<u32>,
    pub sample_flags: Option<u32>,
}

#[derive(Clone, Debug)]
pub(super) struct FragmentPacket {
    pub track_id: u32,
    pub time_base: MediaTimeBase,
    pub sample: Mp4Sample,
}

#[derive(Clone, Copy, Debug)]
struct Tfhd {
    track_id: u32,
    base_data_offset: u64,
    default_duration: Option<u32>,
    default_size: Option<u32>,
    default_flags: Option<u32>,
}

pub(super) fn parse_trex_defaults(
    moov_payload: &[u8],
) -> Result<BTreeMap<u32, FragmentDefaults>, MediaProcessingError> {
    let moov = parse_boxes(moov_payload)?;
    let Some(mvex) = child(&moov, *b"mvex") else {
        return Ok(BTreeMap::new());
    };
    let children = parse_boxes(mvex.payload)?;
    let mut result = BTreeMap::new();

    for trex in children
        .iter()
        .filter(|item| item.kind == FourCc::new(*b"trex"))
    {
        let (_, _, body) = full_box_body(trex.payload)?;
        let track_id = read_u32(slice(body, 0, 4)?)?;
        if track_id == 0 {
            return Err(demux_error("trex contains zero track id"));
        }
        let duration = read_u32(slice(body, 8, 4)?)?;
        let size = read_u32(slice(body, 12, 4)?)?;
        let flags = read_u32(slice(body, 16, 4)?)?;
        result.insert(
            track_id,
            FragmentDefaults {
                sample_duration: (duration != 0).then_some(duration),
                sample_size: (size != 0).then_some(size),
                sample_flags: Some(flags),
            },
        );
    }

    Ok(result)
}

pub(super) fn parse_moof_packets(
    moof_payload: &[u8],
    moof_offset: u64,
    track_time_bases: &BTreeMap<u32, MediaTimeBase>,
    trex_defaults: &BTreeMap<u32, FragmentDefaults>,
) -> Result<Vec<FragmentPacket>, MediaProcessingError> {
    let moof = parse_boxes(moof_payload)?;
    let mut result = Vec::new();

    for traf in moof
        .iter()
        .filter(|item| item.kind == FourCc::new(*b"traf"))
    {
        let traf_children = parse_boxes(traf.payload)?;
        let tfhd_box = child(&traf_children, *b"tfhd")
            .ok_or_else(|| demux_error("fragment traf is missing tfhd"))?;
        let track_id = tfhd_track_id(tfhd_box.payload)?;
        let trex = trex_defaults.get(&track_id).copied().unwrap_or_default();
        let tfhd = parse_tfhd(tfhd_box.payload, moof_offset, trex)?;
        let time_base = track_time_bases
            .get(&track_id)
            .copied()
            .ok_or_else(|| demux_error(format!("fragment references unknown track {track_id}")))?;

        let mut decode_time = child(&traf_children, *b"tfdt")
            .map(|item| parse_tfdt(item.payload))
            .transpose()?
            .unwrap_or(0);
        let mut next_data_offset = None::<u64>;

        for trun in traf_children
            .iter()
            .filter(|item| item.kind == FourCc::new(*b"trun"))
        {
            let parsed = parse_trun(
                trun.payload,
                &tfhd,
                time_base,
                decode_time,
                next_data_offset,
            )?;
            decode_time = parsed.next_decode_time;
            next_data_offset = parsed.next_data_offset;
            if result.len().saturating_add(parsed.packets.len()) > MAX_FRAGMENT_SAMPLES {
                return Err(demux_error(format!(
                    "fragment sample count exceeds safety limit {MAX_FRAGMENT_SAMPLES}"
                )));
            }
            result.extend(parsed.packets);
        }
    }

    Ok(result)
}

fn tfhd_track_id(data: &[u8]) -> Result<u32, MediaProcessingError> {
    let (_, _, body) = full_box_body(data)?;
    read_u32(slice(body, 0, 4)?)
}

fn parse_tfhd(
    data: &[u8],
    moof_offset: u64,
    trex: FragmentDefaults,
) -> Result<Tfhd, MediaProcessingError> {
    let (_, flags, body) = full_box_body(data)?;
    let track_id = read_u32(slice(body, 0, 4)?)?;
    if track_id == 0 {
        return Err(demux_error("tfhd contains zero track id"));
    }

    let mut cursor = 4_usize;
    let base_data_offset = if flags & TFHD_BASE_DATA_OFFSET_PRESENT != 0 {
        let value = read_u64(slice(body, cursor, 8)?)?;
        cursor += 8;
        value
    } else {
        moof_offset
    };

    if flags & TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT != 0 {
        let _ = read_u32(slice(body, cursor, 4)?)?;
        cursor += 4;
    }

    let default_duration = if flags & TFHD_DEFAULT_SAMPLE_DURATION_PRESENT != 0 {
        let value = read_u32(slice(body, cursor, 4)?)?;
        cursor += 4;
        Some(value)
    } else {
        trex.sample_duration
    };

    let default_size = if flags & TFHD_DEFAULT_SAMPLE_SIZE_PRESENT != 0 {
        let value = read_u32(slice(body, cursor, 4)?)?;
        cursor += 4;
        Some(value)
    } else {
        trex.sample_size
    };

    let default_flags = if flags & TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT != 0 {
        Some(read_u32(slice(body, cursor, 4)?)?)
    } else {
        trex.sample_flags
    };

    Ok(Tfhd {
        track_id,
        base_data_offset,
        default_duration,
        default_size,
        default_flags,
    })
}

fn parse_tfdt(data: &[u8]) -> Result<i64, MediaProcessingError> {
    let (version, _, body) = full_box_body(data)?;
    let value = match version {
        0 => u64::from(read_u32(slice(body, 0, 4)?)?),
        1 => read_u64(slice(body, 0, 8)?)?,
        other => return Err(demux_error(format!("unsupported tfdt version {other}"))),
    };
    i64::try_from(value).map_err(|_| demux_error("fragment decode time exceeds i64"))
}

struct ParsedTrun {
    packets: Vec<FragmentPacket>,
    next_decode_time: i64,
    next_data_offset: Option<u64>,
}

fn parse_trun(
    data: &[u8],
    tfhd: &Tfhd,
    time_base: MediaTimeBase,
    mut decode_time: i64,
    inherited_data_offset: Option<u64>,
) -> Result<ParsedTrun, MediaProcessingError> {
    let (version, flags, body) = full_box_body(data)?;
    if version > 1 {
        return Err(demux_error(format!("unsupported trun version {version}")));
    }

    let sample_count = usize::try_from(read_u32(slice(body, 0, 4)?)?)
        .map_err(|_| demux_error("trun sample count does not fit platform"))?;
    if sample_count > MAX_FRAGMENT_SAMPLES {
        return Err(demux_error(format!(
            "trun sample count {sample_count} exceeds safety limit {MAX_FRAGMENT_SAMPLES}"
        )));
    }

    let mut cursor = 4_usize;
    let data_offset = if flags & TRUN_DATA_OFFSET_PRESENT != 0 {
        let value = read_i32(slice(body, cursor, 4)?)?;
        cursor += 4;
        Some(value)
    } else {
        None
    };

    if flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT != 0
        && flags & TRUN_SAMPLE_FLAGS_PRESENT != 0
    {
        return Err(demux_error(
            "trun cannot contain both first-sample-flags and per-sample flags",
        ));
    }
    let first_sample_flags = if flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT != 0 {
        let value = read_u32(slice(body, cursor, 4)?)?;
        cursor += 4;
        Some(value)
    } else {
        None
    };

    let mut byte_offset = if let Some(relative) = data_offset {
        add_signed(tfhd.base_data_offset, relative)?
    } else {
        inherited_data_offset.unwrap_or(tfhd.base_data_offset)
    };

    let mut packets = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let duration = if flags & TRUN_SAMPLE_DURATION_PRESENT != 0 {
            let value = read_u32(slice(body, cursor, 4)?)?;
            cursor += 4;
            value
        } else {
            tfhd.default_duration.ok_or_else(|| {
                demux_error(format!(
                    "fragment track {} has no sample duration",
                    tfhd.track_id
                ))
            })?
        };

        let size = if flags & TRUN_SAMPLE_SIZE_PRESENT != 0 {
            let value = read_u32(slice(body, cursor, 4)?)?;
            cursor += 4;
            value
        } else {
            tfhd.default_size.ok_or_else(|| {
                demux_error(format!(
                    "fragment track {} has no sample size",
                    tfhd.track_id
                ))
            })?
        };

        let sample_flags = if flags & TRUN_SAMPLE_FLAGS_PRESENT != 0 {
            let value = read_u32(slice(body, cursor, 4)?)?;
            cursor += 4;
            value
        } else if index == 0 {
            first_sample_flags.or(tfhd.default_flags).unwrap_or(0)
        } else {
            tfhd.default_flags.unwrap_or(0)
        };

        let composition_offset = if flags & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT != 0 {
            let raw = slice(body, cursor, 4)?;
            cursor += 4;
            if version == 0 {
                i64::from(read_u32(raw)?)
            } else {
                i64::from(read_i32(raw)?)
            }
        } else {
            0
        };

        let pts = decode_time
            .checked_add(composition_offset)
            .ok_or_else(|| demux_error("fragment presentation timestamp overflow"))?;

        packets.push(FragmentPacket {
            track_id: tfhd.track_id,
            time_base,
            sample: Mp4Sample {
                offset: byte_offset,
                size,
                dts: decode_time,
                pts,
                duration,
                keyframe: sample_flags & SAMPLE_IS_NON_SYNC == 0,
            },
        });

        byte_offset = byte_offset
            .checked_add(u64::from(size))
            .ok_or_else(|| demux_error("fragment sample byte offset overflow"))?;
        decode_time = decode_time
            .checked_add(i64::from(duration))
            .ok_or_else(|| demux_error("fragment decode timestamp overflow"))?;
    }

    Ok(ParsedTrun {
        packets,
        next_decode_time: decode_time,
        next_data_offset: Some(byte_offset),
    })
}

fn add_signed(base: u64, relative: i32) -> Result<u64, MediaProcessingError> {
    if relative >= 0 {
        base.checked_add(relative as u64)
            .ok_or_else(|| demux_error("fragment data offset overflow"))
    } else {
        base.checked_sub(u64::from(relative.unsigned_abs()))
            .ok_or_else(|| demux_error("fragment data offset underflow"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_bytes(kind: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
        let size = u32::try_from(payload.len() + 8).expect("box size");
        let mut bytes = Vec::with_capacity(size as usize);
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn full_box(flags: u32, payload: Vec<u8>) -> Vec<u8> {
        let mut bytes = vec![
            0,
            ((flags >> 16) & 0xff) as u8,
            ((flags >> 8) & 0xff) as u8,
            (flags & 0xff) as u8,
        ];
        bytes.extend_from_slice(&payload);
        bytes
    }

    #[test]
    fn parses_standard_cmaf_trun_offsets_and_timestamps() {
        let mut tfhd_body = 1_u32.to_be_bytes().to_vec();
        tfhd_body.extend_from_slice(&1000_u32.to_be_bytes());
        tfhd_body.extend_from_slice(&4_u32.to_be_bytes());
        let tfhd = box_bytes(
            b"tfhd",
            full_box(
                TFHD_DEFAULT_SAMPLE_DURATION_PRESENT | TFHD_DEFAULT_SAMPLE_SIZE_PRESENT,
                tfhd_body,
            ),
        );

        let tfdt = box_bytes(b"tfdt", full_box(0, 2000_u32.to_be_bytes().to_vec()));

        let mut trun_body = 2_u32.to_be_bytes().to_vec();
        trun_body.extend_from_slice(&100_i32.to_be_bytes());
        trun_body.extend_from_slice(&0_u32.to_be_bytes());
        trun_body.extend_from_slice(&SAMPLE_IS_NON_SYNC.to_be_bytes());
        let trun = box_bytes(
            b"trun",
            full_box(
                TRUN_DATA_OFFSET_PRESENT | TRUN_SAMPLE_FLAGS_PRESENT,
                trun_body,
            ),
        );

        let traf = box_bytes(b"traf", [tfhd, tfdt, trun].concat());
        let time_base = MediaTimeBase::new(1, 1000).expect("time base");
        let tracks = BTreeMap::from([(1_u32, time_base)]);
        let packets =
            parse_moof_packets(&traf, 5000, &tracks, &BTreeMap::new()).expect("fragment");

        assert_eq!(packets.len(), 2);
        assert_eq!(packets[0].sample.offset, 5100);
        assert_eq!(packets[1].sample.offset, 5104);
        assert_eq!(packets[0].sample.dts, 2000);
        assert_eq!(packets[1].sample.dts, 3000);
        assert!(packets[0].sample.keyframe);
        assert!(!packets[1].sample.keyframe);
    }
}
