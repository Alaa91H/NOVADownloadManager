use crate::InfoHash;
use serde::{Deserialize, Serialize};
use url::Url;

pub const MAX_MAGNET_URI_BYTES: usize = 64 * 1024;
pub const MAX_MAGNET_TRACKERS: usize = 128;
pub const MAX_MAGNET_WEB_SEEDS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct MagnetLink {
    pub info_hash: InfoHash,
    pub display_name: Option<String>,
    pub trackers: Vec<String>,
    pub web_seeds: Vec<String>,
    pub exact_length: Option<u64>,
}

impl MagnetLink {
    pub fn parse(input: &str) -> Result<Self, MagnetParseError> {
        if input.len() > MAX_MAGNET_URI_BYTES {
            return Err(MagnetParseError::UriTooLarge(input.len()));
        }
        let url = Url::parse(input).map_err(|_| MagnetParseError::InvalidUri)?;
        if url.scheme() != "magnet" {
            return Err(MagnetParseError::InvalidScheme(url.scheme().to_owned()));
        }

        let mut info_hash = None;
        let mut display_name = None;
        let mut trackers = Vec::new();
        let mut web_seeds = Vec::new();
        let mut exact_length = None;

        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "xt" => {
                    let Some(encoded) = value.strip_prefix("urn:btih:") else {
                        continue;
                    };
                    let parsed = parse_btih(encoded)?;
                    if info_hash.is_some_and(|existing| existing != parsed) {
                        return Err(MagnetParseError::ConflictingBtih);
                    }
                    info_hash = Some(parsed);
                }
                "dn" if display_name.is_none() => {
                    let value = value.trim();
                    if !value.is_empty() {
                        display_name = Some(value.to_owned());
                    }
                }
                "tr" => {
                    if trackers.len() >= MAX_MAGNET_TRACKERS
                        && !trackers.iter().any(|existing| existing.as_str() == value.as_ref())
                    {
                        return Err(MagnetParseError::TooManyTrackers);
                    }
                    push_unique_url(&mut trackers, value.as_ref(), true)?;
                }
                "ws" | "as" => {
                    if web_seeds.len() >= MAX_MAGNET_WEB_SEEDS
                        && !web_seeds.iter().any(|existing| existing.as_str() == value.as_ref())
                    {
                        return Err(MagnetParseError::TooManyWebSeeds);
                    }
                    push_unique_url(&mut web_seeds, value.as_ref(), false)?;
                }
                "xl" if exact_length.is_none() => {
                    exact_length = Some(
                        value
                            .parse::<u64>()
                            .map_err(|_| MagnetParseError::InvalidExactLength)?,
                    );
                }
                _ => {}
            }
        }

        Ok(Self {
            info_hash: info_hash.ok_or(MagnetParseError::MissingBtih)?,
            display_name,
            trackers,
            web_seeds,
            exact_length,
        })
    }
}

fn parse_btih(encoded: &str) -> Result<InfoHash, MagnetParseError> {
    let bytes = if encoded.len() == 40 {
        decode_hex_20(encoded)?
    } else if encoded.len() == 32 {
        decode_base32_20(encoded)?
    } else {
        return Err(MagnetParseError::InvalidBtih);
    };
    Ok(InfoHash::new(bytes))
}

