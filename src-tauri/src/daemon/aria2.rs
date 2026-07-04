use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::Duration;
use uuid::Uuid;
use serde_json;

use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, Task, TorrentBody, TorrentMetadata};
use crate::daemon::utils::{base64_encode, build_segments, hide_command_window, infer_file_type, kill_process, map_aria_status};
use crate::lock_or_err;

pub async fn aria2_rpc(state: &SharedState, method: &str, params: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let port = state.aria2_rpc_port;
    let secret = &state.aria2_secret;
    let url = format!("http://127.0.0.1:{}/jsonrpc", port);

    let mut all_params = vec![serde_json::json!(format!("token:{}", secret))];
    all_params.extend(params);
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": Uuid::new_v4().to_string(),
        "method": format!("aria2.{}", method),
        "params": all_params,
    });

    let resp = state.http_client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("RPC request failed: {}", e))?;

    let payload: serde_json::Value = resp.json().await
        .map_err(|e| format!("RPC parse failed: {}", e))?;

    if let Some(err) = payload.get("error") {
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
        return Err(format!("Aria2 RPC error: {}", msg));
    }

    Ok(payload.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

pub async fn ensure_aria2(state: &SharedState) -> Result<(), String> {
    {
        let proc = state.aria2_process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() {
            return Ok(());
        }
    }

    let tc = state.torrent_config.lock().map_err(|e| e.to_string())?.clone();

    let mut args = vec![
        "--enable-rpc=true".to_string(),
        "--rpc-listen-all=false".to_string(),
        format!("--rpc-listen-port={}", state.aria2_rpc_port),
        format!("--rpc-secret={}", state.aria2_secret),
        "--continue=true".to_string(),
        "--summary-interval=0".to_string(),
        "--console-log-level=warn".to_string(),
    ];

    // Persist unfinished downloads so they survive an app restart. GIDs are
    // stored in the session file, keeping our metadata map valid across runs.
    let session_file = crate::daemon::persist::aria2_session_path(&state.data_dir);
    if session_file.exists() {
        args.push(format!("--input-file={}", session_file.display()));
    }
    args.push(format!("--save-session={}", session_file.display()));
    args.push("--save-session-interval=10".to_string());
    args.push("--auto-save-interval=10".to_string());

    if tc.dht.unwrap_or(true) {
        args.push("--enable-dht=true".to_string());
        args.push("--dht-listen-port=6881-6999".to_string());
    } else {
        args.push("--enable-dht=false".to_string());
    }
    if tc.pex.unwrap_or(true) {
        args.push("--enable-peer-exchange=true".to_string());
    } else {
        args.push("--enable-peer-exchange=false".to_string());
    }
    if tc.encryption.unwrap_or(true) {
        args.push("--bt-require-crypto=true".to_string());
    }
    if let Some(port) = tc.listen_port {
        args.push(format!("--dht-listen-port={}", port));
        args.push(format!("--listen-port={}", port));
    }
    if let Some(mp) = tc.max_peers {
        args.push(format!("--bt-max-peers={}", mp));
    }
    if tc.seeding.unwrap_or(true) {
        args.push("--seed-ratio=0.0".to_string());
        args.push("--bt-seed-unverified=true".to_string());
    }
    if let Some(rl) = tc.ratio_limit {
        args.push(format!("--seed-ratio={}", rl));
    }
    if let Some(us) = tc.upload_speed {
        args.push(format!("--max-upload-limit={}", us * 1024));
    }

    let mut cmd = Command::new(&state.aria2_bin);
    hide_command_window(&mut cmd);
    let child = cmd
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn aria2c: {}", e))?;

    let pid = child.id();

    {
        let mut proc = state.aria2_process.lock().map_err(|e| e.to_string())?;
        *proc = Some(child);
    }

    for _ in 0..30 {
        if aria2_rpc(state, "getVersion", vec![]).await.is_ok() {
            log::info!("Aria2 daemon started (pid {})", pid);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    Err("Aria2 did not become ready in time".to_string())
}

pub fn normalize_aria2_task(_state: &SharedState, item: &serde_json::Value, meta: &HashMap<String, serde_json::Value>) -> Task {
    let gid = item["gid"].as_str().unwrap_or("").to_string();
    let files = item["files"].as_array();
    let first_file = files.and_then(|f| f.first());
    let uri = first_file
        .and_then(|f| f["uris"].as_array())
        .and_then(|u| u.first())
        .and_then(|u| u["uri"].as_str());
    let file_path = first_file.and_then(|f| f["path"].as_str());

    let url = meta.get("url").and_then(|v| v.as_str()).or(uri).unwrap_or("").to_string();
    let save_path = file_path.map(|s| s.to_string()).or_else(|| {
        meta.get("savePath").and_then(|v| v.as_str()).map(|s| s.to_string())
    }).unwrap_or_default();
    let total = item["totalLength"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0u64);
    let completed = item["completedLength"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0u64);
    let speed = item["downloadSpeed"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0u64);
    let upload_speed = item["uploadSpeed"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0u64);
    let upload_len = item["uploadLength"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0u64);
    let num_seeders = item["numSeeders"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0u32);
    let is_seeder = item["seeder"].as_str() == Some("true");
    let status = map_aria_status(item["status"].as_str().unwrap_or(""));
    let connections = item["connections"].as_str().and_then(|s| s.parse().ok()).unwrap_or(1u32);
    let name = meta.get("name").and_then(|v| v.as_str())
        .or_else(|| item["bittorrent"]["info"]["name"].as_str())
        .or_else(|| std::path::Path::new(&save_path).file_name().and_then(|n| n.to_str()))
        .unwrap_or("download")
        .to_string();
    let dir = item["dir"].as_str().unwrap_or("");
    let final_path = if save_path.is_empty() {
        format!("{}/{}", dir, name)
    } else {
        save_path.clone()
    };

    let bt_info = item["bittorrent"].as_object();
    let torrent_meta = bt_info.map(|bt| {
        let info = bt.get("info").and_then(|i| i.as_object());
        TorrentMetadata {
            infoHash: info.and_then(|i| i.get("infoHash")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
            mode: bt.get("mode").and_then(|v| v.as_str()).unwrap_or("single").to_string(),
            numPeers: 0,
            numSeeders: num_seeders,
            uploadSpeed: upload_speed,
            uploadLength: upload_len,
            seeder: is_seeder,
            seedRatio: if total > 0 { upload_len as f64 / total as f64 } else { 0.0 },
        }
    });

    let description = if bt_info.is_some() {
        "Torrent download".to_string()
    } else {
        meta.get("description").and_then(|v| v.as_str()).unwrap_or("Direct download").to_string()
    };

    Task {
        id: gid.clone(),
        url,
        file_type: meta.get("fileType").and_then(|v| v.as_str()).unwrap_or_else(|| infer_file_type(&name)).to_string(),
        name: name.clone(),
        status: status.to_string(),
        size_bytes: total,
        downloaded_bytes: if status == "completed" { total } else { completed },
        speed_bytes_per_sec: speed,
        time_left_seconds: if speed > 0 && total > completed { (total - completed) / speed } else { 0 },
        date_added: meta.get("dateAdded").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        category: meta.get("category").and_then(|v| v.as_str()).unwrap_or_else(|| infer_file_type(&name)).to_string(),
        queue_id: meta.get("queueId").and_then(|v| v.as_str()).unwrap_or("main").to_string(),
        connections,
        resumable: meta.get("resumable").and_then(|v| v.as_bool()).unwrap_or(true),
        save_path: final_path,
        description,
        segments: build_segments(connections, total, completed, status == "downloading", speed),
        referer: meta.get("referer").and_then(|v| v.as_str()).map(|s| s.to_string()),
        engine: "aria2".to_string(),
        engine_id: gid.clone(),
        engine_status: item["status"].as_str().map(|s| s.to_string()),
        error_message: item["errorMessage"].as_str().map(|s| s.to_string()),
        torrent_metadata: torrent_meta,
    }
}

pub async fn list_all_tasks(state: &SharedState) -> Vec<Task> {
    let aria2_meta = lock_or_err!(state.aria2_meta).clone();
    let mut tasks: Vec<Task> = {
        let media_jobs = lock_or_err!(state.media_jobs);
        media_jobs.values().map(|j| j.task.clone()).collect()
    };

    if let Ok(active) = aria2_rpc(state, "tellActive", vec![]).await {
        if let Some(arr) = active.as_array() {
            for item in arr {
                let gid = item["gid"].as_str().unwrap_or("").to_string();
                let meta = aria2_meta.get(&gid).cloned().unwrap_or_default();
                tasks.push(normalize_aria2_task(state, item, &meta));
            }
        }
    }
    if let Ok(waiting) = aria2_rpc(state, "tellWaiting", vec![serde_json::json!(0), serde_json::json!(1000)]).await {
        if let Some(arr) = waiting.as_array() {
            for item in arr {
                let gid = item["gid"].as_str().unwrap_or("").to_string();
                let meta = aria2_meta.get(&gid).cloned().unwrap_or_default();
                tasks.push(normalize_aria2_task(state, item, &meta));
            }
        }
    }
    if let Ok(stopped) = aria2_rpc(state, "tellStopped", vec![serde_json::json!(0), serde_json::json!(1000)]).await {
        if let Some(arr) = stopped.as_array() {
            for item in arr {
                let gid = item["gid"].as_str().unwrap_or("").to_string();
                let meta = aria2_meta.get(&gid).cloned().unwrap_or_default();
                tasks.push(normalize_aria2_task(state, item, &meta));
            }
        }
    }

    merge_snapshot_tasks(state, tasks)
}

/// Append persisted tasks the engines no longer know about (completed and
/// errored history, or downloads lost from the aria2 session), then refresh
/// the snapshot and flag it for saving when anything material changed.
fn merge_snapshot_tasks(state: &SharedState, mut tasks: Vec<Task>) -> Vec<Task> {
    let mut snapshot = lock_or_err!(state.task_snapshot);

    let live_ids: std::collections::HashSet<String> = tasks.iter().map(|t| t.id.clone()).collect();
    for (id, task) in snapshot.iter() {
        if !live_ids.contains(id) {
            let mut task = task.clone();
            task.speed_bytes_per_sec = 0;
            if matches!(task.status.as_str(), "downloading" | "queued" | "waiting" | "starting") {
                task.status = "paused".to_string();
                task.engine_status = Some("interrupted".to_string());
            }
            tasks.push(task);
        }
    }

    let mut changed = snapshot.len() != tasks.len();
    if !changed {
        for task in &tasks {
            let same = snapshot.get(&task.id).is_some_and(|old| {
                old.status == task.status
                    && old.downloaded_bytes == task.downloaded_bytes
                    && old.size_bytes == task.size_bytes
                    && old.name == task.name
                    && old.save_path == task.save_path
            });
            if !same {
                changed = true;
                break;
            }
        }
    }
    if changed {
        *snapshot = tasks.iter().map(|t| (t.id.clone(), t.clone())).collect();
        state.mark_dirty();
    }

    tasks
}

pub async fn create_aria2_task(state: &SharedState, body: &CreateDownloadBody) -> Result<Task, String> {
    ensure_aria2(state).await?;

    let url = body.url.as_deref().unwrap_or("");

    if url.starts_with("magnet:") {
        return create_torrent_task_inner(state, &TorrentBody {
            magnet: Some(url.to_string()),
            torrent_base64: None,
            name: body.name.clone(),
            save_path: body.save_path.clone(),
        }).await;
    }
    if url.to_lowercase().ends_with(".torrent") || url.contains(".torrent?") {
        let resp = state.http_client.get(url).timeout(Duration::from_secs(30)).send().await.map_err(|e| format!("Failed to fetch torrent file: {}", e))?;
        let bytes = resp.bytes().await.map_err(|e| format!("Failed to read torrent file: {}", e))?;
        let b64 = base64_encode(&bytes);
        return create_torrent_task_inner(state, &TorrentBody {
            magnet: None,
            torrent_base64: Some(b64),
            name: body.name.clone(),
            save_path: body.save_path.clone(),
        }).await;
    }

    let name = body.name.clone().unwrap_or_else(|| {
        url.rsplit('/').next().unwrap_or("download").to_string()
    });
    let save_path = body.save_path.clone().unwrap_or_default();
    let (dir, file_name) = if save_path.is_empty() {
        ("".to_string(), name.clone())
    } else {
        let p = std::path::Path::new(&save_path);
        (p.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
         p.file_name().and_then(|n| n.to_str()).unwrap_or(&name).to_string())
    };

    if !dir.is_empty() {
        let _ = std::fs::create_dir_all(&dir);
    }

    let mut options = serde_json::json!({
        "dir": dir,
        "out": file_name,
        "continue": "true",
        "split": "16",
        "max-connection-per-server": "16",
    });

    if let Some(dopts) = &body.direct_options {
        if let Some(proxy) = dopts.get("proxy").and_then(|v| v.as_str()) {
            options["all-proxy"] = serde_json::json!(proxy);
        }
        if let Some(ua) = dopts.get("userAgent").and_then(|v| v.as_str()) {
            options["user-agent"] = serde_json::json!(ua);
        }
        let refr = dopts.get("referer").cloned().or_else(|| body.referer.as_ref().map(|s| serde_json::json!(s)));
        if let Some(refr) = refr {
            options["referer"] = refr;
        }
        if let Some(checksum) = dopts.get("checksum").and_then(|v| v.as_str()) {
            options["checksum"] = serde_json::json!(checksum);
        }
        if let Some(speed) = dopts.get("speedLimitKbs").and_then(|v| v.as_f64()) {
            options["max-download-limit"] = serde_json::json!(format!("{}K", speed as u64));
        }
    }

    let gid = aria2_rpc(state, "addUri", vec![
        serde_json::json!([url]),
        options,
    ]).await?
    .as_str().unwrap_or("").to_string();

    let mut meta = HashMap::new();
    meta.insert("id".to_string(), serde_json::json!(gid));
    meta.insert("name".to_string(), serde_json::json!(name));
    meta.insert("url".to_string(), serde_json::json!(url));
    meta.insert("fileType".to_string(), serde_json::json!(body.file_type.as_deref().unwrap_or_else(|| infer_file_type(&name))));
    meta.insert("category".to_string(), serde_json::json!(body.category.as_deref().unwrap_or_else(|| infer_file_type(&name))));
    meta.insert("queueId".to_string(), serde_json::json!(body.queue_id.as_deref().unwrap_or("main")));
    meta.insert("connections".to_string(), serde_json::json!(body.connections.unwrap_or(1)));
    meta.insert("resumable".to_string(), serde_json::json!(body.resumable.unwrap_or(true)));
    meta.insert("description".to_string(), serde_json::json!(body.description.as_deref().unwrap_or("Direct download")));
    meta.insert("engine".to_string(), serde_json::json!("aria2"));
    meta.insert("engineId".to_string(), serde_json::json!(gid));

    lock_or_err!(state.aria2_meta).insert(gid.clone(), meta.clone());
    state.mark_dirty();
    // Flush the aria2 session immediately so a crash right after adding does
    // not lose the new download.
    let _ = aria2_rpc(state, "saveSession", vec![]).await;

    let status = aria2_rpc(state, "tellStatus", vec![serde_json::json!(gid)]).await?;
    Ok(normalize_aria2_task(state, &status, &meta))
}

pub async fn create_torrent_task_inner(state: &SharedState, body: &TorrentBody) -> Result<Task, String> {
    ensure_aria2(state).await?;

    let mut options = serde_json::json!({});
    if let Some(sp) = &body.save_path {
        let p = std::path::Path::new(sp);
        let dir = p.parent().map(|p| p.to_string_lossy()).unwrap_or_default().to_string();
        if !dir.is_empty() {
            let _ = std::fs::create_dir_all(&dir);
            options["dir"] = serde_json::json!(dir);
        }
    }

    let gid = if let Some(b64) = &body.torrent_base64 {
        aria2_rpc(state, "addTorrent", vec![
            serde_json::json!(b64),
            serde_json::json!([]),
            options,
        ]).await?
    } else if let Some(magnet) = &body.magnet {
        aria2_rpc(state, "addUri", vec![
            serde_json::json!([magnet]),
            options,
        ]).await?
    } else {
        return Err("Provide torrentBase64 or magnet".to_string());
    };

    let gid_str = gid.as_str().unwrap_or("").to_string();
    let name = body.name.clone().unwrap_or_else(|| format!("torrent-{}", &gid_str[..8.min(gid_str.len())]));

    let mut meta = HashMap::new();
    meta.insert("id".to_string(), serde_json::json!(gid_str));
    meta.insert("name".to_string(), serde_json::json!(name));
    meta.insert("url".to_string(), serde_json::json!(body.magnet.clone().unwrap_or_else(|| format!("torrent:{}", &gid_str[..12.min(gid_str.len())]))));
    meta.insert("fileType".to_string(), serde_json::json!("other"));
    meta.insert("category".to_string(), serde_json::json!("other"));
    meta.insert("queueId".to_string(), serde_json::json!("main"));
    meta.insert("connections".to_string(), serde_json::json!(1));
    meta.insert("resumable".to_string(), serde_json::json!(true));
    meta.insert("description".to_string(), serde_json::json!("Torrent download"));
    meta.insert("engine".to_string(), serde_json::json!("aria2"));
    meta.insert("engineId".to_string(), serde_json::json!(gid_str));

    lock_or_err!(state.aria2_meta).insert(gid_str.clone(), meta.clone());
    state.mark_dirty();
    let _ = aria2_rpc(state, "saveSession", vec![]).await;

    let status = aria2_rpc(state, "tellStatus", vec![serde_json::json!(gid_str)]).await?;
    Ok(normalize_aria2_task(state, &status, &meta))
}

pub async fn pause_task(state: &SharedState, id: &str) -> Result<Task, String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if let Some(pid) = job.child {
                kill_process(pid);
                job.child = None;
            }
            job.task.status = "paused".to_string();
            job.task.speed_bytes_per_sec = 0;
            job.task.engine_status = Some("paused".to_string());
            let task = job.task.clone();
            drop(jobs);
            state.mark_dirty();
            return Ok(task);
        }
    }

    aria2_rpc(state, "forcePause", vec![serde_json::json!(id)]).await
        .map_err(|e| e.to_string())?;

    let status = aria2_rpc(state, "tellStatus", vec![serde_json::json!(id)]).await
        .map_err(|e| e.to_string())?;

    let meta = lock_or_err!(state.aria2_meta).get(id).cloned().unwrap_or_default();
    state.mark_dirty();
    Ok(normalize_aria2_task(state, &status, &meta))
}

pub async fn resume_task(state: &SharedState, id: &str) -> Result<Task, String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.get_mut(id) {
            let needs_start = job.task.status != "completed";
            if needs_start {
                job.task.status = "downloading".to_string();
                job.task.engine_status = Some("resuming".to_string());
            }
            // Release the lock before spawning: start_ytdlp_process re-locks
            // media_jobs, and holding the guard here would deadlock.
            drop(jobs);
            if needs_start {
                crate::daemon::ytdlp::start_ytdlp_process(state, id);
            }
            state.mark_dirty();
            let jobs = lock_or_err!(state.media_jobs);
            return match jobs.get(id) {
                Some(job) => Ok(job.task.clone()),
                None => Err("Task not found after resume".to_string()),
            };
        }
    }

    aria2_rpc(state, "unpause", vec![serde_json::json!(id)]).await
        .map_err(|e| e.to_string())?;

    let status = aria2_rpc(state, "tellStatus", vec![serde_json::json!(id)]).await
        .map_err(|e| e.to_string())?;

    let meta = lock_or_err!(state.aria2_meta).get(id).cloned().unwrap_or_default();
    state.mark_dirty();
    Ok(normalize_aria2_task(state, &status, &meta))
}

pub async fn delete_task(state: &SharedState, id: &str) -> Result<(), String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.remove(id) {
            if let Some(pid) = job.child {
                kill_process(pid);
            }
            drop(jobs);
            lock_or_err!(state.task_snapshot).remove(id);
            state.mark_dirty();
            return Ok(());
        }
    }

    // The task may only exist in the persisted snapshot (history entry or a
    // download the engine lost) — deleting those must not fail on RPC errors.
    // Run both calls: forceRemove stops live downloads, removeDownloadResult
    // purges the stopped/completed record.
    let removed_live = aria2_rpc(state, "forceRemove", vec![serde_json::json!(id)]).await.is_ok();
    let removed_result = aria2_rpc(state, "removeDownloadResult", vec![serde_json::json!(id)]).await.is_ok();
    let known_to_engine = removed_live || removed_result;
    let known_to_snapshot = lock_or_err!(state.task_snapshot).remove(id).is_some();
    lock_or_err!(state.aria2_meta).remove(id);

    if !known_to_engine && !known_to_snapshot {
        return Err("Task not found".to_string());
    }
    let _ = aria2_rpc(state, "saveSession", vec![]).await;
    state.mark_dirty();
    Ok(())
}
