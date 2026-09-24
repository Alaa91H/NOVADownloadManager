use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashSegmentTemplate {
    pub timescale: Option<u64>,
    pub duration: Option<u64>,
    pub start_number: Option<u64>,
    pub media: Option<String>,
    pub initialization: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashRepresentation {
    pub id: Option<String>,
    pub bandwidth: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<String>,
    pub codecs: Option<String>,
    pub mime_type: Option<String>,
    pub base_url: Option<String>,
    pub segment_template: Option<DashSegmentTemplate>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashAdaptationSet {
    pub id: Option<String>,
    pub content_type: Option<String>,
    pub mime_type: Option<String>,
    pub language: Option<String>,
    pub codecs: Option<String>,
    pub base_url: Option<String>,
    pub segment_template: Option<DashSegmentTemplate>,
    pub representations: Vec<DashRepresentation>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashPeriod {
    pub id: Option<String>,
    pub adaptations: Vec<DashAdaptationSet>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashManifest {
    pub is_dynamic: bool,
    pub minimum_update_period: Option<String>,
    pub media_presentation_duration: Option<String>,
    pub periods: Vec<DashPeriod>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DashError {
    #[error("manifest is empty")]
    EmptyManifest,
    #[error("invalid DASH XML: {0}")]
    Xml(String),
    #[error("manifest does not contain an MPD root")]
    MissingMpd,
}

#[derive(Clone, Copy)]
enum BaseUrlTarget {
    Adaptation,
    Representation,
}

pub fn parse_dash(body: &str) -> Result<DashManifest, DashError> {
    if body.trim().is_empty() {
        return Err(DashError::EmptyManifest);
    }

    let mut reader = Reader::from_str(body);
    reader.config_mut().trim_text(true);

    let mut manifest = DashManifest::default();
    let mut saw_mpd = false;
    let mut current_period: Option<DashPeriod> = None;
    let mut current_adaptation: Option<DashAdaptationSet> = None;
    let mut current_representation: Option<DashRepresentation> = None;
    let mut base_url_target: Option<BaseUrlTarget> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => match local_name(event.name().as_ref()) {
                b"MPD" => {
                    saw_mpd = true;
                    apply_mpd_attributes(&event, &mut manifest);
                }
                b"Period" => {
                    current_period = Some(DashPeriod {
                        id: attribute(&event, b"id"),
                        adaptations: Vec::new(),
                    });
                }
                b"AdaptationSet" => {
                    current_adaptation = Some(parse_adaptation(&event));
                }
                b"Representation" => {
                    current_representation = Some(parse_representation(&event));
                }
                b"SegmentTemplate" => {
                    let template = parse_segment_template(&event);
                    if let Some(representation) = current_representation.as_mut() {
                        representation.segment_template = Some(template);
                    } else if let Some(adaptation) = current_adaptation.as_mut() {
                        adaptation.segment_template = Some(template);
                    }
                }
                b"BaseURL" => {
                    base_url_target = if current_representation.is_some() {
                        Some(BaseUrlTarget::Representation)
                    } else if current_adaptation.is_some() {
                        Some(BaseUrlTarget::Adaptation)
                    } else {
                        None
                    };
                }
                _ => {}
            },
            Ok(Event::Empty(event)) => match local_name(event.name().as_ref()) {
                b"SegmentTemplate" => {
                    let template = parse_segment_template(&event);
                    if let Some(representation) = current_representation.as_mut() {
                        representation.segment_template = Some(template);
                    } else if let Some(adaptation) = current_adaptation.as_mut() {
                        adaptation.segment_template = Some(template);
                    }
                }
                b"Representation" => {
                    if let Some(adaptation) = current_adaptation.as_mut() {
                        adaptation.representations.push(parse_representation(&event));
                    }
                }
                _ => {}
            },
            Ok(Event::Text(text)) => {
                if let Some(target) = base_url_target {
                    let value = String::from_utf8_lossy(text.as_ref()).trim().to_owned();
                    if !value.is_empty() {
                        match target {
                            BaseUrlTarget::Representation => {
                                if let Some(representation) = current_representation.as_mut() {
                                    representation.base_url = Some(value);
                                }
                            }
                            BaseUrlTarget::Adaptation => {
                                if let Some(adaptation) = current_adaptation.as_mut() {
                                    adaptation.base_url = Some(value);
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::End(event)) => match local_name(event.name().as_ref()) {
                b"BaseURL" => base_url_target = None,
                b"Representation" => {
                    if let (Some(representation), Some(adaptation)) = (
                        current_representation.take(),
                        current_adaptation.as_mut(),
                    ) {
                        adaptation.representations.push(representation);
                    }
                }
                b"AdaptationSet" => {
                    if let (Some(adaptation), Some(period)) =
                        (current_adaptation.take(), current_period.as_mut())
                    {
                        period.adaptations.push(adaptation);
                    }
                }
                b"Period" => {
                    if let Some(period) = current_period.take() {
                        manifest.periods.push(period);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(error) => return Err(DashError::Xml(error.to_string())),
            _ => {}
        }
    }

    if !saw_mpd {
        return Err(DashError::MissingMpd);
    }

    Ok(manifest)
}

fn apply_mpd_attributes(event: &BytesStart<'_>, manifest: &mut DashManifest) {
    manifest.is_dynamic = attribute(event, b"type")
        .is_some_and(|value| value.eq_ignore_ascii_case("dynamic"));
    manifest.minimum_update_period = attribute(event, b"minimumUpdatePeriod");
    manifest.media_presentation_duration = attribute(event, b"mediaPresentationDuration");
}

fn parse_adaptation(event: &BytesStart<'_>) -> DashAdaptationSet {
    DashAdaptationSet {
        id: attribute(event, b"id"),
        content_type: attribute(event, b"contentType"),
        mime_type: attribute(event, b"mimeType"),
        language: attribute(event, b"lang"),
        codecs: attribute(event, b"codecs"),
        base_url: None,
        segment_template: None,
        representations: Vec::new(),
    }
}

fn parse_representation(event: &BytesStart<'_>) -> DashRepresentation {
    DashRepresentation {
        id: attribute(event, b"id"),
        bandwidth: attribute(event, b"bandwidth").and_then(|value| value.parse().ok()),
        width: attribute(event, b"width").and_then(|value| value.parse().ok()),
        height: attribute(event, b"height").and_then(|value| value.parse().ok()),
        frame_rate: attribute(event, b"frameRate"),
        codecs: attribute(event, b"codecs"),
        mime_type: attribute(event, b"mimeType"),
        base_url: None,
        segment_template: None,
    }
}

fn parse_segment_template(event: &BytesStart<'_>) -> DashSegmentTemplate {
    DashSegmentTemplate {
        timescale: attribute(event, b"timescale").and_then(|value| value.parse().ok()),
        duration: attribute(event, b"duration").and_then(|value| value.parse().ok()),
        start_number: attribute(event, b"startNumber").and_then(|value| value.parse().ok()),
        media: attribute(event, b"media"),
        initialization: attribute(event, b"initialization"),
    }
}

fn attribute(event: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    event
        .attributes()
        .with_checks(false)
        .flatten()
        .find_map(|attribute| {
            (local_name(attribute.key.as_ref()) == key)
                .then(|| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
        })
}

fn local_name(name: &[u8]) -> &[u8] {
    name.rsplit(|byte| *byte == b':').next().unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_static_audio_and_video_representations() {
        let manifest = parse_dash(
            r#"<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT30S">
  <Period id="p0">
    <AdaptationSet id="v" contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" duration="5000" startNumber="1" media="v-$Number$.m4s" initialization="v-init.mp4"/>
      <Representation id="1080" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet id="a" contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="audio" bandwidth="128000" codecs="mp4a.40.2">
        <BaseURL>audio.m4a</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>"#,
        )
        .expect("dash");

        assert!(!manifest.is_dynamic);
        assert_eq!(manifest.periods.len(), 1);
        assert_eq!(manifest.periods[0].adaptations.len(), 2);

        let video = &manifest.periods[0].adaptations[0];
        assert_eq!(video.content_type.as_deref(), Some("video"));
        assert_eq!(video.representations[0].height, Some(1080));
        assert_eq!(
            video.segment_template.as_ref().and_then(|template| template.duration),
            Some(5000)
        );

        let audio = &manifest.periods[0].adaptations[1];
        assert_eq!(audio.language.as_deref(), Some("en"));
        assert_eq!(
            audio.representations[0].base_url.as_deref(),
            Some("audio.m4a")
        );
    }

    #[test]
    fn parses_dynamic_mpd_metadata() {
        let manifest = parse_dash(
            r#"<MPD type="dynamic" minimumUpdatePeriod="PT5S"><Period/></MPD>"#,
        )
        .expect("dynamic dash");

        assert!(manifest.is_dynamic);
        assert_eq!(manifest.minimum_update_period.as_deref(), Some("PT5S"));
    }

    #[test]
    fn rejects_non_mpd_xml() {
        assert_eq!(
            parse_dash("<root/>"),
            Err(DashError::MissingMpd)
        );
    }
}
