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
    use super::verify_output_sha256;

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
}
