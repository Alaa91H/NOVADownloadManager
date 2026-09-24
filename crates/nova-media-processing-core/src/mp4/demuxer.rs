use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::{
    MediaDemuxer, MediaPacket, MediaPacketFlags, MediaProbe, MediaProcessingError,
    MediaTimeBase, MediaTimestamp,
};

use super::boxes::{demux_error, parse_boxes, FourCc};
use super::fragments::{parse_moof_packets, parse_trex_defaults, FragmentPacket};
use super::parser::{parse_movie, Mp4Sample, ParsedMp4};

const MAX_MOOV_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MOOF_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PACKET_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
struct PacketLocator {
    track_id: u32,
    time_base: MediaTimeBase,
    sample: Mp4Sample,
}

#[derive(Clone, Copy, Debug)]
struct TopLevelBox {
    kind: FourCc,
    offset: u64,
    size: u64,
    header_size: u64,
}

struct ScannedMp4 {
    file: File,
    file_len: u64,
    parsed: ParsedMp4,
    fragment_packets: Vec<FragmentPacket>,
    mdat_ranges: Vec<(u64, u64)>,
}

pub struct Mp4Demuxer {
    file: File,
    probe: MediaProbe,
    packets: Vec<PacketLocator>,
    cursor: usize,
}

impl Mp4Demuxer {
    pub fn open(path: &Path) -> Result<Self, MediaProcessingError> {
        let scanned = scan_mp4_file(path)?;

        let mut packets = Vec::new();
        if scanned.parsed.fragmented {
            for packet in &scanned.fragment_packets {
                validate_sample_bounds(
                    &packet.sample,
                    scanned.file_len,
                    &scanned.mdat_ranges,
                )?;
                packets.push(PacketLocator {
                    track_id: packet.track_id,
                    time_base: packet.time_base,
                    sample: packet.sample.clone(),
                });
            }
            if packets.is_empty() {
                return Err(demux_error(
                    "fragmented MP4 contains no supported moof/traf/trun samples",
                ));
            }
        } else {
            for track in &scanned.parsed.tracks {
                for sample in &track.samples {
                    validate_sample_bounds(
                        sample,
                        scanned.file_len,
                        &scanned.mdat_ranges,
                    )?;
                    packets.push(PacketLocator {
                        track_id: track.track.id,
                        time_base: track.track.time_base,
                        sample: sample.clone(),
                    });
                }
            }
        }

        packets.sort_by(|left, right| {
            left.sample
                .offset
                .cmp(&right.sample.offset)
                .then_with(|| left.track_id.cmp(&right.track_id))
                .then_with(|| left.sample.dts.cmp(&right.sample.dts))
        });

        Ok(Self {
            file: scanned.file,
            probe: scanned.parsed.probe,
            packets,
            cursor: 0,
        })
    }

    pub fn packet_count(&self) -> usize {
        self.packets.len()
    }
}

impl MediaDemuxer for Mp4Demuxer {
    fn probe(&self) -> &MediaProbe {
        &self.probe
    }

    fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError> {
        let Some(locator) = self.packets.get(self.cursor).cloned() else {
            return Ok(None);
        };
        self.cursor += 1;

        let packet_size = u64::from(locator.sample.size);
        if packet_size > MAX_PACKET_BYTES {
            return Err(demux_error(format!(
                "MP4 sample size {packet_size} exceeds safety limit {MAX_PACKET_BYTES}"
            )));
        }
        let packet_size = usize::try_from(packet_size)
            .map_err(|_| demux_error("MP4 sample size does not fit platform"))?;
        let mut data = vec![0_u8; packet_size];
        self.file
            .seek(SeekFrom::Start(locator.sample.offset))
            .and_then(|_| self.file.read_exact(&mut data))
            .map_err(|error| MediaProcessingError::Io(error.to_string()))?;

        Ok(Some(MediaPacket {
            track_id: locator.track_id,
            pts: Some(MediaTimestamp {
                value: locator.sample.pts,
                time_base: locator.time_base,
            }),
            dts: Some(MediaTimestamp {
                value: locator.sample.dts,
                time_base: locator.time_base,
            }),
            duration: Some(MediaTimestamp {
                value: i64::from(locator.sample.duration),
                time_base: locator.time_base,
            }),
            flags: MediaPacketFlags {
                keyframe: locator.sample.keyframe,
                discontinuity: false,
                corrupted: false,
            },
            data,
        }))
    }
}

