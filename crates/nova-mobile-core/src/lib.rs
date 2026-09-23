//! Android-safe mobile facade over NOVA's shared download core.
//!
//! This layer intentionally accepts an app-private root plus a relative path,
//! rather than arbitrary filesystem destinations. Public/shared storage remains
//! an Android adapter concern and will be handed to the core through a bounded
//! descriptor interface in a later milestone.

use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MobileTransferOutcome {
    pub final_bytes: u64,
    pub total_bytes: Option<u64>,
    pub resumed_from: u64,
    pub effective_url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MobileTransferError {
    #[error("invalid app-private relative destination")]
    InvalidRelativeDestination,
    #[error("app-private destination escaped its configured root")]
    DestinationEscapedRoot,
    #[error("shared NOVA transfer failed: {message}")]
    TransferFailed { message: String },
}

fn validated_app_private_destination(
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<PathBuf, MobileTransferError> {
    if relative_destination.as_os_str().is_empty() || relative_destination.is_absolute() {
        return Err(MobileTransferError::InvalidRelativeDestination);
    }

    for component in relative_destination.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(MobileTransferError::InvalidRelativeDestination);
            }
        }
    }

    let destination = app_private_root.join(relative_destination);
    if !destination.starts_with(app_private_root) {
        return Err(MobileTransferError::DestinationEscapedRoot);
    }
    Ok(destination)
}

pub fn download_to_app_private_path(
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    let destination =
        validated_app_private_destination(app_private_root, relative_destination)?;
    let transfer = nova_download_core::download_http_to_path(url, &destination).map_err(|error| {
        MobileTransferError::TransferFailed {
            message: error.to_string(),
        }
    })?;

    Ok(MobileTransferOutcome {
        final_bytes: transfer.final_bytes,
        total_bytes: transfer.total_bytes,
        resumed_from: transfer.resumed_from,
        effective_url: transfer.effective_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_and_parent_traversal_destinations() {
        let root = Path::new("/app/files");
        assert!(matches!(
            validated_app_private_destination(root, Path::new("../escape.part")),
            Err(MobileTransferError::InvalidRelativeDestination)
        ));
        assert!(matches!(
            validated_app_private_destination(root, Path::new("/tmp/escape.part")),
            Err(MobileTransferError::InvalidRelativeDestination)
        ));
    }

    #[test]
    fn accepts_nested_relative_staging_destination() {
        let root = Path::new("/app/files");
        let destination = validated_app_private_destination(
            root,
            Path::new("nova-staging/task-1.part"),
        )
        .expect("valid app-private destination");

        assert_eq!(destination, Path::new("/app/files/nova-staging/task-1.part"));
    }
}
