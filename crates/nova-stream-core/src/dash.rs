use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashTimelineEntry {
    pub start_time: Option<u64>,
    pub duration: u64,
    pub repeat: i64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashSegmentTemplate {
    pub timescale: Option<u64>,
    pub duration: Option<u64>,
    pub start_number: Option<u64>,
    pub media: Option<String>,
    pub initialization: Option<String>,
    #[serde(default)]
    pub timeline: Vec<DashTimelineEntry>,
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
    let mut inside_segment_timeline = false;

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
                b"SegmentTimeline" => inside_segment_timeline = true,
                b"S" if inside_segment_timeline => {
                    if let Some(entry) = parse_timeline_entry(&event) {
                        if let Some(template) = active_segment_template_mut(
                            &mut current_representation,
                            &mut current_adaptation,
                        ) {
                            template.timeline.push(entry);
                        }
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
                b"S" if inside_segment_timeline => {
                    if let Some(entry) = parse_timeline_entry(&event) {
                        if let Some(template) = active_segment_template_mut(
                            &mut current_representation,
                            &mut current_adaptation,
                        ) {
                            template.timeline.push(entry);
                        }
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
                b"SegmentTimeline" => inside_segment_timeline = false,
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
        timeline: Vec::new(),
    }
}

fn parse_timeline_entry(event: &BytesStart<'_>) -> Option<DashTimelineEntry> {
    Some(DashTimelineEntry {
        start_time: attribute(event, b"t").and_then(|value| value.parse().ok()),
        duration: attribute(event, b"d")?.parse().ok()?,
        repeat: attribute(event, b"r")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
    })
}

fn active_segment_template_mut<'a>(
    representation: &'a mut Option<DashRepresentation>,
    adaptation: &'a mut Option<DashAdaptationSet>,
) -> Option<&'a mut DashSegmentTemplate> {
    if let Some(representation) = representation.as_mut() {
        representation.segment_template.as_mut()
    } else {
        adaptation
            .as_mut()
            .and_then(|adaptation| adaptation.segment_template.as_mut())
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DashTrackKind {
    Video,
    Audio,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashTransferUnit {
    pub order: u64,
    pub url: String,
    pub initialization: bool,
    pub number: Option<u64>,
    pub time: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DashRepresentationPlan {
    pub representation_id: Option<String>,
    pub track_kind: DashTrackKind,
    pub bandwidth: Option<u64>,
    pub units: Vec<DashTransferUnit>,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum DashPlanError {
    #[error("dynamic DASH without SegmentTimeline requires the live refresh scheduler")]
    DynamicManifest,
    #[error("DASH SegmentTimeline repeat is invalid or cannot be bounded")]
    InvalidTimelineRepeat,
    #[error("DASH adaptation set index is out of range")]
    MissingAdaptation,
    #[error("DASH representation index is out of range")]
    MissingRepresentation,
    #[error("DASH manifest URL is invalid")]
    InvalidManifestUrl,
    #[error("DASH SegmentTemplate has no media template")]
    MissingMediaTemplate,
    #[error("DASH fixed-duration SegmentTemplate requires duration/timescale metadata")]
    MissingSegmentTiming,
    #[error("DASH MPD is missing mediaPresentationDuration")]
    MissingPresentationDuration,
    #[error("unsupported DASH duration value: {0}")]
    InvalidPresentationDuration(String),
    #[error("DASH template requires a representation id")]
    MissingRepresentationId,
    #[error("DASH template requires a representation bandwidth")]
    MissingBandwidth,
    #[error("DASH template token is unsupported: {0}")]
    UnsupportedTemplateToken(String),
}

pub fn select_best_dash_representation(
    adaptation: &DashAdaptationSet,
) -> Option<&DashRepresentation> {
    adaptation.representations.iter().max_by_key(|representation| {
        (
            u64::from(representation.width.unwrap_or(0))
                * u64::from(representation.height.unwrap_or(0)),
            representation.bandwidth.unwrap_or(0),
        )
    })
}

/// Build a native transfer plan for a static DASH representation.
///
/// This first planner supports direct BaseURL resources and fixed-duration
/// SegmentTemplate MPDs. SegmentTimeline/dynamic refresh are intentionally
/// separate extensions rather than silently approximated.
pub fn build_dash_representation_plan(
    manifest: &DashManifest,
    manifest_url: &str,
    period_index: usize,
    adaptation_index: usize,
    representation_index: usize,
) -> Result<DashRepresentationPlan, DashPlanError> {
    let period = manifest
        .periods
        .get(period_index)
        .ok_or(DashPlanError::MissingAdaptation)?;
    let adaptation = period
        .adaptations
        .get(adaptation_index)
        .ok_or(DashPlanError::MissingAdaptation)?;
    let representation = adaptation
        .representations
        .get(representation_index)
        .ok_or(DashPlanError::MissingRepresentation)?;

    let mut base =
        Url::parse(manifest_url).map_err(|_| DashPlanError::InvalidManifestUrl)?;
    if let Some(adaptation_base) = &adaptation.base_url {
        base = base
            .join(adaptation_base)
            .map_err(|_| DashPlanError::InvalidManifestUrl)?;
    }
    if let Some(representation_base) = &representation.base_url {
        base = base
            .join(representation_base)
            .map_err(|_| DashPlanError::InvalidManifestUrl)?;
    }

    let track_kind = dash_track_kind(adaptation, representation);
    let template = representation
        .segment_template
        .as_ref()
        .or(adaptation.segment_template.as_ref());

    let Some(template) = template else {
        if manifest.is_dynamic {
            return Err(DashPlanError::DynamicManifest);
        }
        return Ok(DashRepresentationPlan {
            representation_id: representation.id.clone(),
            track_kind,
            bandwidth: representation.bandwidth,
            units: vec![DashTransferUnit {
                order: 0,
                url: base.to_string(),
                initialization: false,
                number: None,
                time: None,
            }],
        });
    };

    let media_template = template
        .media
        .as_deref()
        .ok_or(DashPlanError::MissingMediaTemplate)?;
    let timescale = template.timescale.unwrap_or(1);
    if timescale == 0 {
        return Err(DashPlanError::MissingSegmentTiming);
    }

    let start_number = template.start_number.unwrap_or(1);
    let mut units = Vec::new();
    let mut order = 0_u64;

    if let Some(initialization) = template.initialization.as_deref() {
        let rendered = render_dash_template(initialization, representation, None, None)?;
        let url = base
            .join(&rendered)
            .map_err(|_| DashPlanError::InvalidManifestUrl)?
            .to_string();
        units.push(DashTransferUnit {
            order,
            url,
            initialization: true,
            number: None,
            time: None,
        });
        order += 1;
    }

    if !template.timeline.is_empty() {
        append_timeline_units(
            manifest,
            template,
            media_template,
            representation,
            &base,
            start_number,
            &mut order,
            &mut units,
        )?;
    } else {
        if manifest.is_dynamic {
            return Err(DashPlanError::DynamicManifest);
        }
        let segment_duration = template.duration.ok_or(DashPlanError::MissingSegmentTiming)?;
        if segment_duration == 0 {
            return Err(DashPlanError::MissingSegmentTiming);
        }

        let duration_text = manifest
            .media_presentation_duration
            .as_deref()
            .ok_or(DashPlanError::MissingPresentationDuration)?;
        let total_millis = parse_iso8601_duration_millis(duration_text)
            .ok_or_else(|| DashPlanError::InvalidPresentationDuration(duration_text.to_owned()))?;
        let numerator = u128::from(total_millis) * u128::from(timescale);
        let denominator = u128::from(segment_duration) * 1000;
        let segment_count = numerator
            .saturating_add(denominator.saturating_sub(1))
            / denominator;
        let segment_count = u64::try_from(segment_count).unwrap_or(u64::MAX);

        for offset in 0..segment_count {
            let number = start_number.saturating_add(offset);
            let rendered =
                render_dash_template(media_template, representation, Some(number), None)?;
            let url = base
                .join(&rendered)
                .map_err(|_| DashPlanError::InvalidManifestUrl)?
                .to_string();
            units.push(DashTransferUnit {
                order,
                url,
                initialization: false,
                number: Some(number),
                time: None,
            });
            order += 1;
        }
    }

    Ok(DashRepresentationPlan {
        representation_id: representation.id.clone(),
        track_kind,
        bandwidth: representation.bandwidth,
        units,
    })
}

fn append_timeline_units(
    manifest: &DashManifest,
    template: &DashSegmentTemplate,
    media_template: &str,
    representation: &DashRepresentation,
    base: &Url,
    start_number: u64,
    order: &mut u64,
    units: &mut Vec<DashTransferUnit>,
) -> Result<(), DashPlanError> {
    let timescale = template.timescale.unwrap_or(1);
    let presentation_units = manifest
        .media_presentation_duration
        .as_deref()
        .and_then(parse_iso8601_duration_millis)
        .map(|millis| (u128::from(millis) * u128::from(timescale)) / 1000)
        .and_then(|value| u64::try_from(value).ok());

    let mut current_time = 0_u64;
    let mut number = start_number;

    for (index, entry) in template.timeline.iter().enumerate() {
        if entry.duration == 0 {
            return Err(DashPlanError::MissingSegmentTiming);
        }
        if let Some(start_time) = entry.start_time {
            current_time = start_time;
        }

        let repeat_count = if entry.repeat >= 0 {
            u64::try_from(entry.repeat).unwrap_or(0)
        } else if entry.repeat == -1 {
            let boundary = template
                .timeline
                .get(index + 1)
                .and_then(|next| next.start_time)
                .or(presentation_units)
                .ok_or(DashPlanError::InvalidTimelineRepeat)?;
            if boundary <= current_time {
                return Err(DashPlanError::InvalidTimelineRepeat);
            }
            boundary
                .saturating_sub(current_time)
                .saturating_sub(1)
                / entry.duration
        } else {
            return Err(DashPlanError::InvalidTimelineRepeat);
        };

        for _ in 0..=repeat_count {
            let rendered = render_dash_template(
                media_template,
                representation,
                Some(number),
                Some(current_time),
            )?;
            let url = base
                .join(&rendered)
                .map_err(|_| DashPlanError::InvalidManifestUrl)?
                .to_string();
            units.push(DashTransferUnit {
                order: *order,
                url,
                initialization: false,
                number: Some(number),
                time: Some(current_time),
            });
            *order = (*order).saturating_add(1);
            number = number.saturating_add(1);
            current_time = current_time.saturating_add(entry.duration);
        }
    }

    Ok(())
}

fn dash_track_kind(
    adaptation: &DashAdaptationSet,
    representation: &DashRepresentation,
) -> DashTrackKind {
    let kind = adaptation
        .content_type
        .as_deref()
        .or_else(|| adaptation.mime_type.as_deref())
        .or_else(|| representation.mime_type.as_deref())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if kind.starts_with("video") {
        DashTrackKind::Video
    } else if kind.starts_with("audio") {
        DashTrackKind::Audio
    } else {
        DashTrackKind::Other
    }
}

fn render_dash_template(
    template: &str,
    representation: &DashRepresentation,
    number: Option<u64>,
    time: Option<u64>,
) -> Result<String, DashPlanError> {
    let mut output = String::with_capacity(template.len() + 16);
    let mut rest = template;

    while let Some(start) = rest.find('$') {
        output.push_str(&rest[..start]);
        rest = &rest[start + 1..];

        if rest.starts_with('$') {
            output.push('$');
            rest = &rest[1..];
            continue;
        }

        let end = rest
            .find('$')
            .ok_or_else(|| DashPlanError::UnsupportedTemplateToken(rest.to_owned()))?;
        let token = &rest[..end];
        rest = &rest[end + 1..];

        match token {
            "RepresentationID" => output.push_str(
                representation
                    .id
                    .as_deref()
                    .ok_or(DashPlanError::MissingRepresentationId)?,
            ),
            "Bandwidth" => output.push_str(
                &representation
                    .bandwidth
                    .ok_or(DashPlanError::MissingBandwidth)?
                    .to_string(),
            ),
            "Number" => output.push_str(
                &number
                    .ok_or_else(|| DashPlanError::UnsupportedTemplateToken(token.to_owned()))?
                    .to_string(),
            ),
            "Time" => output.push_str(
                &time
                    .ok_or_else(|| DashPlanError::UnsupportedTemplateToken(token.to_owned()))?
                    .to_string(),
            ),
            _ if token.starts_with("Number%0") && token.ends_with('d') => {
                let width = token
                    .strip_prefix("Number%0")
                    .and_then(|value| value.strip_suffix('d'))
                    .and_then(|value| value.parse::<usize>().ok())
                    .ok_or_else(|| DashPlanError::UnsupportedTemplateToken(token.to_owned()))?;
                let number = number
                    .ok_or_else(|| DashPlanError::UnsupportedTemplateToken(token.to_owned()))?;
                output.push_str(&format!("{number:0width$}"));
            }
            _ => return Err(DashPlanError::UnsupportedTemplateToken(token.to_owned())),
        }
    }

    output.push_str(rest);
    Ok(output)
}

fn parse_iso8601_duration_millis(value: &str) -> Option<u64> {
    let rest = value.strip_prefix("PT")?;
    if rest.is_empty() {
        return None;
    }

    let mut number = String::new();
    let mut total_seconds = 0_f64;
    for character in rest.chars() {
        if character.is_ascii_digit() || character == '.' {
            number.push(character);
            continue;
        }

        let value = number.parse::<f64>().ok()?;
        number.clear();
        match character {
            'H' => total_seconds += value * 3600.0,
            'M' => total_seconds += value * 60.0,
            'S' => total_seconds += value,
            _ => return None,
        }
    }

    if !number.is_empty() || !total_seconds.is_finite() || total_seconds < 0.0 {
        return None;
    }

    let millis = total_seconds * 1000.0;
    if millis > u64::MAX as f64 {
        None
    } else {
        Some(millis.round() as u64)
    }
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

    #[test]
    fn selects_best_dash_representation_by_resolution() {
        let adaptation = DashAdaptationSet {
            content_type: Some("video".to_owned()),
            representations: vec![
                DashRepresentation {
                    id: Some("720".to_owned()),
                    bandwidth: Some(8_000_000),
                    width: Some(1280),
                    height: Some(720),
                    ..DashRepresentation::default()
                },
                DashRepresentation {
                    id: Some("1080".to_owned()),
                    bandwidth: Some(5_000_000),
                    width: Some(1920),
                    height: Some(1080),
                    ..DashRepresentation::default()
                },
            ],
            ..DashAdaptationSet::default()
        };

        assert_eq!(
            select_best_dash_representation(&adaptation)
                .and_then(|representation| representation.id.as_deref()),
            Some("1080")
        );
    }

    #[test]
    fn plans_fixed_duration_dash_template() {
        let manifest = parse_dash(
            r#"<MPD type="static" mediaPresentationDuration="PT10S">
<Period><AdaptationSet contentType="video">
<SegmentTemplate timescale="1" duration="4" startNumber="5"
 initialization="init-$RepresentationID$.mp4"
 media="chunk-$Number%03d$-$Bandwidth$.m4s"/>
<Representation id="v1" bandwidth="2000" width="1920" height="1080"/>
</AdaptationSet></Period></MPD>"#,
        )
        .expect("dash");

        let plan = build_dash_representation_plan(
            &manifest,
            "https://cdn.test/path/manifest.mpd",
            0,
            0,
            0,
        )
        .expect("DASH plan");

        assert_eq!(plan.units.len(), 4);
        assert_eq!(
            plan.units[0].url,
            "https://cdn.test/path/init-v1.mp4"
        );
        assert_eq!(
            plan.units[1].url,
            "https://cdn.test/path/chunk-005-2000.m4s"
        );
        assert_eq!(plan.units[3].number, Some(7));
    }

    #[test]
    fn parses_and_plans_segment_timeline_with_time_tokens() {
        let manifest = parse_dash(
            r#"<MPD type="static" mediaPresentationDuration="PT8S">
<Period><AdaptationSet contentType="video">
<SegmentTemplate timescale="1000" startNumber="10"
 initialization="init-$RepresentationID$.mp4"
 media="chunk-$Time$-$Number$.m4s">
<SegmentTimeline>
<S t="0" d="2000" r="2"/>
<S d="2000"/>
</SegmentTimeline>
</SegmentTemplate>
<Representation id="v1" bandwidth="3000"/>
</AdaptationSet></Period></MPD>"#,
        )
        .expect("timeline dash");

        let timeline = &manifest.periods[0].adaptations[0]
            .segment_template
            .as_ref()
            .expect("template")
            .timeline;
        assert_eq!(timeline.len(), 2);
        assert_eq!(timeline[0].repeat, 2);

        let plan = build_dash_representation_plan(
            &manifest,
            "https://cdn.test/live/manifest.mpd",
            0,
            0,
            0,
        )
        .expect("timeline plan");

        assert_eq!(plan.units.len(), 5);
        assert_eq!(plan.units[1].time, Some(0));
        assert_eq!(plan.units[2].time, Some(2000));
        assert_eq!(
            plan.units[3].url,
            "https://cdn.test/live/chunk-4000-12.m4s"
        );
        assert_eq!(plan.units[4].time, Some(6000));
    }

    #[test]
    fn bounds_negative_timeline_repeat_using_next_start() {
        let manifest = parse_dash(
            r#"<MPD type="dynamic" minimumUpdatePeriod="PT2S">
<Period><AdaptationSet contentType="audio">
<SegmentTemplate timescale="1" media="$Time$.m4s">
<SegmentTimeline><S t="10" d="2" r="-1"/><S t="16" d="2"/></SegmentTimeline>
</SegmentTemplate>
<Representation id="a1" bandwidth="128000"/>
</AdaptationSet></Period></MPD>"#,
        )
        .expect("dynamic timeline");

        let plan = build_dash_representation_plan(
            &manifest,
            "https://cdn.test/manifest.mpd",
            0,
            0,
            0,
        )
        .expect("dynamic timeline snapshot");

        let times: Vec<_> = plan
            .units
            .iter()
            .filter_map(|unit| unit.time)
            .collect();
        assert_eq!(times, vec![10, 12, 14, 16]);
    }

    #[test]
    fn parses_fractional_iso_duration() {
        assert_eq!(parse_iso8601_duration_millis("PT1M2.5S"), Some(62_500));
    }
}