pub fn probe_mp4_file(path: &Path) -> Result<MediaProbe, MediaProcessingError> {
    scan_mp4_file(path).map(|scanned| scanned.parsed.probe)
}

fn scan_mp4_file(path: &Path) -> Result<ScannedMp4, MediaProcessingError> {
    let mut file = File::open(path).map_err(|error| MediaProcessingError::Io(error.to_string()))?;
    let file_len = file
        .metadata()
        .map_err(|error| MediaProcessingError::Io(error.to_string()))?
        .len();
    if file_len < 8 {
        return Err(demux_error("file is too small to be ISO-BMFF"));
    }

    let top_level = scan_top_level_boxes(&mut file, file_len)?;
    let moov = top_level
        .iter()
        .find(|item| item.kind == FourCc::new(*b"moov"))
        .copied()
        .ok_or_else(|| demux_error("MP4 file is missing moov"))?;

    let moov_payload = read_top_level_payload(&mut file, moov, MAX_MOOV_BYTES)?;
    let has_top_level_moof = top_level
        .iter()
        .any(|item| item.kind == FourCc::new(*b"moof"));
    let has_mvex = parse_boxes(&moov_payload)?
        .iter()
        .any(|item| item.kind == FourCc::new(*b"mvex"));
    let parsed = parse_movie(&moov_payload, has_top_level_moof || has_mvex)?;

    let mdat_ranges = top_level
        .iter()
        .filter(|item| item.kind == FourCc::new(*b"mdat"))
        .map(|item| {
            let start = item
                .offset
                .checked_add(item.header_size)
                .ok_or_else(|| demux_error("mdat payload offset overflow"))?;
            let end = item
                .offset
                .checked_add(item.size)
                .ok_or_else(|| demux_error("mdat end offset overflow"))?;
            Ok((start, end))
        })
        .collect::<Result<Vec<_>, MediaProcessingError>>()?;

    let mut fragment_packets = Vec::new();
    if parsed.fragmented {
        let defaults = parse_trex_defaults(&moov_payload)?;
        let time_bases = parsed
            .tracks
            .iter()
            .map(|track| (track.track.id, track.track.time_base))
            .collect::<BTreeMap<_, _>>();

        for moof in top_level
            .iter()
            .filter(|item| item.kind == FourCc::new(*b"moof"))
            .copied()
        {
            let payload = read_top_level_payload(&mut file, moof, MAX_MOOF_BYTES)?;
            fragment_packets.extend(parse_moof_packets(
                &payload,
                moof.offset,
                &time_bases,
                &defaults,
            )?);
        }
    }

    Ok(ScannedMp4 {
        file,
        file_len,
        parsed,
        fragment_packets,
        mdat_ranges,
    })
}

fn read_top_level_payload(
    file: &mut File,
    item: TopLevelBox,
    max_bytes: u64,
) -> Result<Vec<u8>, MediaProcessingError> {
    let payload_size = item
        .size
        .checked_sub(item.header_size)
        .ok_or_else(|| demux_error("invalid top-level box size"))?;
    if payload_size > max_bytes {
        return Err(demux_error(format!(
            "ISO-BMFF {} payload size {payload_size} exceeds safety limit {max_bytes}",
            item.kind
        )));
    }
    let payload_len = usize::try_from(payload_size)
        .map_err(|_| demux_error("top-level payload size does not fit platform"))?;
    let mut payload = vec![0_u8; payload_len];
    let payload_offset = item
        .offset
        .checked_add(item.header_size)
        .ok_or_else(|| demux_error("top-level payload offset overflow"))?;
    file.seek(SeekFrom::Start(payload_offset))
        .and_then(|_| file.read_exact(&mut payload))
        .map_err(|error| MediaProcessingError::Io(error.to_string()))?;
    Ok(payload)
}

