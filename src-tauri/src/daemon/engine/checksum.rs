use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

const BUFFER_SIZE: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ChecksumAlgorithm {
    Sha256,
    Sha1,
    Md5,
}

impl ChecksumAlgorithm {
    pub fn name(&self) -> &str {
        match self {
            ChecksumAlgorithm::Sha256 => "sha256",
            ChecksumAlgorithm::Sha1 => "sha1",
            ChecksumAlgorithm::Md5 => "md5",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_lowercase().as_str() {
            "sha256" | "sha-256" => Some(ChecksumAlgorithm::Sha256),
            "sha1" | "sha-1" => Some(ChecksumAlgorithm::Sha1),
            "md5" => Some(ChecksumAlgorithm::Md5),
            _ => None,
        }
    }

    pub fn hex_length(&self) -> usize {
        match self {
            ChecksumAlgorithm::Sha256 => 64,
            ChecksumAlgorithm::Sha1 => 40,
            ChecksumAlgorithm::Md5 => 32,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ChecksumResult {
    pub algorithm: ChecksumAlgorithm,
    pub expected: String,
    pub actual: String,
    pub passed: bool,
}

pub fn compute_checksum(path: &Path, algorithm: &ChecksumAlgorithm) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|e| format!("Failed to open file for checksum: {}", e))?;
    match algorithm {
        ChecksumAlgorithm::Sha256 => {
            let mut hasher = Sha256::new();
            let mut buffer = [0u8; BUFFER_SIZE];
            loop {
                let bytes_read = file
                    .read(&mut buffer)
                    .map_err(|e| format!("Read error during SHA-256: {}", e))?;
                if bytes_read == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes_read]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        }
        ChecksumAlgorithm::Sha1 => {
            let mut hasher = Sha1::new();
            let mut buffer = [0u8; BUFFER_SIZE];
            loop {
                let bytes_read = file
                    .read(&mut buffer)
                    .map_err(|e| format!("Read error during SHA-1: {}", e))?;
                if bytes_read == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes_read]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        }
        ChecksumAlgorithm::Md5 => {
            let mut hasher = Md5::new();
            let mut buffer = [0u8; BUFFER_SIZE];
            loop {
                let bytes_read = file
                    .read(&mut buffer)
                    .map_err(|e| format!("Read error during MD5: {}", e))?;
                if bytes_read == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes_read]);
            }
            Ok(format!("{:x}", hasher.finalize()))
        }
    }
}

pub fn verify_checksum(
    path: &Path,
    algorithm: &ChecksumAlgorithm,
    expected_hex: &str,
) -> ChecksumResult {
    let actual = match compute_checksum(path, algorithm) {
        Ok(h) => h,
        Err(_) => {
            return ChecksumResult {
                algorithm: *algorithm,
                expected: expected_hex.to_string(),
                actual: "error".to_string(),
                passed: false,
            }
        }
    };
    let expected_clean = expected_hex.trim().to_lowercase();
    let passed = actual == expected_clean;
    ChecksumResult {
        algorithm: *algorithm,
        expected: expected_clean,
        actual,
        passed,
    }
}

pub fn detect_algorithm_from_hex(hex: &str) -> Option<ChecksumAlgorithm> {
    let clean = hex.trim();
    if clean.chars().all(|c| c.is_ascii_hexdigit()) {
        match clean.len() {
            64 => Some(ChecksumAlgorithm::Sha256),
            40 => Some(ChecksumAlgorithm::Sha1),
            32 => Some(ChecksumAlgorithm::Md5),
            _ => None,
        }
    } else {
        None
    }
}

