use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaContainer {
    Mp4,
    FragmentedMp4,
    Matroska,
    WebM,
    MpegTs,
    AdtsAac,
    Mp3,
    Flac,
    Ogg,
    Unknown(String),
}

impl MediaContainer {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Mp4 => "mp4",
            Self::FragmentedMp4 => "fragmented-mp4",
            Self::Matroska => "matroska",
            Self::WebM => "webm",
            Self::MpegTs => "mpeg-ts",
            Self::AdtsAac => "adts-aac",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaCodec {
    H264,
    Hevc,
    Av1,
    Vp9,
    Vp8,
    Aac,
    Opus,
    Mp3,
    Flac,
    Pcm,
    Unknown(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaTrackKind {
    Video,
    Audio,
    Subtitle,
    Data,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaTimeBase {
    pub numerator: u32,
    pub denominator: u32,
}

impl MediaTimeBase {
    pub const fn new(numerator: u32, denominator: u32) -> Option<Self> {
        if numerator == 0 || denominator == 0 {
            None
        } else {
            Some(Self {
                numerator,
                denominator,
            })
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaTimestamp {
    pub value: i64,
    pub time_base: MediaTimeBase,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaPacketFlags {
    pub keyframe: bool,
    pub discontinuity: bool,
    pub corrupted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MediaPacket {
    pub track_id: u32,
    pub pts: Option<MediaTimestamp>,
    pub dts: Option<MediaTimestamp>,
    pub duration: Option<MediaTimestamp>,
    pub flags: MediaPacketFlags,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VideoParameters {
    pub width: u32,
    pub height: u32,
    pub frame_rate: Option<f64>,
    pub bitrate_bps: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AudioParameters {
    pub sample_rate_hz: u32,
    pub channels: u16,
    pub bitrate_bps: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaTrack {
    pub id: u32,
    pub kind: MediaTrackKind,
    pub codec: MediaCodec,
    pub time_base: MediaTimeBase,
    pub language: Option<String>,
    pub video: Option<VideoParameters>,
    pub audio: Option<AudioParameters>,
    pub codec_private: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaProbe {
    pub container: MediaContainer,
    pub duration_millis: Option<u64>,
    pub tracks: Vec<MediaTrack>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_timebase_components_are_rejected() {
        assert_eq!(MediaTimeBase::new(0, 1), None);
        assert_eq!(MediaTimeBase::new(1, 0), None);
        assert_eq!(
            MediaTimeBase::new(1, 1000),
            Some(MediaTimeBase {
                numerator: 1,
                denominator: 1000
            })
        );
    }
}