fn scan_top_level_boxes(
    file: &mut File,
    file_len: u64,
) -> Result<Vec<TopLevelBox>, MediaProcessingError> {
    let mut result = Vec::new();
    let mut offset = 0_u64;

    while offset < file_len {
        let remaining = file_len - offset;
        if remaining < 8 {
            return Err(demux_error("truncated top-level ISO-BMFF box header"));
        }

        file.seek(SeekFrom::Start(offset))
            .map_err(|error| MediaProcessingError::Io(error.to_string()))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)
            .map_err(|error| MediaProcessingError::Io(error.to_string()))?;

        let size32 = u32::from_be_bytes(header[0..4].try_into().expect("four bytes")) as u64;
        let kind = FourCc::new(header[4..8].try_into().expect("four bytes"));
        let (size, header_size) = match size32 {
            0 => (remaining, 8_u64),
            1 => {
                if remaining < 16 {
                    return Err(demux_error("truncated top-level extended box header"));
                }
                let mut extended = [0_u8; 8];
                file.read_exact(&mut extended)
                    .map_err(|error| MediaProcessingError::Io(error.to_string()))?;
                (u64::from_be_bytes(extended), 16_u64)
            }
            value => (value, 8_u64),
        };

        if size < header_size {
            return Err(demux_error(format!(
                "invalid top-level box size {size} for {kind}"
            )));
        }
        let end = offset
            .checked_add(size)
            .ok_or_else(|| demux_error("top-level box offset overflow"))?;
        if end > file_len {
            return Err(demux_error(format!(
                "top-level box {kind} extends past end of file"
            )));
        }

        result.push(TopLevelBox {
            kind,
            offset,
            size,
            header_size,
        });

        if size == 0 {
            break;
        }
        offset = end;
    }

    Ok(result)
}

