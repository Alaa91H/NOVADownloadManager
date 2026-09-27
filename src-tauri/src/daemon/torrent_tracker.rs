use std::time::Duration;

use nova_torrent_core::{
    MagnetLink, TorrentMetainfo, TrackerAnnounceRequest, TrackerEvent,
};
use tokio_util::sync::CancellationToken;

use crate::daemon::native_torrent::TrackerTransport;
use crate::daemon::state::SharedState;
use crate::daemon::torrent_seed::active_seed_port;
use crate::daemon::torrent_storage::TorrentStorageSession;
use crate::lock_or_err;

const TRACKER_RETRY_DELAY: Duration = Duration::from_secs(60);
const LISTENER_READY_TIMEOUT: Duration = Duration::from_secs(5);
const STOPPED_ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(3);

pub async fn run_tracker_lifecycle(
    state: SharedState,
    task_id: String,
    storage: TorrentStorageSession,
    source_uri: Option<String>,
    local_peer_id: [u8; 20],
    cancel: CancellationToken,
) {
    let plan = match storage.transfer_plan().await {
        Ok(plan) => plan,
        Err(error) => {
            log::debug!("Torrent tracker lifecycle {task_id}: storage plan unavailable: {error}");
            return;
        }
    };
    let tiers = tracker_tiers(&plan.metainfo, source_uri.as_deref());
    if tiers.is_empty() {
        return;
    }
    let telemetry = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.get(&task_id)
            .map(|job| job.telemetry.clone())
            .unwrap_or_default()
    };
    telemetry.register_trackers(tiers.iter().flatten().map(String::as_str));

    let port = match wait_for_listener_port(&cancel).await {
        Some(port) => port,
        None => {
            log::debug!(
                "Torrent tracker lifecycle {task_id}: inbound seed listener is unavailable; skipping announce"
            );
            return;
        }
    };

    let transport = TrackerTransport::production_default();
    let key = tracker_key();
    let mut started = false;
    let mut completed = false;
    let mut next_delay = Duration::ZERO;

    loop {
        if next_delay > Duration::ZERO {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(next_delay) => {}
            }
        } else if cancel.is_cancelled() {
            break;
        }

        let snapshot = match tracker_snapshot(&state, &task_id, &storage, local_peer_id, port, key).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                log::debug!("Torrent tracker lifecycle {task_id}: snapshot failed: {error}");
                next_delay = TRACKER_RETRY_DELAY;
                continue;
            }
        };

        let event = if !started {
            TrackerEvent::Started
        } else if snapshot.full_complete && !completed {
            TrackerEvent::Completed
        } else {
            TrackerEvent::None
        };

        let event_name = tracker_event_name(event);
        telemetry.tracker_attempt(
            tiers.iter().flatten().map(String::as_str),
            event_name,
        );
        match transport
            .announce_event(&tiers, &snapshot.request, event, &cancel)
            .await
        {
            Ok(success) => {
                telemetry.tracker_success(
                    &success.tracker_url,
                    event_name,
                    success.peers.len(),
                    success.complete,
                    success.incomplete,
                    success.interval_seconds,
                );
                started = true;
                if matches!(event, TrackerEvent::Completed) {
                    completed = true;
                }
                next_delay = if matches!(event, TrackerEvent::Started)
                    && snapshot.full_complete
                    && !completed
                {
                    Duration::ZERO
                } else {
                    TrackerTransport::next_announce_delay(&success)
                };
            }
            Err(error) if cancel.is_cancelled() => break,
            Err(error) => {
                telemetry.tracker_failure(
                    tiers.iter().flatten().map(String::as_str),
                    event_name,
                    &error,
                );
                log::debug!("Torrent tracker lifecycle {task_id}: announce failed: {error}");
                next_delay = TRACKER_RETRY_DELAY;
            }
        }
    }

    if started {
        let stop_token = CancellationToken::new();
        if let Ok(snapshot) =
            tracker_snapshot(&state, &task_id, &storage, local_peer_id, port, key).await
        {
            telemetry.tracker_attempt(
                tiers.iter().flatten().map(String::as_str),
                "stopped",
            );
            match tokio::time::timeout(
                STOPPED_ANNOUNCE_TIMEOUT,
                transport.announce_event(
                    &tiers,
                    &snapshot.request,
                    TrackerEvent::Stopped,
                    &stop_token,
                ),
            )
            .await
            {
                Ok(Ok(success)) => telemetry.tracker_success(
                    &success.tracker_url,
                    "stopped",
                    success.peers.len(),
                    success.complete,
                    success.incomplete,
                    success.interval_seconds,
                ),
                Ok(Err(error)) => telemetry.tracker_failure(
                    tiers.iter().flatten().map(String::as_str),
                    "stopped",
                    &error,
                ),
                Err(_) => telemetry.tracker_failure(
                    tiers.iter().flatten().map(String::as_str),
                    "stopped",
                    "Tracker stopped announce timed out",
                ),
            }
        }
    }
}