pub fn auto_verify(path: &Path, expected_hex: &str) -> Option<ChecksumResult> {
    let algo = detect_algorithm_from_hex(expected_hex)?;
    Some(verify_checksum(path, &algo, expected_hex))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_test_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nova_checksum_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(name);
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);
        path
    }

    #[test]
    fn test_sha256_empty_file() {
        let path = make_test_file("empty.bin");
        let result = compute_checksum(&path, &ChecksumAlgorithm::Sha256).unwrap();
        assert_eq!(
            result,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_sha1_hello_world() {
        let path = make_test_file("sha1.bin");
        let result = compute_checksum(&path, &ChecksumAlgorithm::Sha1).unwrap();
        assert_eq!(result, "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
    }

    #[test]
    fn test_md5_hello_world() {
        let path = make_test_file("md5.bin");
        let result = compute_checksum(&path, &ChecksumAlgorithm::Md5).unwrap();
        assert_eq!(result, "5eb63bbbe01eeed093cb22bb8f5acdc3");
    }

    #[test]
    fn test_from_name() {
        assert_eq!(
            ChecksumAlgorithm::from_name("sha256"),
            Some(ChecksumAlgorithm::Sha256)
        );
        assert_eq!(
            ChecksumAlgorithm::from_name("sha-256"),
            Some(ChecksumAlgorithm::Sha256)
        );
        assert_eq!(
            ChecksumAlgorithm::from_name("SHA256"),
            Some(ChecksumAlgorithm::Sha256)
        );
        assert_eq!(
            ChecksumAlgorithm::from_name("sha1"),
            Some(ChecksumAlgorithm::Sha1)
        );
        assert_eq!(
            ChecksumAlgorithm::from_name("sha-1"),
            Some(ChecksumAlgorithm::Sha1)
        );
        assert_eq!(
            ChecksumAlgorithm::from_name("md5"),
            Some(ChecksumAlgorithm::Md5)
        );
        assert_eq!(
            ChecksumAlgorithm::from_name("MD5"),
            Some(ChecksumAlgorithm::Md5)
        );
        assert_eq!(ChecksumAlgorithm::from_name("invalid"), None);
        assert_eq!(ChecksumAlgorithm::from_name(""), None);
    }

    #[test]
    fn test_name() {
        assert_eq!(ChecksumAlgorithm::Sha256.name(), "sha256");
        assert_eq!(ChecksumAlgorithm::Sha1.name(), "sha1");
        assert_eq!(ChecksumAlgorithm::Md5.name(), "md5");
    }

    #[test]
    fn test_hex_length() {
        assert_eq!(ChecksumAlgorithm::Sha256.hex_length(), 64);
        assert_eq!(ChecksumAlgorithm::Sha1.hex_length(), 40);
        assert_eq!(ChecksumAlgorithm::Md5.hex_length(), 32);
    }

    #[test]
    fn test_detect_sha256() {
        let hex = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert_eq!(
            detect_algorithm_from_hex(hex),
            Some(ChecksumAlgorithm::Sha256)
        );
    }

    #[test]
    fn test_detect_sha1() {
        let hex = "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed";
        assert_eq!(
            detect_algorithm_from_hex(hex),
            Some(ChecksumAlgorithm::Sha1)
        );
    }

    #[test]
    fn test_detect_md5() {
        let hex = "5eb63bbbe01eeed093cb22bb8f5acdc3";
        assert_eq!(detect_algorithm_from_hex(hex), Some(ChecksumAlgorithm::Md5));
    }

    #[test]
    fn test_detect_invalid_length() {
        assert_eq!(detect_algorithm_from_hex("abcdef"), None);
        assert_eq!(detect_algorithm_from_hex("abcd"), None);
        assert_eq!(detect_algorithm_from_hex(""), None);
        assert_eq!(detect_algorithm_from_hex("a".repeat(33).as_str()), None);
        assert_eq!(detect_algorithm_from_hex("a".repeat(41).as_str()), None);
        assert_eq!(detect_algorithm_from_hex("a".repeat(65).as_str()), None);
    }

    #[test]
    fn test_detect_non_hex_chars() {
        assert_eq!(
            detect_algorithm_from_hex("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
            None
        );
        assert_eq!(
            detect_algorithm_from_hex(
                "g94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
            ),
            None
        );
        assert_eq!(
            detect_algorithm_from_hex("2aae6c35c94fcfb415dbe95f408b9ce91ee846eg"),
            None
        );
    }

    #[test]
    fn test_verify_checksum_matching() {
        let path = make_test_file("verify_ok.bin");
        let result = verify_checksum(
            &path,
            &ChecksumAlgorithm::Sha256,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        );
        assert!(result.passed);
        assert_eq!(result.actual, result.expected);
        assert_eq!(result.algorithm, ChecksumAlgorithm::Sha256);
    }

    #[test]
    fn test_verify_checksum_wrong_hash() {
        let path = make_test_file("verify_bad.bin");
        let result = verify_checksum(
            &path,
            &ChecksumAlgorithm::Sha256,
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        assert!(!result.passed);
        assert_eq!(result.algorithm, ChecksumAlgorithm::Sha256);
        assert_eq!(
            result.actual,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        assert_eq!(
            result.expected,
            "0000000000000000000000000000000000000000000000000000000000000000"
        );
    }

    #[test]
    fn test_auto_verify() {
        let path = make_test_file("auto_verify.bin");
        let sha256 = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        let sha1 = "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed";
        let md5 = "5eb63bbbe01eeed093cb22bb8f5acdc3";

        let r1 = auto_verify(&path, sha256).unwrap();
        assert!(r1.passed);
        assert_eq!(r1.algorithm, ChecksumAlgorithm::Sha256);

        let r2 = auto_verify(&path, sha1).unwrap();
        assert!(r2.passed);
        assert_eq!(r2.algorithm, ChecksumAlgorithm::Sha1);

        let r3 = auto_verify(&path, md5).unwrap();
        assert!(r3.passed);
        assert_eq!(r3.algorithm, ChecksumAlgorithm::Md5);

        assert!(auto_verify(&path, "abcdef").is_none());
        assert!(auto_verify(&path, "not_hex_at_all!").is_none());
    }
}