fn decode_hex_20(input: &str) -> Result<[u8; 20], MagnetParseError> {
    let mut output = [0u8; 20];
    for (index, pair) in input.as_bytes().chunks_exact(2).enumerate() {
        let high = hex_nibble(pair[0]).ok_or(MagnetParseError::InvalidBtih)?;
        let low = hex_nibble(pair[1]).ok_or(MagnetParseError::InvalidBtih)?;
        output[index] = (high << 4) | low;
    }
    Ok(output)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_base32_20(input: &str) -> Result<[u8; 20], MagnetParseError> {
    let mut output = [0u8; 20];
    let mut output_index = 0usize;
    let mut accumulator = 0u32;
    let mut bits = 0u8;

    for byte in input.bytes() {
        let value = match byte.to_ascii_uppercase() {
            b'A'..=b'Z' => byte.to_ascii_uppercase() - b'A',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return Err(MagnetParseError::InvalidBtih),
        };
        accumulator = (accumulator << 5) | u32::from(value);
        bits += 5;

        while bits >= 8 {
            bits -= 8;
            if output_index >= output.len() {
                return Err(MagnetParseError::InvalidBtih);
            }
            output[output_index] = ((accumulator >> bits) & 0xff) as u8;
            output_index += 1;
            accumulator &= (1u32 << bits).saturating_sub(1);
        }
    }

    if output_index != output.len() || bits != 0 {
        return Err(MagnetParseError::InvalidBtih);
    }
    Ok(output)
}

fn push_unique_url(
    output: &mut Vec<String>,
    raw: &str,
    tracker: bool,
) -> Result<(), MagnetParseError> {
    let parsed = Url::parse(raw).map_err(|_| MagnetParseError::InvalidUrl(raw.to_owned()))?;
    let allowed = if tracker {
        matches!(parsed.scheme(), "http" | "https" | "udp")
    } else {
        matches!(parsed.scheme(), "http" | "https")
    };
    if !allowed
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(MagnetParseError::InvalidUrl(raw.to_owned()));
    }
    if !output.iter().any(|existing| existing == raw) {
        output.push(raw.to_owned());
    }
    Ok(())
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum MagnetParseError {
    #[error("invalid magnet URI")]
    InvalidUri,
    #[error("magnet URI exceeds safe size: {0} bytes")]
    UriTooLarge(usize),
    #[error("magnet URI contains too many trackers")]
    TooManyTrackers,
    #[error("magnet URI contains too many web seeds")]
    TooManyWebSeeds,
    #[error("unsupported magnet URI scheme: {0}")]
    InvalidScheme(String),
    #[error("magnet URI is missing an exact topic urn:btih")]
    MissingBtih,
    #[error("magnet URI contains an invalid BitTorrent v1 info hash")]
    InvalidBtih,
    #[error("magnet URI contains conflicting BitTorrent info hashes")]
    ConflictingBtih,
    #[error("magnet URI contains an invalid exact length")]
    InvalidExactLength,
    #[error("magnet URI contains an invalid URL: {0}")]
    InvalidUrl(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hex_btih_and_decodes_query_values() {
        let magnet = MagnetLink::parse(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Linux%20ISO&tr=https%3A%2F%2Ftracker.test%2Fannounce&xl=123",
        )
        .expect("parse magnet");

        assert_eq!(
            magnet.info_hash.to_hex(),
            "0123456789abcdef0123456789abcdef01234567"
        );
        assert_eq!(magnet.display_name.as_deref(), Some("Linux ISO"));
        assert_eq!(magnet.trackers, vec!["https://tracker.test/announce"]);
        assert_eq!(magnet.exact_length, Some(123));
    }

    #[test]
    fn parses_base32_btih() {
        let magnet = MagnetLink::parse(
            "magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH",
        )
        .expect("parse base32 hash");
        assert_eq!(
            magnet.info_hash.to_hex(),
            "0123456789abcdef0123456789abcdef01234567"
        );
    }

    #[test]
    fn rejects_conflicting_hashes() {
        let error = MagnetLink::parse(
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&xt=urn:btih:1123456789abcdef0123456789abcdef01234567",
        )
        .expect_err("conflicting hashes");
        assert_eq!(error, MagnetParseError::ConflictingBtih);
    }

    #[test]
    fn rejects_excessive_tracker_count() {
        let mut value = format!("magnet:?xt=urn:btih:{}", "0".repeat(40));
        for index in 0..=MAX_MAGNET_TRACKERS {
            value.push_str(&format!("&tr=https://tracker-{index}.test/announce"));
        }
        assert_eq!(
            MagnetLink::parse(&value).expect_err("too many trackers"),
            MagnetParseError::TooManyTrackers
        );
    }

    #[test]
    fn rejects_tracker_userinfo() {
        let value = format!(
            "magnet:?xt=urn:btih:{}&tr=https://user:pass@tracker.test/announce",
            "0".repeat(40)
        );
        assert!(matches!(
            MagnetLink::parse(&value),
            Err(MagnetParseError::InvalidUrl(_))
        ));
    }

    #[test]
    fn rejects_oversized_magnet_uri() {
        let value = format!("magnet:?xt=urn:btih:{}&dn={}", "0".repeat(40), "x".repeat(MAX_MAGNET_URI_BYTES));
        assert!(matches!(
            MagnetLink::parse(&value),
            Err(MagnetParseError::UriTooLarge(_))
        ));
    }

    #[test]
    fn rejects_non_magnet_scheme() {
        assert!(matches!(
            MagnetLink::parse("https://example.test/file.torrent"),
            Err(MagnetParseError::InvalidScheme(_))
        ));
    }
}
