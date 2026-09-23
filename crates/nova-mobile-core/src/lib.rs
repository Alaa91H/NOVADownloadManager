//! Android-safe mobile facade over NOVA's shared download core.
//!
//! This layer intentionally accepts an app-private root plus a relative path,
//! rather than arbitrary filesystem destinations. Public/shared storage remains
//! an Android adapter concern and will be handed to the core through a bounded
//! descriptor interface in a later milestone.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

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
    #[error("shared NOVA transfer paused")]
    Paused,
    #[error("shared NOVA transfer cancelled")]
    Cancelled,
    #[error("shared NOVA transfer failed: {message}")]
    TransferFailed { message: String },
}

const CONTROL_CONTINUE: u8 = 0;
const CONTROL_PAUSE: u8 = 1;
const CONTROL_CANCEL: u8 = 2;

/// Conservative mobile default: enough parallelism to saturate ordinary HTTP
/// links without creating the 16–32 simultaneous sockets that can waste radio
/// and battery on a phone. Adaptive scaling is layered on top in a later phase.
pub const MOBILE_DEFAULT_CONNECTIONS: u32 = 8;
pub const MOBILE_MAX_SEGMENTS: u32 = 16;

fn sessions() -> &'static Mutex<HashMap<String, Arc<AtomicU8>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicU8>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_session_control(task_id: &str, control: u8) -> bool {
    sessions()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).cloned())
        .is_some_and(|state| {
            state.store(control, Ordering::Release);
            true
        })
}

pub fn pause_transfer(task_id: &str) -> bool {
    set_session_control(task_id, CONTROL_PAUSE)
}

pub fn cancel_transfer(task_id: &str) -> bool {
    set_session_control(task_id, CONTROL_CANCEL)
}

pub fn is_transfer_active(task_id: &str) -> bool {
    sessions()
        .lock()
        .ok()
        .is_some_and(|map| map.contains_key(task_id))
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
    task_id: &str,
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    if task_id.trim().is_empty() {
        return Err(MobileTransferError::TransferFailed {
            message: "missing native task id".to_owned(),
        });
    }

    let destination =
        validated_app_private_destination(app_private_root, relative_destination)?;
    let control = Arc::new(AtomicU8::new(CONTROL_CONTINUE));

    {
        let mut map = sessions().lock().map_err(|_| MobileTransferError::TransferFailed {
            message: "native transfer session registry is unavailable".to_owned(),
        })?;
        if map.contains_key(task_id) {
            return Err(MobileTransferError::TransferFailed {
                message: "native transfer session is already active".to_owned(),
            });
        }
        map.insert(task_id.to_owned(), Arc::clone(&control));
    }

    let transfer_result = nova_download_core::download_http_to_path_segmented_controlled(
        url,
        &destination,
        MOBILE_DEFAULT_CONNECTIONS,
        MOBILE_MAX_SEGMENTS,
        || match control.load(Ordering::Acquire) {
            CONTROL_PAUSE => nova_download_core::TransferControl::Pause,
            CONTROL_CANCEL => nova_download_core::TransferControl::Cancel,
            _ => nova_download_core::TransferControl::Continue,
        },
    );

    if let Ok(mut map) = sessions().lock() {
        map.remove(task_id);
    }

    let transfer = match transfer_result {
        Ok(transfer) => transfer,
        Err(nova_download_core::TransportError::Paused) => {
            return Err(MobileTransferError::Paused)
        }
        Err(nova_download_core::TransportError::Cancelled) => {
            let _ = nova_download_core::cleanup_segment_state(&destination);
            let _ = std::fs::remove_file(&destination);
            return Err(MobileTransferError::Cancelled);
        }
        Err(error) => {
            return Err(MobileTransferError::TransferFailed {
                message: error.to_string(),
            })
        }
    };

    Ok(MobileTransferOutcome {
        final_bytes: transfer.final_bytes,
        total_bytes: transfer.total_bytes,
        resumed_from: transfer.resumed_from,
        effective_url: transfer.effective_url,
    })
}

/// Return durable progress for a mobile staging destination without exposing
/// the shared core's segment-directory layout to Kotlin.
pub fn staged_transfer_bytes(
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<u64, MobileTransferError> {
    let destination =
        validated_app_private_destination(app_private_root, relative_destination)?;
    nova_download_core::staged_downloaded_bytes(&destination).map_err(|error| {
        MobileTransferError::TransferFailed {
            message: error.to_string(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_control_returns_false_for_unknown_task() {
        assert!(!pause_transfer("missing"));
        assert!(!cancel_transfer("missing"));
        assert!(!is_transfer_active("missing"));
    }

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
