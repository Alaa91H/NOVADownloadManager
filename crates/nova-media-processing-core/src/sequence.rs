use std::collections::{HashMap, HashSet};

use crate::{
    MediaDemuxer, MediaPacket, MediaProbe, MediaProcessingError, MediaTimestamp, MediaTrack,
};

const MAX_SEQUENTIAL_INPUTS: usize = 4096;

struct TrackTimeline {
    end_dts: Option<i64>,
    segment_offset: Option<i64>,
}

/// Presents consecutive media periods as one timestamp-contiguous input.
///
/// Every input must expose the same track definitions. Period-relative decode
/// timestamps are shifted forward when they reset to zero; gaps, missing
/// tracks, codec configuration changes, and timestamp overflow are rejected.
pub struct SequentialMediaDemuxer {
    inputs: Vec<Box<dyn MediaDemuxer>>,
    probe: MediaProbe,
    track_id_maps: Vec<HashMap<u32, u32>>,
    timelines: HashMap<u32, TrackTimeline>,
    tracks_by_id: HashMap<u32, MediaTrack>,
    seen_in_segment: HashSet<u32>,
    current_input: usize,
}

impl SequentialMediaDemuxer {
    pub fn new(inputs: Vec<Box<dyn MediaDemuxer>>) -> Result<Self, MediaProcessingError> {
        if inputs.is_empty() {
            return Err(MediaProcessingError::InvalidJob(
                "sequential media requires at least one input".to_owned(),
            ));
        }
        if inputs.len() > MAX_SEQUENTIAL_INPUTS {
            return Err(MediaProcessingError::InvalidJob(format!(
                "sequential media exceeds the input limit of {MAX_SEQUENTIAL_INPUTS}"
            )));
        }

        let mut probe = inputs[0].probe().clone();
        if probe.tracks.is_empty() {
            return Err(MediaProcessingError::Demux(
                "sequential media input contains no tracks".to_owned(),
            ));
        }
        let tracks_by_id = unique_tracks_by_id(&probe.tracks)?;
        let mut track_id_maps = Vec::with_capacity(inputs.len());

        for input in &inputs {
            let source_tracks = &input.probe().tracks;
            unique_tracks_by_id(source_tracks)?;
            if source_tracks.len() != probe.tracks.len() {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "sequential media periods have different track counts".to_owned(),
                ));
            }

            let mut unmatched = vec![true; probe.tracks.len()];
            let mut id_map = HashMap::with_capacity(source_tracks.len());
            for source in source_tracks {
                let Some(index) = probe.tracks.iter().enumerate().position(|(index, target)| {
                    unmatched[index] && same_track_definition(source, target)
                }) else {
                    return Err(MediaProcessingError::UnsupportedOperation(
                        "sequential media periods change track codec or configuration".to_owned(),
                    ));
                };
                unmatched[index] = false;
                id_map.insert(source.id, probe.tracks[index].id);
            }
            if unmatched.iter().any(|missing| *missing) {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "sequential media periods do not preserve all track definitions".to_owned(),
                ));
            }
            track_id_maps.push(id_map);
        }

        probe.duration_millis = inputs
            .iter()
            .map(|input| input.probe().duration_millis)
            .try_fold(0_u64, |total, duration| {
                total.checked_add(duration?)
            });

        let timelines = probe
            .tracks
            .iter()
            .map(|track| {
                (
                    track.id,
                    TrackTimeline {
                        end_dts: None,
                        segment_offset: None,
                    },
                )
            })
            .collect();

        Ok(Self {
            inputs,
            probe,
            track_id_maps,
            timelines,
            tracks_by_id,
            seen_in_segment: HashSet::new(),
            current_input: 0,
        })
    }

    fn advance_input(&mut self) -> Result<(), MediaProcessingError> {
        if self.seen_in_segment.len() != self.probe.tracks.len() {
            return Err(MediaProcessingError::Demux(
                "a sequential media period ended before every selected track produced samples"
                    .to_owned(),
            ));
        }
        self.current_input += 1;
        self.seen_in_segment.clear();
        for timeline in self.timelines.values_mut() {
            timeline.segment_offset = None;
        }
        Ok(())
    }
}

impl MediaDemuxer for SequentialMediaDemuxer {
    fn probe(&self) -> &MediaProbe {
        &self.probe
    }

    fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError> {
        loop {
            let Some(input) = self.inputs.get_mut(self.current_input) else {
                return Ok(None);
            };
            let Some(mut packet) = input.next_packet()? else {
                if self.current_input + 1 >= self.inputs.len() {
                    if self.seen_in_segment.len() != self.probe.tracks.len() {
                        return Err(MediaProcessingError::Demux(
                            "the final sequential media period is missing selected track samples"
                                .to_owned(),
                        ));
                    }
                    return Ok(None);
                }
                self.advance_input()?;
                continue;
            };

            let canonical_id = self.track_id_maps[self.current_input]
                .get(&packet.track_id)
                .copied()
                .ok_or_else(|| {
                    MediaProcessingError::Demux(format!(
                        "sequential media period emitted unknown track {}",
                        packet.track_id
                    ))
                })?;
            let track = self.tracks_by_id.get(&canonical_id).ok_or_else(|| {
                MediaProcessingError::Demux(format!(
                    "sequential media has no canonical definition for track {canonical_id}"
                ))
            })?;
            let dts = packet.dts.ok_or_else(|| {
                MediaProcessingError::Demux("sequential media packet is missing DTS".to_owned())
            })?;
            let duration = packet.duration.ok_or_else(|| {
                MediaProcessingError::Demux(
                    "sequential media packet is missing duration".to_owned(),
                )
            })?;
            if dts.time_base != track.time_base || duration.time_base != track.time_base {
                return Err(MediaProcessingError::Demux(
                    "sequential media packet time base changes between periods".to_owned(),
                ));
            }
            if duration.value <= 0 {
                return Err(MediaProcessingError::Demux(
                    "sequential media packet duration must be positive".to_owned(),
                ));
            }
            if packet.flags.discontinuity || packet.flags.corrupted {
                return Err(MediaProcessingError::UnsupportedOperation(
                    "sequential media does not merge discontinuous or corrupted packets"
                        .to_owned(),
                ));
            }

            let timeline = self.timelines.get_mut(&canonical_id).ok_or_else(|| {
                MediaProcessingError::Demux("sequential media timeline is missing".to_owned())
            })?;
            let offset = match timeline.segment_offset {
                Some(offset) => offset,
                None => match timeline.end_dts {
                    Some(end_dts) if dts.value > end_dts => {
                        return Err(MediaProcessingError::UnsupportedOperation(format!(
                            "sequential media period has a decode-time gap: expected {end_dts}, got {}",
                            dts.value
                        )))
                    }
                    Some(end_dts) => end_dts.checked_sub(dts.value).ok_or_else(|| {
                        MediaProcessingError::Demux("DTS offset overflow".to_owned())
                    })?,
                    None => 0,
                },
            };
            let adjusted_dts = dts.value.checked_add(offset).ok_or_else(|| {
                MediaProcessingError::Demux("adjusted DTS overflow".to_owned())
            })?;
            if let Some(expected_dts) = timeline.end_dts {
                if adjusted_dts != expected_dts {
                    return Err(MediaProcessingError::UnsupportedOperation(format!(
                        "sequential media requires contiguous DTS: expected {expected_dts}, got {adjusted_dts}"
                    )));
                }
            }
            let end_dts = adjusted_dts.checked_add(duration.value).ok_or_else(|| {
                MediaProcessingError::Demux("media end DTS overflow".to_owned())
            })?;
            timeline.segment_offset = Some(offset);
            timeline.end_dts = Some(end_dts);

            packet.track_id = canonical_id;
            packet.dts = Some(MediaTimestamp {
                value: adjusted_dts,
                time_base: dts.time_base,
            });
            packet.pts = packet
                .pts
                .map(|pts| {
                    if pts.time_base != track.time_base {
                        return Err(MediaProcessingError::Demux(
                            "sequential media packet PTS time base changes between periods"
                                .to_owned(),
                        ));
                    }
                    Ok(MediaTimestamp {
                        value: pts.value.checked_add(offset).ok_or_else(|| {
                            MediaProcessingError::Demux("adjusted PTS overflow".to_owned())
                        })?,
                        time_base: pts.time_base,
                    })
                })
                .transpose()?;
            self.seen_in_segment.insert(canonical_id);
            return Ok(Some(packet));
        }
    }
}

fn unique_tracks_by_id(
    tracks: &[MediaTrack],
) -> Result<HashMap<u32, MediaTrack>, MediaProcessingError> {
    let mut by_id = HashMap::with_capacity(tracks.len());
    for track in tracks {
        if by_id.insert(track.id, track.clone()).is_some() {
            return Err(MediaProcessingError::Demux(format!(
                "media probe contains duplicate track id {}",
                track.id
            )));
        }
    }
    Ok(by_id)
}

