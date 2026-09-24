//! Android-safe mobile facade over NOVA's shared download core.
//!
//! Android owns lifecycle and secure intent persistence. Transfer bytes,
//! segmentation, validation, pause/cancel control and resumable artifacts are
//! owned by the platform-neutral Rust core.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MobileTransferOutcome {
    pub final_bytes: u64,
    pub total_bytes: Option<u64>,
    pub resumed_from: u64,
    pub effective_url: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct MobileTransferProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
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
pub const DEFAULT_MOBILE_CONNECTIONS: u32 = 4;

struct SessionState {
    control: AtomicU8,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
}

impl SessionState {
    fn new() -> Self {
        Self {
            control: AtomicU8::new(CONTROL_CONTINUE),
            downloaded_bytes: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
        }
    }

    fn progress(&self) -> MobileTransferProgress {
        MobileTransferProgress {
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Acquire),
            total_bytes: self.total_bytes.load(Ordering::Acquire),
        }
    }

    fn update_progress(&self, downloaded_bytes: u64, total_bytes: Option<u64>) {
        self.downloaded_bytes
            .store(downloaded_bytes, Ordering::Release);
        if let Some(total_bytes) = total_bytes {
            self.total_bytes.store(total_bytes, Ordering::Release);
        }
    }
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<SessionState>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<SessionState>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn last_progress() -> &'static Mutex<HashMap<String, MobileTransferProgress>> {
    static LAST_PROGRESS: OnceLock<Mutex<HashMap<String, MobileTransferProgress>>> =
        OnceLock::new();
    LAST_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_session_control(task_id: &str, control: u8) -> bool {
    sessions()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).cloned())
        .is_some_and(|state| {
            state.control.store(control, Ordering::Release);
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

/// Returns the freshest native progress snapshot.
///
/// Active sessions are read lock-free from atomics. Once an execution returns,
/// its last snapshot remains available until the Android host persists it and
/// explicitly forgets the transient native progress entry.
pub fn transfer_progress(task_id: &str) -> Option<MobileTransferProgress> {
    if let Some(state) = sessions()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).cloned())
    {
        return Some(state.progress());
    }
    last_progress()
        .lock()
        .ok()
        .and_then(|map| map.get(task_id).copied())
}

pub fn forget_transfer_progress(task_id: &str) {
    if let Ok(mut map) = last_progress().lock() {
        map.remove(task_id);
    }
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

/// Destructively removes the staging file and every shared-core sidecar/segment.
///
/// This is intentionally separate from pause: pause preserves every durable
/// artifact required for a validated restart.
pub fn discard_app_private_transfer(
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<(), MobileTransferError> {
    let destination =
        validated_app_private_destination(app_private_root, relative_destination)?;
    nova_download_core::discard_http_download_artifacts(&destination);
    Ok(())
}

pub fn download_to_app_private_path(
    task_id: &str,
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    download_to_app_private_path_with_connections(
        task_id,
        url,
        app_private_root,
        relative_destination,
        DEFAULT_MOBILE_CONNECTIONS,
    )
}

pub fn download_to_app_private_path_with_connections(
    task_id: &str,
    url: &str,
    app_private_root: &Path,
    relative_destination: &Path,
    requested_connections: u32,
) -> Result<MobileTransferOutcome, MobileTransferError> {
    if task_id.trim().is_empty() {
        return Err(MobileTransferError::TransferFailed {
            message: "missing native task id".to_owned(),
        });
    }

    let destination =
        validated_app_private_destination(app_private_root, relative_destination)?;
    let state = Arc::new(SessionState::new());

    {
        let mut map = sessions().lock().map_err(|_| MobileTransferError::TransferFailed {
            message: "native transfer session registry is unavailable".to_owned(),
        })?;
        if map.contains_key(task_id) {
            return Err(MobileTransferError::TransferFailed {
                message: "native transfer session is already active".to_owned(),
            });
        }
        map.insert(task_id.to_owned(), Arc::clone(&state));
    }
    forget_transfer_progress(task_id);

    let control_state = Arc::clone(&state);
    let progress_state = Arc::clone(&state);
    let transfer_result = nova_download_core::download_http_to_path_segmented_controlled(
        url,
        &destination,
        requested_connections.max(1),
        move || match control_state.control.load(Ordering::Acquire) {
            CONTROL_PAUSE => nova_download_core::TransferControl::Pause,
            CONTROL_CANCEL => nova_download_core::TransferControl::Cancel,
            _ => nova_download_core::TransferControl::Continue,
        },
        move |downloaded_bytes, total_bytes| {
            progress_state.update_progress(downloaded_bytes, total_bytes);
        },
    );

    if let Ok(transfer) = &transfer_result {
        state.update_progress(transfer.final_bytes, transfer.total_bytes);
    }
    let final_progress = state.progress();
    if let Ok(mut map) = last_progress().lock() {
        map.insert(task_id.to_owned(), final_progress);
    }
    if let Ok(mut map) = sessions().lock() {
        map.remove(task_id);
    }

    let transfer = match transfer_result {
        Ok(transfer) => transfer,
        Err(nova_download_core::TransportError::Paused) => {
            return Err(MobileTransferError::Paused)
        }
        Err(nova_download_core::TransportError::Cancelled) => {
            nova_download_core::discard_http_download_artifacts(&destination);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_control_returns_false_for_unknown_task() {
        assert!(!pause_transfer("missing"));
        assert!(!cancel_transfer("missing"));
        assert!(!is_transfer_active("missing"));
        assert_eq!(transfer_progress("missing"), None);
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

    #[test]
    fn discard_rejects_path_traversal() {
        assert!(matches!(
            discard_app_private_transfer(
                Path::new("/app/files"),
                Path::new("../outside.part"),
            ),
            Err(MobileTransferError::InvalidRelativeDestination)
        ));
    }

    #[test]
    fn destructive_discard_removes_shared_core_sidecars_and_segments() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("nova-mobile-discard-{unique}"));
        let relative = Path::new("nova-staging/task.part");
        let destination = root.join(relative);
        std::fs::create_dir_all(destination.parent().expect("staging parent"))
            .expect("create staging parent");

        for path in [
            destination.clone(),
            PathBuf::from(format!("{}.nova-identity", destination.display())),
            PathBuf::from(format!("{}.nova-segments", destination.display())),
            PathBuf::from(format!("{}.nova-seg-0000", destination.display())),
            PathBuf::from(format!("{}.nova-seg-0000.done", destination.display())),
            PathBuf::from(format!("{}.nova-merge", destination.display())),
        ] {
            std::fs::write(path, b"temporary").expect("seed transfer artifact");
        }

        discard_app_private_transfer(&root, relative).expect("discard transfer artifacts");

        assert!(!destination.exists());
        assert!(!PathBuf::from(format!("{}.nova-identity", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-segments", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-seg-0000", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-seg-0000.done", destination.display())).exists());
        assert!(!PathBuf::from(format!("{}.nova-merge", destination.display())).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn progress_snapshot_tracks_atomic_session_state() {
        let task_id = "progress-test";
        let state = Arc::new(SessionState::new());
        state.update_progress(128, Some(1024));
        sessions()
            .lock()
            .expect("sessions")
            .insert(task_id.to_owned(), state);

        assert_eq!(
            transfer_progress(task_id),
            Some(MobileTransferProgress {
                downloaded_bytes: 128,
                total_bytes: 1024,
            })
        );

        sessions().lock().expect("sessions").remove(task_id);
        forget_transfer_progress(task_id);
    }
}