fn validate_sample_bounds(
    sample: &Mp4Sample,
    file_len: u64,
    mdat_ranges: &[(u64, u64)],
) -> Result<(), MediaProcessingError> {
    let end = sample
        .offset
        .checked_add(u64::from(sample.size))
        .ok_or_else(|| demux_error("MP4 sample byte range overflow"))?;
    if end > file_len {
        return Err(demux_error(format!(
            "MP4 sample range {}..{end} exceeds file length {file_len}",
            sample.offset
        )));
    }

    let inside_mdat = mdat_ranges
        .iter()
        .any(|(start, mdat_end)| sample.offset >= *start && end <= *mdat_end);
    if !inside_mdat {
        return Err(demux_error(format!(
            "MP4 sample range {}..{end} is outside mdat payloads",
            sample.offset
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MediaCodec, MediaContainer};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn box_bytes(kind: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
        let size = u32::try_from(payload.len() + 8).expect("box size");
        let mut bytes = Vec::with_capacity(size as usize);
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn full_box(payload: Vec<u8>) -> Vec<u8> {
        let mut bytes = vec![0, 0, 0, 0];
        bytes.extend_from_slice(&payload);
        bytes
    }

    fn movie_with_sample_offset(sample_offset: u32) -> Vec<u8> {
        let mut mvhd_body = vec![0_u8; 100];
        mvhd_body[8..12].copy_from_slice(&1000_u32.to_be_bytes());
        mvhd_body[12..16].copy_from_slice(&1000_u32.to_be_bytes());
        let mvhd = box_bytes(b"mvhd", full_box(mvhd_body));

        let mut tkhd_body = vec![0_u8; 84];
        tkhd_body[8..12].copy_from_slice(&7_u32.to_be_bytes());
        tkhd_body[76..80].copy_from_slice(&(640_u32 << 16).to_be_bytes());
        tkhd_body[80..84].copy_from_slice(&(360_u32 << 16).to_be_bytes());
        let tkhd = box_bytes(b"tkhd", full_box(tkhd_body));

        let mut mdhd_body = vec![0_u8; 20];
        mdhd_body[8..12].copy_from_slice(&1000_u32.to_be_bytes());
        mdhd_body[12..16].copy_from_slice(&1000_u32.to_be_bytes());
        let mdhd = box_bytes(b"mdhd", full_box(mdhd_body));

        let mut hdlr_body = vec![0_u8; 20];
        hdlr_body[4..8].copy_from_slice(b"vide");
        let hdlr = box_bytes(b"hdlr", full_box(hdlr_body));

        let avcc = box_bytes(b"avcC", vec![1, 66, 0, 30]);
        let mut entry_payload = vec![0_u8; 78];
        entry_payload[24..26].copy_from_slice(&640_u16.to_be_bytes());
        entry_payload[26..28].copy_from_slice(&360_u16.to_be_bytes());
        entry_payload.extend_from_slice(&avcc);
        let avc1 = box_bytes(b"avc1", entry_payload);
        let mut stsd_body = 1_u32.to_be_bytes().to_vec();
        stsd_body.extend_from_slice(&avc1);
        let stsd = box_bytes(b"stsd", full_box(stsd_body));

        let mut stts_body = 1_u32.to_be_bytes().to_vec();
        stts_body.extend_from_slice(&1_u32.to_be_bytes());
        stts_body.extend_from_slice(&1000_u32.to_be_bytes());
        let stts = box_bytes(b"stts", full_box(stts_body));

        let mut stsc_body = 1_u32.to_be_bytes().to_vec();
        stsc_body.extend_from_slice(&1_u32.to_be_bytes());
        stsc_body.extend_from_slice(&1_u32.to_be_bytes());
        stsc_body.extend_from_slice(&1_u32.to_be_bytes());
        let stsc = box_bytes(b"stsc", full_box(stsc_body));

        let mut stsz_body = 0_u32.to_be_bytes().to_vec();
        stsz_body.extend_from_slice(&1_u32.to_be_bytes());
        stsz_body.extend_from_slice(&4_u32.to_be_bytes());
        let stsz = box_bytes(b"stsz", full_box(stsz_body));

        let mut stco_body = 1_u32.to_be_bytes().to_vec();
        stco_body.extend_from_slice(&sample_offset.to_be_bytes());
        let stco = box_bytes(b"stco", full_box(stco_body));

        let stbl = box_bytes(b"stbl", [stsd, stts, stsc, stsz, stco].concat());
        let minf = box_bytes(b"minf", stbl);
        let mdia = box_bytes(b"mdia", [mdhd, hdlr, minf].concat());
        let trak = box_bytes(b"trak", [tkhd, mdia].concat());
        box_bytes(b"moov", [mvhd, trak].concat())
    }

    fn temp_path() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("nova-native-mp4-{unique}.mp4"))
    }

    #[test]
    fn demuxer_reads_indexed_packet_from_mdat() {
        let ftyp = box_bytes(b"ftyp", b"isom\0\0\0\0isom".to_vec());
        let mdat_payload_offset = u32::try_from(ftyp.len() + 8).expect("offset");
        let mdat = box_bytes(b"mdat", b"NOVA".to_vec());
        let moov = movie_with_sample_offset(mdat_payload_offset);
        let path = temp_path();
        fs::write(&path, [ftyp, mdat, moov].concat()).expect("fixture");

        let mut demuxer = Mp4Demuxer::open(&path).expect("demuxer");
        assert_eq!(demuxer.probe().container, MediaContainer::Mp4);
        assert_eq!(demuxer.probe().tracks[0].codec, MediaCodec::H264);
        assert_eq!(demuxer.packet_count(), 1);

        let packet = demuxer.next_packet().expect("packet result").expect("packet");
        assert_eq!(packet.track_id, 7);
        assert_eq!(packet.data, b"NOVA");
        assert!(packet.flags.keyframe);
        assert!(demuxer.next_packet().expect("end").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn probe_accepts_fragmented_initialization_metadata() {
        let ftyp = box_bytes(b"ftyp", b"iso6\0\0\0\0iso6".to_vec());
        let mut moov = movie_with_sample_offset(0);
        let size = u32::from_be_bytes(moov[0..4].try_into().expect("size"));
        let mvex = box_bytes(b"mvex", Vec::new());
        moov.extend_from_slice(&mvex);
        let new_size = size + u32::try_from(mvex.len()).expect("mvex size");
        moov[0..4].copy_from_slice(&new_size.to_be_bytes());

        let path = temp_path();
        fs::write(&path, [ftyp, moov].concat()).expect("fixture");
        let probe = probe_mp4_file(&path).expect("probe");
        assert_eq!(probe.container, MediaContainer::FragmentedMp4);
        assert!(Mp4Demuxer::open(&path).is_err());

        let _ = fs::remove_file(path);
    }
}