fn same_track_definition(left: &MediaTrack, right: &MediaTrack) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    left.id = 0;
    right.id = 0;
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use crate::{
        MediaCodec, MediaContainer, MediaPacketFlags, MediaTimeBase, MediaTrackKind,
        VideoParameters,
    };

    struct MockDemuxer {
        probe: MediaProbe,
        packets: VecDeque<MediaPacket>,
    }

    impl MediaDemuxer for MockDemuxer {
        fn probe(&self) -> &MediaProbe {
            &self.probe
        }

        fn next_packet(&mut self) -> Result<Option<MediaPacket>, MediaProcessingError> {
            Ok(self.packets.pop_front())
        }
    }

    fn video_track(id: u32, codec_private: &[u8]) -> MediaTrack {
        MediaTrack {
            id,
            kind: MediaTrackKind::Video,
            codec: MediaCodec::H264,
            time_base: MediaTimeBase::new(1, 1000).expect("valid time base"),
            language: None,
            video: Some(VideoParameters {
                width: 640,
                height: 360,
                frame_rate: Some(25.0),
                bitrate_bps: None,
            }),
            audio: None,
            codec_private: codec_private.to_vec(),
        }
    }

    fn audio_track(id: u32, codec_private: &[u8]) -> MediaTrack {
        MediaTrack {
            id,
            kind: MediaTrackKind::Audio,
            codec: MediaCodec::Aac,
            time_base: MediaTimeBase::new(1, 1000).expect("valid time base"),
            language: Some("en".to_owned()),
            video: None,
            audio: Some(crate::AudioParameters {
                sample_rate_hz: 48_000,
                channels: 2,
                bitrate_bps: None,
            }),
            codec_private: codec_private.to_vec(),
        }
    }

    fn packet(track_id: u32, dts: i64, duration: i64) -> MediaPacket {
        let time_base = MediaTimeBase::new(1, 1000).expect("valid time base");
        MediaPacket {
            track_id,
            pts: Some(MediaTimestamp { value: dts, time_base }),
            dts: Some(MediaTimestamp { value: dts, time_base }),
            duration: Some(MediaTimestamp { value: duration, time_base }),
            flags: MediaPacketFlags {
                keyframe: true,
                discontinuity: false,
                corrupted: false,
            },
            data: vec![0x01],
        }
    }

    fn input(tracks: Vec<MediaTrack>, packets: Vec<MediaPacket>) -> Box<dyn MediaDemuxer> {
        Box::new(MockDemuxer {
            probe: MediaProbe {
                container: MediaContainer::FragmentedMp4,
                duration_millis: Some(1000),
                tracks,
            },
            packets: packets.into(),
        })
    }

    #[test]
    fn sequential_demuxer_offsets_period_relative_timestamps() {
        let mut demuxer = SequentialMediaDemuxer::new(vec![
            input(vec![video_track(1, b"avc1")], vec![packet(1, 0, 1000)]),
            input(vec![video_track(7, b"avc1")], vec![packet(7, 0, 1000)]),
        ])
        .expect("stable sequential media");

        assert_eq!(demuxer.probe().duration_millis, Some(2000));
        let first = demuxer.next_packet().expect("first packet").expect("packet");
        let second = demuxer.next_packet().expect("second packet").expect("packet");
        assert_eq!(first.dts.map(|value| value.value), Some(0));
        assert_eq!(second.dts.map(|value| value.value), Some(1000));
        assert_eq!(second.pts.map(|value| value.value), Some(1000));
        assert_eq!(demuxer.next_packet().expect("end"), None);
    }

    #[test]
    fn sequential_demuxer_maps_reordered_audio_video_track_ids() {
        let mut demuxer = SequentialMediaDemuxer::new(vec![
            input(
                vec![video_track(1, b"avc1"), audio_track(2, b"aac")],
                vec![packet(1, 0, 1000), packet(2, 0, 1000)],
            ),
            input(
                vec![audio_track(9, b"aac"), video_track(8, b"avc1")],
                vec![packet(9, 0, 1000), packet(8, 0, 1000)],
            ),
        ])
        .expect("stable audio/video period layouts");

        let packets = std::iter::from_fn(|| {
            demuxer
                .next_packet()
                .expect("read sequential audio/video packet")
        })
        .collect::<Vec<_>>();
        assert_eq!(packets.len(), 4);
        assert_eq!(packets[0].track_id, 1);
        assert_eq!(packets[1].track_id, 2);
        assert_eq!(packets[2].track_id, 2);
        assert_eq!(packets[3].track_id, 1);
        assert_eq!(
            packets
                .iter()
                .map(|packet| packet.dts.map(|timestamp| timestamp.value))
                .collect::<Vec<_>>(),
            vec![Some(0), Some(0), Some(1000), Some(1000)]
        );
    }

    #[test]
    fn sequential_demuxer_rejects_codec_changes_and_timeline_gaps() {
        assert!(SequentialMediaDemuxer::new(vec![
            input(vec![video_track(1, b"first-config")], vec![packet(1, 0, 1000)]),
            input(vec![video_track(1, b"changed-config")], vec![packet(1, 0, 1000)]),
        ])
        .is_err());

        let mut demuxer = SequentialMediaDemuxer::new(vec![
            input(vec![video_track(1, b"avc1")], vec![packet(1, 0, 1000)]),
            input(vec![video_track(1, b"avc1")], vec![packet(1, 1200, 1000)]),
        ])
        .expect("same codec configuration");
        assert!(demuxer.next_packet().expect("first packet").is_some());
        assert!(demuxer.next_packet().is_err());
    }

    #[test]
    fn sequential_demuxer_rejects_duplicate_track_ids_in_later_periods() {
        let duplicate_track = video_track(7, b"avc1");
        let mut second_track = duplicate_track.clone();
        second_track.id = 7;
        assert!(SequentialMediaDemuxer::new(vec![
            input(
                vec![video_track(1, b"avc1"), video_track(2, b"avc1")],
                vec![packet(1, 0, 1000), packet(2, 0, 1000)],
            ),
            input(
                vec![duplicate_track, second_track],
                vec![packet(7, 0, 1000)],
            ),
        ])
        .is_err());
    }
}
