use std::collections::HashSet;
use std::path::Path;

use crate::daemon::direct::{
    FileWriter, IntegrityMetadata, IntegrityValidator, SegmentRange as ByteRange,
};

pub(super) const fn part_size(range: &ByteRange) -> u64 {
    range.len()
}

pub(super) fn merge_parts(output_path: &Path, ranges: &[ByteRange]) -> Result<u64, String> {
    FileWriter::merge_parts(output_path, ranges)
}

/// Validate that the live segment geometry covers exactly the expected file
/// without gaps, overlaps, inverted ranges, or duplicate segment identities.
///
/// Adaptive split/merge/rebalance decisions can change geometry after the
/// initial transfer plan. Part sizes alone are not enough to prove correctness:
/// two individually complete ranges can still overlap or leave a hole and
/// produce a same-sized but corrupted output when concatenated.
pub(super) fn validate_segment_geometry(
    expected_size: u64,
    ranges: &[ByteRange],
) -> Result<(), String> {
    if expected_size == 0 {
        return if ranges.is_empty() {
            Ok(())
        } else {
            Err("Invalid segment geometry: zero-sized output must not contain segments".to_owned())
        };
    }
    if ranges.is_empty() {
        return Err(format!(
            "Invalid segment geometry: expected {expected_size} bytes but no segments remain"
        ));
    }

    let mut ordered: Vec<&ByteRange> = ranges.iter().collect();
    ordered.sort_by_key(|range| range.start);

    let mut seen_ids = HashSet::with_capacity(ordered.len());
    let mut cursor = 0u64;

    for range in ordered {
        if !seen_ids.insert(range.index) {
            return Err(format!(
                "Invalid segment geometry: duplicate segment id {}",
                range.index
            ));
        }
        if range.end < range.start {
            return Err(format!(
                "Invalid segment geometry: segment {} has inverted range {}..={}",
                range.index, range.start, range.end
            ));
        }
        if range.start > cursor {
            return Err(format!(
                "Invalid segment geometry: gap before segment {} (expected byte {cursor}, found {})",
                range.index, range.start
            ));
        }
        if range.start < cursor {
            return Err(format!(
                "Invalid segment geometry: overlap at segment {} (expected byte {cursor}, found {})",
                range.index, range.start
            ));
        }
        if range.end >= expected_size {
            return Err(format!(
                "Invalid segment geometry: segment {} ends at byte {}, beyond expected output size {expected_size}",
                range.index, range.end
            ));
        }

        cursor = range.end.checked_add(1).ok_or_else(|| {
            format!(
                "Invalid segment geometry: segment {} end offset overflowed",
                range.index
            )
        })?;
    }

    if cursor != expected_size {
        return Err(format!(
            "Invalid segment geometry: ranges cover {cursor} bytes, expected {expected_size}"
        ));
    }

    Ok(())
}

/// Verify the complete on-disk output against a SHA-256 digest supplied by
/// the server or caller. A per-handle streaming digest cannot be authoritative:
/// segmented transfers hash independent ranges, and resumed transfers omit the
/// already-present prefix. The merged output file is the only complete source
/// of truth for integrity verification.
pub(super) fn verify_output_sha256(
    output_path: &Path,
    expected_raw: &str,
) -> Result<String, String> {
    use crate::daemon::engine::checksum::{compute_checksum, ChecksumAlgorithm};

    let actual_hex = compute_checksum(output_path, &ChecksumAlgorithm::Sha256)
        .map_err(|e| format!("Could not calculate SHA-256 for completed output: {e}"))?;
    let expected_value = expected_raw.trim().trim_matches(':');
    // A 64-character hexadecimal SHA-256 is also syntactically valid Base64.
    // Recognize it first; otherwise a hex digest would be decoded as Base64 and
    // transformed into an unrelated, longer byte sequence.
    let expected_hex = if expected_value.len() == 64
        && expected_value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        expected_value.to_ascii_lowercase()
    } else if let Some(bytes) = crate::daemon::utils::base64_decode(expected_value) {
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    } else {
        expected_value.to_owned()
    };
    if !actual_hex.eq_ignore_ascii_case(&expected_hex) {
        return Err(format!(
            "Content-Digest verification failed: expected sha-256={expected_hex}, got {actual_hex}"
        ));
    }
    Ok(actual_hex)
}

/// Validate the final on-disk size against the probed size. Validation is
/// skipped only when the server actually sent content encoding for this
/// transfer, because libcurl writes decompressed bytes to disk.
pub(super) fn validate_transfer_size(
    total_size: u64,
    content_encoded: bool,
    actual: u64,
) -> Result<(), String> {
    IntegrityValidator::new(IntegrityMetadata {
        expected_size: (total_size > 0).then_some(total_size),
        compressed_transfer: content_encoded,
    })
    .validate_size(actual)
}

#[cfg(test)]
mod tests {
    use super::{validate_segment_geometry, verify_output_sha256};
    use crate::daemon::direct::SegmentRange;
    use std::path::PathBuf;

    #[test]
    fn verifies_the_complete_output_not_a_single_segment() {
        use sha2::Digest;

        let dir = std::env::temp_dir().join(format!(
            "nova_complete_digest_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("complete.bin");
        let first_segment = b"first-segment";
        let final_segment = b"final-segment";
        let complete_content = [first_segment.as_slice(), final_segment.as_slice()].concat();
        std::fs::write(&output, &complete_content).unwrap();

        let whole_digest = format!("{:x}", sha2::Sha256::digest(&complete_content));
        let final_segment_digest = format!("{:x}", sha2::Sha256::digest(final_segment));

        assert_eq!(
            verify_output_sha256(&output, &whole_digest).unwrap(),
            whole_digest
        );
        assert!(
            verify_output_sha256(&output, &final_segment_digest).is_err(),
            "a digest for only the last segment must never validate the merged output"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn segment(index: usize, start: u64, end: u64) -> SegmentRange {
        SegmentRange {
            index,
            start,
            end,
            path: PathBuf::from(format!("part-{index}")),
        }
    }

    #[test]
    fn segment_geometry_accepts_complete_unsorted_coverage() {
        let ranges = vec![
            segment(2, 8, 9),
            segment(0, 0, 3),
            segment(1, 4, 7),
        ];
        assert!(validate_segment_geometry(10, &ranges).is_ok());
    }

    #[test]
    fn segment_geometry_rejects_gap() {
        let ranges = vec![segment(0, 0, 3), segment(1, 5, 9)];
        let error = validate_segment_geometry(10, &ranges).unwrap_err();
        assert!(error.contains("gap"));
    }

    #[test]
    fn segment_geometry_rejects_overlap() {
        let ranges = vec![segment(0, 0, 5), segment(1, 5, 9)];
        let error = validate_segment_geometry(10, &ranges).unwrap_err();
        assert!(error.contains("overlap"));
    }

    #[test]
    fn segment_geometry_rejects_duplicate_ids() {
        let ranges = vec![segment(0, 0, 4), segment(0, 5, 9)];
        let error = validate_segment_geometry(10, &ranges).unwrap_err();
        assert!(error.contains("duplicate segment id"));
    }

    #[test]
    fn segment_geometry_rejects_inverted_range() {
        let ranges = vec![segment(0, 0, 4), segment(1, 5, 4)];
        let error = validate_segment_geometry(10, &ranges).unwrap_err();
        assert!(error.contains("inverted range"));
    }
}
