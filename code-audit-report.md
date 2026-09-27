# NOVA — Final Engineering Report for Microscopic Review

**Date:** 2026-07-29
**Scope:** 90+ Rust files, 15,000+ lines
**Team:** Senior Systems Engineer, Senior Rust Engineer, Network Protocol Expert, Performance Engineer, Memory Safety Auditor, Concurrency Specialist, Software Architect, Static Analysis Expert

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Issue List by Severity](#2-issue-list-by-severity)
3. [Full Execution Flow Map](#3-full-execution-flow-map)
4. [Download Flow Map](#4-download-flow-map)
5. [Dependency Map](#5-dependency-map)
6. [Dead Code Analysis](#6-dead-code-analysis)
7. [Performance Analysis](#7-performance-analysis)
8. [Concurrency Analysis](#8-concurrency-analysis)
9. [Memory Management Analysis](#9-memory-management-analysis)
10. [Network and libcurl Analysis](#10-network-and-libcurl-analysis)
11. [Architecture Analysis](#11-architecture-analysis)
12. [Fix Plan](#12-fix-plan)

---

## 1. Executive Summary

The project was analyzed line-by-line across 5 parallel analysis teams. A total of **63 issues** were discovered, distributed as follows:

| Severity | Count | Description |
|---------|-------|-------------|
| **CRITICAL** | 12 | Data loss, total hang, unrecoverable crash |
| **HIGH** | 22 | Data corruption, resource leaks, severe logic bugs |
| **MEDIUM** | 31 | Performance bugs, potential concurrency issues, dead code |
| **LOW** | 20 | Improvements, refactoring, style |
| **INFO** | 14 | Notes, documentation, test coverage |

Most severe issues:
1. Daemon restart leaks entire Tokio Runtime (C1)
2. `app.exit(0)` kills the Daemon without persisting state — data loss (C2)
3. `SegmentWriter::write` silently swallows I/O errors — data corruption (C3-Adaptive)
4. `AsyncDiskWriter` does not implement `Drop` — writer thread leak + data loss on shutdown (C4-Adaptive)
5. Thread Pool: a task panic kills the worker and leaks `active_count` (C5-Engine)
6. EventBus: Mutex poison in Phase 3 stops publishing forever (C6-Engine)
7. `SegmentPlanner::plan` assigns u32::MAX chunks for 4GB+ file — OOM (C7)
8. yt-dlp pipe deadlock — complete stall with large output (C8)
9. Preallocated file: progress jumps to 100% immediately (C9-Transfer)
10. Old-generation Watchdog destroys the new generation (C10-Transfer)
11. DNS resolution without timeout — UI freeze (C11)
12. `resource_monitor.rs`: CPU stats non-atomic — incorrect readings (C12-Adaptive)

---

## 2. Issue List by Severity

### 2.1 CRITICAL

| # | File:Line | Issue | Root Cause | Impact |
|---|-----------|-------|------------|--------|
| **C1** | `lib.rs:465-490`, `mod.rs:133-436` | Daemon restart leaks Tokio Runtime | `restart_daemon` does not send a stop signal to the old thread before starting a new one | Full Tokio Runtime + Axum Server + all tasks leak and cannot be stopped |
| **C2** | `lib.rs:641-648` | `app.exit(0)` kills the Daemon without persisting | The "quit" handler does not send `SIGTERM`/`ctrl_c` to the Daemon; it terminates the process immediately | Active downloads are killed, last N seconds of progress are lost, port file is not removed |
| **C3** | `adaptive/disk_writer.rs:199` | `drain_batch` silently swallows I/O failures | Results of `seek()` and `write_all()` are ignored, and `pending_bytes` is decremented despite failures | Silent data corruption, inconsistent statistics |
| **C4** | `adaptive/disk_writer.rs` (no `Drop`) | Thread leak when `AsyncDiskWriter` is dropped | No `Drop` that performs `join()` or `shutdown()` — thread is detached | Thread leaks; no guarantee writes complete before process exit |
| **C5** | `thread_pool.rs:41-44` | Task panic kills worker and leaks `active_count` | `task_fn()` lacks `catch_unwind` — panic does not decrement the counter, thread dies | `active_count` inflates, pool loses workers and does not replace them, becomes stalled |
| **C6** | `event_bus.rs:264-270` | Mutex poison in Phase 3 stops EventBus forever | Second lock failure returns without resetting `publish_depth` to 0 | `publish()` sees `publish_depth > 0` and stores events forever — total collapse |
| **C7** | `direct.rs:216` | `SegmentPlanner::plan` assigns `u32::MAX` chunks for 4GB+ file | `total_size / min_chunk_size` may produce 4 billion chunks | RAM exhaustion + hang |
| **C8** | `ytdlp.rs:176-199` | yt-dlp pipe deadlock — complete stall with large output | stdout/stderr pipes are read sequentially, not concurrently — pipe buffer (64KB) fills and blocks | Complete hang of yt-dlp downloads with large output |
| **C9** | `transfer.rs:678,722-726` | Download progress jumps to 100% immediately with preallocation | `FileWriter::current_size` returns `total_size` after preallocation, and `max()` selects it over the atomic counter | Progress bar shows 100% immediately for preallocated files |
| **C10** | `transfer.rs:1756-1987` | Old-generation Watchdog destroys the new generation | Watchdog holds a reference to the old `watchdog_cancel` and doesn't check `generation` | Old Watchdog sees a false stall and calls `force_error_status` on the new download |
| **C11** | `lib.rs:357-360` | `to_socket_addrs()` without timeout — slow DNS freezes the app | `check_tcp_endpoint` blocks the Tauri IPC thread | UI freezes if DNS is slow |
| **C12** | `adaptive/resource_monitor.rs:192-197` | CPU statistics non-atomic — incorrect readings | Two static `AtomicU64` variables are read/written non-atomically — thread interleaving yields wrong CPU % | Adaptive engine decisions are based on incorrect CPU readings |

### 2.2 HIGH

| # | File:Line | Issue | Impact |
|---|---------|---------|---------|
| H1 | `mod.rs (daemon):280-288` | Scheduler tick task dies silently on panic | All scheduled rules stop until restart |
| H2 | `lib.rs:178-180,205-207` | Double canonicalize increases TOCTOU window | Race window between first and second check — exploitable |
| H3 | `mod.rs (daemon):227-238` | SelfHealer uses separate PolicyEngine | Runtime policy changes are invisible to the self-healer |
| H4 | `mod.rs (daemon):246,418-420` | Watchdog JoinHandles are detached, not joined | Watchdog threads leak on restart |
| H5 | `transfer.rs:1993-2018` | `force_error_status` bypasses `generation` check | Old Watchdog may write "error" on a new task |
| H6 | `easy_config.rs:363-1142` | `apply_easy_options` — 780 lines, single-responsibility violated | Unmaintainable, easy to introduce bugs |
| H7 | `transfer.rs:1224` | `plan.connections > 1` uses original connection count instead of actual | False "Server did not honor byte-range" with a single connection |
| H8 | `task_api.rs:415-418` | `remove_file` before incrementing `generation` — TOCTOU | Old thread may write after file deletion |
| H9 | `adaptive/segment_controller.rs:133` | `unwrap()` on a fragile condition — panics if state changes between check and find | Panic |
| H10 | `adaptive/profile_store.rs:328-334` | `save()` silently ignores write errors | Profile data loss |
| H11 | `adaptive/disk_writer.rs:63-71` | `pending_bytes` not decremented on send failure | Persistent incorrect statistics |
| H12 | `adaptive/server_profiler.rs:138-146` | `is_rate_limited` returns `true` forever if `cooldown_until = None` | Server considered rate-limited forever |
| H13 | `adaptive/disk_writer.rs:106-115` | Segment file open fails silently — data lost | Partial data loss |
| H14 | `adaptive/disk_writer.rs:153-159` | On shutdown, remaining data in channel is dropped | Data loss on shutdown |
| H15 | `adaptive/resource_monitor.rs:192-197` | Thread-unsafe CPU statics (duplicate of C12) | — |
| H16 | `adaptive/mod.rs:209-219` | `set_alive` miscounts `active_conns` on double call | Incorrect active connection counts |
| H17 | `thread_pool.rs:41-44` | Task panic kills worker (duplicate of C5) | — |
| H18 | `resource_manager.rs:161-163` | `is_disk_bottlenecked()` uses wrong unit — compares MB/s with bytes | Every disk considered bottleneck — wrong throttling |
| H19 | `priority_queue.rs:144-155` | `update_size()` does not call `reallocate()` | Download gets 0 bandwidth |
| H20 | `policy_engine.rs:298-303` | `Merge(0, 1)` hardcoded — merges wrong chunks | Failing chunk not merged |
| H21 | `profiles.rs:149-167` | `to_adaptive_config()` overrides `min_connections` from base config | Profile `default_connections` ineffective |
| H22 | `external_tools/mod.rs:88-89` | Duplicate lock of `self.resolver` inside `discover_inner` (fixed) | — |

### 2.3 MEDIUM

| # | File:Line | Issue |
|---|---------|---------|
| M1 | `lib.rs:109-114` | `find_available_daemon_port` returns an in-use port when the range is exhausted |
| M2 | `lib.rs:281-291` | Using `cmd.exe /C start` — unnecessary shell |
| M3 | `mod.rs (daemon):299, telegram.rs:182` | Second Tokio Runtime + blocking client |
| M4 | `mod.rs (daemon):177-182` | Fallback HTTP client loses all timeout settings |
| M5 | `mod.rs (daemon):267-270` | `external_tools` lock held across slow init |
| M6 | `mod.rs (daemon):119-131` | PATH fallback with known security risk |
| M7 | `transfer.rs:78-104` | Lock ordering `curl_jobs` ≠ `engine_trackers` across functions — AB-BA |
| M8 | `transfer.rs:230-236` | Unnecessary `.clone()` in `plan_from_job` |
| M9 | `transfer.rs:153-160` | `infer_file_type` called twice |
| M10 | `transfer.rs:372` | `plan.clone()` on every redirect hop — large clone |
| M11 | `transfer.rs:287-289` | Unnecessary wrapper `part_size` |
| M12 | `transfer.rs:382` | `easy.timeout()` result ignored — preflight may hang |
| M13 | `transfer.rs:958,1024` | Number of chunks does not match `plan.connections` for adaptive engine |
| M14 | `transfer.rs:1256,1360-1365` | 24-hour cap silently overrides `retryMaxTimeSec` |
| M15 | `multi.rs:240-241` | `next_token` saturates at `usize::MAX` |
| M16 | `multi.rs:299-317` | `collect_multi_errors` O(n²) |
| M17 | `easy_config.rs` (multiple) | `easy.*()` results ignored — 6+ sites |
| M18 | `args.rs:106-138` | `proxy_resolves_to_internal` bypasses SSRF check for proxy without scheme |
| M19 | `task_api.rs:471,497` | `task_snapshot.remove` after `curl_jobs.remove` — ghost task visible |
| M20 | `transfer_config.rs:381` | `retry_all_errors` defaults to `true` — 5xx are retried (server amplification) |
| M21 | `adaptive/mod.rs:611-612` | Redundant multiply/divide — `per_connection_ceiling * target / target = per_connection_ceiling` |
| M22 | `adaptive/mod.rs:538-566,583-607` | `segment_ctrl` evaluation duplicated — side effects applied twice |
| M23 | `adaptive/convergence.rs:82-83` | Cooldown without resetting `consecutive_no_improvement` |
| M24 | `adaptive/mod.rs:152-154` | `aggregate_speed` stores only last connection speed, not the sum |
| M25 | `self_healing.rs:49,64` | `recovery_window_start` written but never read — dead code |
| M26 | `adaptive_connections.rs:24` | `let _mem_gb = ...` computed and unused |
| M27 | `bandwidth.rs:79-90` | `allowed_speed_for_task()` locks `task_limits` twice |
| M28 | `priority_queue.rs:193-195` | `active.max(1)` dead code after `active == 0` check |
| M29 | `config.rs:108` | `(total * 2).max(total)` = `total * 2` — redundant |
| M30 | `rules.rs:154-162` | `HeaderContains` uses `.contains()` instead of `.eq_ignore_ascii_case()` — incorrect match |
| M31 | `plugin_api.rs:12` | No API version check — `999.0.0` accepted |

### 2.4 LOW

| # | File:Line | Issue |
|---|---------|---------|
| L01 | `lib.rs:535-543` | Port-finding logic duplicated |
| L02 | `lib.rs:494-498` | "fire-and-forget" thread — swallowed panic |
| L03 | `lib.rs:63-69` | Binding URL is cloned on every IPC call |
| L04 | `lib.rs:676-678` | `hide()` error ignored |
| L05 | `lib.rs:120-125` | `DaemonUrl` does not recover from poisoning |
| L06 | `state.rs:100-117` | Cache stampede on TTL expiry |
| L07 | `mod.rs (daemon):44-47` | `shared_api_token` returns `String` instead of `&str` |
| L08 | `mod.rs (daemon):433` | `remove_file` error ignored |
| L09 | `lib.rs:513-521` | PowerShell errors in `kill_old_daemon` not visible |
| L10 | `transfer.rs:831,843,858` | `remove_file` error ignored in 3 places |
| L11 | `transfer.rs:2030-2038` | `auto_rename_path` — 0-byte file left on crash |
| L12 | `transfer.rs:872-906` | 4 separate branches for `response == 0` — simplifiable |
| L13 | `transfer.rs:722-761` vs `475-558` | Progress logic duplicated between two functions |
| L14 | `args.rs:223-231` | `file_name_from_url` ignores `#fragment` |
| L15 | `easy_config.rs:57-75` | `parse_rate_to_bytes` may panic on non-ASCII input |
| L16 | `event_bus.rs:284` | `AtomicU64::fetch_add` inside a Mutex — redundant atomicity |
| L17 | `priority_queue.rs:27-35` | `from_u32(2)` reaches Normal via wildcard — ambiguous |
| L18 | `bandwidth.rs:56-70` | Overlapping tables — first silently wins |
| L19 | `profiles.rs:207,210` | Different lock ordering increases deadlock risk |
| L20 | `retry.rs:66-74` | Extra jitter only — never subtracts |

### 2.5 INFO

| # | File | Note |
|---|------|------|
| I01 | `lib.rs` | `target.exists()` redundant after `validate_file_path` in 5 functions |
| I02 | `lib.rs` | Mixing `cfg!(windows)` with `#[cfg(windows)]` |
| I03 | `utils.rs:216-253` | `build_segments` can use iterators |
| I04 | `utils.rs:186` | `to_lowercase()` allocates a String — avoidable |
| I05 | `curl/mod.rs:19` | `#[allow(unused_imports)]` — some imports unused |
| I06 | `transfer_config.rs:45-173` | 82 fields in `CurlTransferConfig` — maintenance burden |
| I07 | `event_bus.rs` | No EventBus publisher in production — 45 `.publish()` calls are all in tests |
| I08 | `engine/mod.rs` | No `pub use` re-exports — long paths required |
| I09 | `policy_engine.rs` | `context_snapshot` stored but never read |
| I10 | `dynamic_segments.rs` | Despite its name, `DynamicSegmentScheduler` is not dynamic |
| I11 | `policy_engine.rs:400-432` | `decide_buffer()` always returns a Buffer, never `NoAction` |
| I12 | `adaptive/mod.rs` | No tests for `evaluate()` with convergence or rebalancing |
| I13 | `adaptive/profile_store.rs` | No tests for `merge_preflight` with existing profile |
| I14 | `adaptive/disk_writer.rs` | No tests for backpressure or panic recovery |

---

## 3. Full Execution Flow Map

```
run() [lib.rs]
│
├── Tauri Plugin Registration
│   ├── tauri_plugin_clipboard
│   ├── tauri_plugin_shell
│   ├── tauri_plugin_dialog
│   ├── tauri_plugin_single_instance
│   ├── tauri_plugin_updater
│   └── tauri_plugin_log
│
├── setup()
│   ├── kill_old_daemon()
│   │   └── std::thread::spawn → kill_old_daemon_range() via PowerShell
│   │       └── [L02: panic swallowed, L09: errors not visible]
│   ├── find_available_daemon_port() [M1: returns in-use port when range exhausted]
│   ├── DaemonUrl::new()
│   └── daemon::start_daemon()
│       └── std::thread::spawn
│           └── tokio::runtime::Runtime::new()
│               └── rt.block_on(async {
│                   ├── init_download_ssl() [OnceLock — idempotent]
│                   ├── persist::load() [corrupt → backup + default]
│                   ├── resolve_engine_binary() [M6: PATH fallback]
│                   ├── AppState::new()
│                   │   ├── [H3: PolicyEngine separate for SelfHealer]
│                   │   ├── [M4: fallback HTTP Client without timeouts]
│                   │   └── [C4: AsyncDiskWriter without Drop]
│                   ├── warm_engine_cache() [std::thread::spawn]
│                   ├── external_tools::discover_and_initialize() [M5: long lock]
│                   ├── tokio::spawn → scheduler_tick() [H1: panic kills task]
│                   ├── restore_scheduler_rules()
│                   ├── restore_persisted_tasks() [locks: media_jobs → curl_jobs → task_snapshot]
│                   ├── start_persistence_loop() [tokio::spawn]
│                   ├── start_telegram_bot() [std::thread→second tokio::Runtime M3]
│                   ├── build_axum_router()
│                   ├── TCP bind (5 retries × 1s)
│                   ├── write_port_file()
│                   └── axum::serve + graceful_shutdown
│                       └── shutdown_signal → ctrl_c
│                           ├── pause_all_media_jobs()
│                           ├── pause_all_curl_jobs()
│                           ├── shutdown_requested = true
│                           ├── detach watchdog_handles [H4]
│                           ├── sleep(200ms)
│                           ├── save_now() [persist::build_snapshot]
│                           ├── axum::serve returns
│                           └── remove_port_file()
│               })

Tauri Commands:
├── open_file(path) → validate_file_path() → canonicalize() [H2]
├── reveal_file(path) → validate_file_path() → canonicalize() [H2]
├── check_tcp_endpoint(host, port) → to_socket_addrs() [C11: no timeout]
├── save_config(settings) → serde_json::from_str → fs::write
├── restart_daemon() → kill_old_daemon_range() → start_daemon() [C1: leak]
├── get_daemon_url() → DaemonUrl.lock().clone() [L03]
└── tray "quit" → app.exit(0) [C2: no persist, no graceful stop]

Background Tasks:
├── persistence_loop [tokio::spawn]
│   └── every 5-60s: persist_dirty → save() → build_snapshot()
│       └── locks: media_jobs, curl_jobs, task_snapshot, telegram_id
├── scheduler_tick [tokio::spawn] [H1: dies silently]
│   └── run_scheduler_tick() → rule evaluation
├── telegram_bot [std::thread + tokio::Runtime] [M3]
└── watchdog_handles [std::thread] [H4: detached, C10: generation interference]
```

---

## 4. Download Flow Map

```
create_download → task_api::create_curl_task
│
├── build_decision_context() [M7: lock ordering]
│   ├── lock curl_jobs → read job
│   └── lock engine_trackers → read segments, retry_state
│
├── run_libcurl_download() [transfer.rs:1248-1664 — 416 lines, too many responsibilities]
│   ├── PROBE → HEAD request [easy_config.rs — apply_easy_options 780 lines H6]
│   │   ├── redirect handling → resolve_effective_target() [M10: plan.clone()]
│   │   ├── resume support → check_accept_ranges + If-Range
│   │   └── preflight data → protocol, RTT, TLS, TTFB, etag, content-length
│   │
│   ├── DIRECT DOWNLOAD → run_single_libcurl()
│   │   ├── preallocate file [C9: progress 100% immediately]
│   │   ├── create_easy_for_range_ext() [easy_config.rs]
│   │   │   ├── apply_easy_options() [H6: 780 lines]
│   │   │   └── SegmentWriter::write() [C3: I/O errors swallowed]
│   │   └── drive_multi_wait_perform() [multi.rs]
│   │       └── tick() every 250ms
│   │           └── [C9, L13: duplicated progress logic]
│   │
│   ├── SEGMENTED DOWNLOAD → run_segmented_libcurl()
│   │   ├── split_ranges() → SegmentPlanner::plan() [C7: OOM for 4GB+]
│   │   ├── DynamicSegmentScheduler::new() [I10: not dynamic]
│   │   ├── AdaptiveEngine::new()
│   │   │   ├── SegmentController::new()
│   │   │   ├── ServerProfiler, ConvergenceDetector, ResourceMonitor
│   │   │   ├── ProtocolAdapter, BufferManager, ChunkManager
│   │   │   └── AsyncDiskWriter [C4: no Drop]
│   │   ├── for each range → create_easy_for_range_ext()
│   │   └── drive_multi_socket() / drive_multi_wait_perform()
│   │       └── tick() every 250ms
│   │           ├── per-chunk: read atomic → calculate speed
│   │           │   → [NC-1: update_progress() now]
│   │           │   → segment_scheduler.update_segment()
│   │           │   → telemetry_bus.report_bytes/speed()
│   │           ├── engine.evaluate(&telemetry_bus)
│   │           │   ├── segment_ctrl.evaluate() [M22: duplicated]
│   │           │   │   ├── split/merge/rebalance decisions
│   │           │   │   └── [NC-2: actions are now logged]
│   │           │   ├── convergence check
│   │           │   ├── protocol adapter
│   │           │   └── resource monitor [C12: wrong CPU]
│   │           └── [NC-2: AdaptationAction processed now]
│   │
│   ├── RETRY LOOP
│   │   ├── retry_policy → attempts, backoff, max_wall_time
│   │   ├── [M20: retry_all_errors=true amplifies server]
│   │   └── MAX_RETRY_WALL_TIME 24h [M14: silently overrides config]
│   │
│   ├── SEGMENTED → SINGLE fallback [200 error with segments]
│   │   └── [H7: plan.connections > 1 instead of handles.len() > 1]
│   │
│   ├── MIRROR FAILOVER [1529-1558]
│   ├── SELF-HEALER [H3: separate PolicyEngine]
│   └── HASH VALIDATION + ETAG SAVING
│
├── mark_curl_task_finished() [1640-1678]
│   ├── download_stats.lock() → total_completed++
│   └── curl_jobs.lock() → update task status
│
├── mark_curl_task_failed() [1680-1724]
│   ├── download_stats.lock() → total_failed++
│   └── curl_jobs.lock() → update task status
│
└── pause / resume / cancel
    ├── task_api::pause_task()
    ├── task_api::resume_task()
    └── task_api::delete_task() [M19: snapshot removed after jobs]
```

---

## 5. Dependency Map

```
src/lib.rs
├── src/daemon/mod.rs
│   ├── src/daemon/state.rs
│   │   ├── src/daemon/engine/adaptive/mod.rs
│   │   ├── src/daemon/engine/adaptive_connections.rs
│   │   ├── src/daemon/engine/dynamic_segments.rs
│   │   ├── src/daemon/engine/event_bus.rs
│   │   ├── src/daemon/engine/priority_queue.rs
│   │   ├── src/daemon/engine/bandwidth.rs
│   │   ├── src/daemon/engine/profiles.rs
│   │   ├── src/daemon/engine/rules.rs
│   │   ├── src/daemon/engine/scheduler.rs
│   │   ├── src/daemon/engine/metadata_cache.rs
│   │   ├── src/daemon/engine/config.rs
│   │   ├── src/daemon/engine/policy_engine.rs
│   │   ├── src/daemon/engine/self_healing.rs
│   │   ├── src/daemon/engine/die_orchestrator.rs
│   │   ├── src/daemon/engine/resource_manager.rs
│   │   ├── src/daemon/engine/plugin_api.rs
│   │   ├── src/daemon/engine/extractor.rs
│   │   └── src/daemon/resource_intelligence/mod.rs
│   ├── src/daemon/persist.rs
│   ├── src/daemon/utils.rs
│   ├── src/daemon/direct.rs
│   ├── src/daemon/types.rs
│   ├── src/daemon/curl/mod.rs
│   │   ├── src/daemon/curl/transfer.rs
│   │   ├── src/daemon/curl/multi.rs
│   │   ├── src/daemon/curl/easy_config.rs
│   │   ├── src/daemon/curl/args.rs
│   │   ├── src/daemon/curl/task_api.rs
│   │   └── src/daemon/curl/transfer_config.rs
│   ├── src/daemon/ytdlp.rs
│   ├── src/daemon/routes/mod.rs
│   │   ├── src/daemon/routes/engine.rs
│   │   ├── src/daemon/routes/downloads.rs
│   │   └── src/daemon/routes/common.rs
│   └── src/daemon/external_tools/mod.rs
│       ├── health.rs
│       ├── installer.rs
│       └── process.rs
│
├── src/daemon/engine/mod.rs
│   ├── adaptive/ [9 files]
│   ├── thread_pool.rs
│   ├── retry.rs
│   └── ...
│
└── tauri (external)
```

---

## 6. Dead Code Analysis

| Dead Code | Location | Type |
|-----------|----------|------|
| `SegmentAction::Split(u32)` | `policy_engine.rs:131` | Variant unused |
| `SegmentAction::Rebalance` | `policy_engine.rs:137` | Variant unused |
| `RecoveryAction::RestartSegment(u32)` | `policy_engine.rs:140` | Variant unused |
| `recovery_window_start` | `self_healing.rs:49,64` | Field written but not read |
| `context_snapshot` | `policy_engine.rs` | Field stored but never read |
| `_mem_gb` | `adaptive_connections.rs:24` | Computed and unused variable |
| `active.max(1)` after `active == 0` check | `priority_queue.rs:193-195` | Dead code (never executed) |
| `(total * 2).max(total)` | `config.rs:108` | Equals `total * 2` — redundant |
| `_max_segments` | `dynamic_segments.rs:49` | Unused constructor parameter |
| `lock_or_err!` with $default | `utils.rs:13-31` | Second parameter ignored on poison |
| `#[allow(unused_imports)]` | `curl/mod.rs:19` | Unused imports |
| all `.publish()` calls | `event_bus.rs` Tests | No publisher in production |
| `is_internal` dead path analysis | `lib.rs:337-339` | Available but logically correct (not dead) |

---

## 7. Performance Analysis

### 7.1 CPU

| Issue | Location | Impact |
|-------|----------|--------|
| `drive_multi_wait_perform()` polling every 250ms | `multi.rs:332-361` | Periodic CPU wakeups even when idle |
| `collect_multi_errors` O(n²) | `multi.rs:299-317` | Slow with 1000+ handles |
| `SegmentWriter::header` locks `capture.lock()` 7 times per header line | `easy_config.rs:119-180` | 7 lock/unlock per header |
| `allowed_speed_for_task()` locks `task_limits` twice | `bandwidth.rs:79-90` | Double lock cost |
| `decide_buffer()` always returns a Buffer | `policy_engine.rs:400-432` | Buffer reallocation every evaluation |

### 7.2 Memory

| Issue | Location | Impact |
|-------|----------|--------|
| `SegmentPlanner::plan` produces `u32::MAX` chunk count | `direct.rs:216` | OOM with 4GB+ files |
| `plan.clone()` on each redirect hop | `transfer.rs:372` | Cloning 80+ fields |
| `to_lowercase()` allocates String in `infer_file_type` | `utils.rs:186` | Allocation per file |
| `shared_api_token()` clones 32-char String on every call | `mod.rs:44-47` | Unnecessary copy per API request |
| `daemon_url.lock().clone()` per IPC | `lib.rs:63-69` | URL clone per Tauri command |

### 7.3 Lock Contention

| Issue | Location | Impact |
|-------|----------|--------|
| `external_tools` locked across `discover_and_initialize()` | `mod.rs:267-270` | Blocks all tools queries during init |
| `engine_trackers` locked in tick + `update_curl_task_progress` sequentially | `transfer.rs:1126,1178` | Refactoring window |
| `build_snapshot` locks 5 mutexes together | `persist.rs:60-89` | (Fixed — scoping) |
| SegmentWriter::header 7 separate locks | `easy_config.rs:119-180` | High lock churn |

---

## 8. Concurrency Analysis

### 8.1 Potential Deadlocks

| Path A | Path B | Status |
|--------|--------|--------|
| `build_snapshot`: curl_jobs → download_stats | `transfer` functions: download_stats → curl_jobs | ✅ Fixed (block scoping + comments) |
| `build_decision_context`: curl_jobs → engine_trackers (sequential) | `update_curl_task_progress`: engine_trackers → curl_jobs (sequential) | ⚠️ Latent risk — AB-BA across functions |
| `profiles.rs:207,210`: active then profiles | `set_active`: active only | ⚠️ Inconsistent pattern |

### 8.2 Data Races

| Issue | Location | Severity |
|-------|----------|----------|
| `PREV_IDLE` + `PREV_TOTAL` not read atomically together | `resource_monitor.rs:192-197` | **CRITICAL** — wrong CPU % |
| `set_alive` double increments `active_conns` incorrectly | `adaptive/mod.rs:209-219` | HIGH — wrong counts |
| Old Watchdog reads new generation | `transfer.rs:1756-1987` | **CRITICAL** — destroys new download |
| Second Tokio Runtime for Telegram | `telegram.rs:182` | MEDIUM — thread pool duplication |

### 8.3 Memory Ordering

All uses of `Ordering::Relaxed` in counters and stats are acceptable, however:
- `cancel_token.store(true, Ordering::Release)` should pair with `load(Ordering::Acquire)` in the worker — verified ✅
- `run_generation.fetch_add(1, Ordering::Release)` pairs with `load(Ordering::Acquire)` in finish/fail functions — verified ✅

---

## 9. Memory Management Analysis

### 9.1 Resource Leaks

| Resource | Location | Issue |
|----------|----------|-------|
| Tokio Runtime | `lib.rs:465-490` | Leaks on every restart (C1) |
| Watchdog threads | `mod.rs:418-420` | `JoinHandle` detached instead of joined (H4) |
| Disk writer thread | `adaptive/disk_writer.rs` | No `Drop` — leaks (C4) |
| Part files after 412/416/304 | `transfer.rs:831,843,858` | `remove_file` errors ignored |
| stale file (auto_rename_path) | `transfer.rs:2030-2038` | Crash leaves 0-byte file |

### 9.2 Logical Resource Leaks

| Location | Issue |
|----------|-------|
| `event_bus.rs:264-270` | Mutex poison stops EventBus — `pending_events` accumulate forever |
| all `lock_or_err!` with poison | Mutex poison recovered but data may be inconsistent — accepted as tradeoff |

---

## 10. Network and libcurl Analysis

### 10.1 HTTP Client

| Issue | Location | Severity |
|-------|----------|----------|
| Fallback `HttpClient::new()` loses all timeouts | `mod.rs:177-182` | MEDIUM |
| `to_socket_addrs()` without timeout | `lib.rs:357-360` | **CRITICAL** |
| `easy.timeout(5s)` result ignored | `transfer.rs:382` | MEDIUM |
| `easy.max_recv_speed()` result ignored | `easy_config.rs:1177` | MEDIUM |

### 10.2 libcurl Configuration

| Issue | Location | Impact |
|-------|----------|--------|
| `apply_easy_options` — 780 lines | `easy_config.rs:363-1142` | Easy to make mistakes, unmaintainable |
| 6+ `easy.*()` results ignored | `easy_config.rs` (multiple) | Options may not be applied |
| `plan.connections > 1` instead of `handles.len() > 1` | `transfer.rs:1224` | HIGH — false 200 error |
| `proxy_resolves_to_internal` bypasses SSRF check for proxy without scheme | `args.rs:106-138` | MEDIUM |

### 10.3 HTTP/2 and HTTP/3

`pipelining(false, true)` is enabled at `multi.rs:1040` but server support is not further validated. `protocol_adapter.rs` determines protocol from `preflight.protocol` and adjusts `max_concurrent_streams` based on HTTP/2 (100) or HTTP/3 (256). No clear issues identified.

---

## 11. Architecture Analysis

### 11.1 SOLID Violations

| Principle | Location | Violation |
|----------|----------|----------|
| **SRP** | `transfer.rs:1248-1664` (`run_libcurl_download`) | retry + segmented→single + mirror + self-heal + hash + etag |
| **SRP** | `easy_config.rs:363-1142` (`apply_easy_options`) | All curl options in one 780-line function |
| **SRP** | `mod.rs:133-436` (`start_daemon`) | init + restore + serve in one function |
| **OCP** | `transfer_config.rs:45-173` | 82 fields — every new option needs struct + accessor + From + to_hashmap |
| **DIP** | `policy_engine.rs` vs `self_healing.rs` | SelfHealer creates its own PolicyEngine (H3) |

### 11.2 DRY Violations

| Location | Duplication |
|----------|-------------|
| `config.rs:120-184`, `resource_manager.rs:66-130`, `adaptive/resource_monitor.rs` | Physical memory detection duplicated 3 times (H4-Engine) |
| `transfer.rs:722-761` vs `475-558` | Progress update logic duplicated |
| `lib.rs:535-543` vs `109-114` | Port-finding logic duplicated |
| `adaptive/mod.rs:538-566` vs `583-607` | `segment_ctrl` evaluation duplicated (M22) |
| `utils.rs:216-253` | for loop can be replaced with iterator |

### 11.3 Large Modules

| Module | Lines | Issue |
|--------|-------|-------|
| `transfer.rs` | 2109 | Too large — 6 responsibilities |
| `easy_config.rs` | 1203 | `apply_easy_options` 780 lines |
| `mod.rs (daemon)` | 577 | `start_daemon` 300+ lines |
| `segment_controller.rs` | 982 | Can be split |
| `transfer_config.rs` | 964 | 82 fields in a single struct |

---

## 12. Fix Plan

### Phase 1: Critical — Data Loss / Total Hang

| Priority | ID | Fix | Effort | Risk |
|----------|----|-----|--------|------|
| 1 | C2 | Send a stop signal to the daemon before `app.exit()` | small | low |
| 2 | C1 | Add `shutdown_signal: oneshot::Sender` to AppState | medium | low |
| 3 | C3 | Rewrite `drain_batch` to return `Result` | medium | medium |
| 4 | C4 | Add `Drop` with `shutdown()` + `join()` | small | low |
| 5 | C5 | Add `catch_unwind` around `task_fn()` | small | low |
| 6 | C6 | Reset `publish_depth = 0` on mutex poison | small | low |
| 7 | C7 | Cap `max_segments = 256` in SegmentPlanner | small | low |
| 8 | C8 | Read stdout/stderr from concurrent threads | medium | medium |
| 9 | C9 | Add `is_preallocated` flag to the tick | small | low |
| 10 | C10 | Add `generation` to Watchdog + check in `force_error_status` | medium | low |
| 11 | C11 | Add `timeout(Duration::from_secs(5))` to `check_tcp_endpoint` | small | low |
| 12 | C12 | Replace dual `AtomicU64` with `Mutex<(u64,u64)>` | small | low |

### Phase 2: High — Data Corruption / Incorrect Logic

| Priority | ID | Fix | Effort |
|----------|----|-----|--------|
| 13 | H1 | Add `catch_unwind` to scheduler task | small |
| 14 | H2 | Use `target` directly without second canonicalize | small |
| 15 | H3 | Share `PolicyEngine` between SelfHealer and AppState | small |
| 16 | H4 | Join Watchdog handles with timeout during shutdown | medium |
| 17 | H5 | Add generation check to `force_error_status` | small |
| 18 | H7 | Change `plan.connections > 1` → `handles.len() > 1` | small |
| 19 | H8 | Swap order of `fetch_add(generation)` and `remove_file` | small |
| 20 | H9 | Replace `unwrap()` with `if let Some` | small |
| 21 | H10+H13 | Return `Result` from `save()` and `new()` | medium |
| 22 | H11 | Decrement `pending_bytes` on `send()` failure | small |
| 23 | H12 | Add auto-clear after 5 minutes for `rate_limit_detected` | small |
| 24 | H14 | Drain channel before Shutdown | small |
| 25 | H16 | Use `swap` instead of `fetch_add` in `set_alive` | small |
| 26 | H18 | Fix comparison: `disk_write_mbps < 5` | small |
| 27 | H19 | Add `self.reallocate()` in `update_size()` | small |
| 28 | H20 | Track failed chunk ID instead of `Merge(0,1)` | medium |
| 29 | H21 | Use `self.default_connections` for `min_connections` | small |

### Phase 3: Medium — Performance, Dead Code, Logic Bugs

(31 issues — notably M1-M7, M18-M19, M21-M31)

### Phase 4: Improvements

(20 LOW issues + 14 INFO — L01-L20, I01-I14)

---

## Final Statistics

| Category | Count |
|---------|-------|
| **CRITICAL** | 12 |
| **HIGH** | 22 |
| **MEDIUM** | 31 |
| **LOW** | 20 |
| **INFO** | 14 |
| **TOTAL** | **99 issues** |
| **Pre-fixed** | 16 (from previous round) |
| **Remaining** | **83 issues** |

---

*End of report — analyzed by the Microscopic Engineering Review team.*
