use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssemblyResult {
    pub destination: PathBuf,
    pub bytes: u64,
    pub parts: usize,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum AssemblyError {
    #[error("ordered media assembly requires at least one staged part")]
    Empty,
    #[error("native media assembly I/O failed: {0}")]
    Io(String),
    #[error("duplicate media assembly order {0}")]
    DuplicateOrder(u64),
}

/// Atomically concatenate staged media parts in ascending order.
///
/// This is appropriate for single-representation HLS TS/fMP4 and DASH fMP4
/// streams. Separate audio/video representations still require the later mux
/// stage and must not be passed here as one mixed list.
pub fn assemble_ordered_parts(
    parts: &[(u64, PathBuf)],
    destination: &Path,
) -> Result<AssemblyResult, AssemblyError> {
    if parts.is_empty() {
        return Err(AssemblyError::Empty);
    }

    let mut ordered = parts.to_vec();
    ordered.sort_by_key(|(order, _)| *order);
    for pair in ordered.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(AssemblyError::DuplicateOrder(pair[0].0));
        }
    }

    if let Some(parent) = destination.parent().filter(|path| !path.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|error| AssemblyError::Io(error.to_string()))?;
    }

    let temp = append_suffix(destination, ".nova-assemble.tmp");
    let mut output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp)
        .map_err(|error| AssemblyError::Io(error.to_string()))?;

    let mut total = 0_u64;
    for (_, path) in &ordered {
        let mut input =
            fs::File::open(path).map_err(|error| AssemblyError::Io(error.to_string()))?;
        let copied =
            std::io::copy(&mut input, &mut output).map_err(|error| AssemblyError::Io(error.to_string()))?;
        total = total
            .checked_add(copied)
            .ok_or_else(|| AssemblyError::Io("assembled byte counter overflow".to_owned()))?;
    }

    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| AssemblyError::Io(error.to_string()))?;
    drop(output);

    if destination.exists() {
        fs::remove_file(destination).map_err(|error| AssemblyError::Io(error.to_string()))?;
    }
    fs::rename(&temp, destination).map_err(|error| AssemblyError::Io(error.to_string()))?;

    Ok(AssemblyResult {
        destination: destination.to_path_buf(),
        bytes: total,
        parts: ordered.len(),
    })
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn assembles_parts_in_order_atomically() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nova-assembly-{unique}"));
        fs::create_dir_all(&dir).expect("create assembly dir");

        let first = dir.join("first.part");
        let second = dir.join("second.part");
        fs::write(&first, b"AAA").expect("first");
        fs::write(&second, b"BBBB").expect("second");

        let destination = dir.join("output.bin");
        let result = assemble_ordered_parts(
            &[(1, second), (0, first)],
            &destination,
        )
        .expect("assemble");

        assert_eq!(result.bytes, 7);
        assert_eq!(result.parts, 2);
        assert_eq!(fs::read(&destination).expect("output"), b"AAABBBB");
        assert!(!append_suffix(&destination, ".nova-assemble.tmp").exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_duplicate_order_values() {
        let result = assemble_ordered_parts(
            &[
                (1, PathBuf::from("a")),
                (1, PathBuf::from("b")),
            ],
            Path::new("out"),
        );
        assert_eq!(result, Err(AssemblyError::DuplicateOrder(1)));
    }
}