fn tracker_event_name(event: TrackerEvent) -> &'static str {
    match event {
        TrackerEvent::None => "periodic",
        TrackerEvent::Started => "started",
        TrackerEvent::Completed => "completed",
        TrackerEvent::Stopped => "stopped",
    }
}

struct TrackerSnapshot {
    request: TrackerAnnounceRequest,
    full_complete: bool,
}

async fn tracker_snapshot(
    state: &SharedState,
    task_id: &str,
    storage: &TorrentStorageSession,
    local_peer_id: [u8; 20],
    port: u16,
    key: u32,
) -> Result<TrackerSnapshot, String> {
    let plan = storage
        .transfer_plan()
        .await
        .map_err(|error| format!("could not read transfer plan: {error}"))?;
    let (downloaded, left, full_complete) = full_payload_progress(&plan.metainfo, &plan.completed)?;
    let uploaded = {
        let jobs = lock_or_err!(state.torrent_jobs);
        jobs.get(task_id)
            .map(|job| {
                job.uploaded_bytes
                    .load(std::sync::atomic::Ordering::Relaxed)
            })
            .unwrap_or(0)
    };

    Ok(TrackerSnapshot {
        request: TrackerAnnounceRequest {
            info_hash: plan.metainfo.info_hash,
            peer_id: local_peer_id,
            port,
            uploaded,
            downloaded,
            left,
            event: TrackerEvent::None,
            key,
            num_want: Some(200),
        },
        full_complete,
    })
}

fn full_payload_progress(
    metainfo: &TorrentMetainfo,
    completed: &[bool],
) -> Result<(u64, u64, bool), String> {
    if completed.len() != metainfo.piece_count() {
        return Err("torrent verified-piece bitmap length does not match metainfo".to_owned());
    }

    let mut downloaded = 0u64;
    let mut full_complete = true;
    for (piece_index, verified) in completed.iter().copied().enumerate() {
        if verified {
            downloaded = downloaded
                .checked_add(
                    metainfo
                        .piece_size(piece_index)
                        .ok_or_else(|| "torrent piece geometry is invalid".to_owned())?,
                )
                .ok_or_else(|| "torrent tracker downloaded-byte accounting overflow".to_owned())?;
        } else {
            full_complete = false;
        }
    }
    Ok((
        downloaded,
        metainfo.total_length.saturating_sub(downloaded),
        full_complete,
    ))
}

fn tracker_tiers(metainfo: &TorrentMetainfo, source_uri: Option<&str>) -> Vec<Vec<String>> {
    if !metainfo.tracker_tiers.is_empty() {
        return metainfo.tracker_tiers.clone();
    }
    if !metainfo.trackers.is_empty() {
        return vec![metainfo.trackers.clone()];
    }

    let Some(source) = source_uri else {
        return Vec::new();
    };
    let Ok(magnet) = MagnetLink::parse(source) else {
        return Vec::new();
    };
    if magnet.info_hash != metainfo.info_hash || magnet.trackers.is_empty() {
        return Vec::new();
    }
    vec![magnet.trackers]
}

async fn wait_for_listener_port(cancel: &CancellationToken) -> Option<u16> {
    let deadline = tokio::time::Instant::now() + LISTENER_READY_TIMEOUT;
    loop {
        if let Some(port) = active_seed_port() {
            return Some(port);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::select! {
            _ = cancel.cancelled() => return None,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}

fn tracker_key() -> u32 {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_torrent_core::{InfoHash, TorrentFile};

    fn meta() -> TorrentMetainfo {
        TorrentMetainfo {
            info_hash: InfoHash::new([0x33; 20]),
            name: "tracker.bin".to_owned(),
            piece_length: 4,
            piece_hashes: vec![[1u8; 20], [2u8; 20]],
            files: vec![TorrentFile {
                path: "tracker.bin".to_owned(),
                length: 8,
                offset: 0,
            }],
            total_length: 8,
            trackers: vec!["https://tracker.example/announce".to_owned()],
            tracker_tiers: vec![vec!["https://tracker.example/announce".to_owned()]],
            private: false,
        }
    }

    #[test]
    fn tracker_progress_counts_full_payload_not_selected_bytes() {
        let meta = meta();
        assert_eq!(full_payload_progress(&meta, &[true, false]).unwrap(), (4, 4, false));
        assert_eq!(full_payload_progress(&meta, &[true, true]).unwrap(), (8, 0, true));
    }

    #[test]
    fn tracker_tiers_prefer_metainfo_and_fall_back_to_magnet() {
        let meta = meta();
        assert_eq!(
            tracker_tiers(&meta, None),
            vec![vec!["https://tracker.example/announce".to_owned()]]
        );

        let mut trackerless = meta.clone();
        trackerless.trackers.clear();
        trackerless.tracker_tiers.clear();
        let source = format!(
            "magnet:?xt=urn:btih:{}&tr=https%3A%2F%2Ffallback.example%2Fannounce",
            trackerless.info_hash.to_hex()
        );
        assert_eq!(
            tracker_tiers(&trackerless, Some(&source)),
            vec![vec!["https://fallback.example/announce".to_owned()]]
        );
    }
}
