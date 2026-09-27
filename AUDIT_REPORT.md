# NOVA Daemon Engine Audit Report

Scope: all files under `src-tauri/src/daemon/engine/` plus the live consumers in
`daemon/curl/transfer.rs`, `daemon/routes/engine.rs`, `daemon/mod.rs`,
`daemon/state.rs`, `daemon/persist.rs`, `daemon/routes/downloads.rs`, `daemon/curl/task_api.rs`,
`daemon/curl/easy_config.rs`.

Method: line-by-line read of every engine file; production call-graph verified with
project-wide grep; no "looks fine" statements — each file either has findings or an
explicit verified-clean note.

Legend: HIGH = wrong behavior or dead feature in production. MEDIUM = real bug but
bounded, or dead-with-misleading-surface. LOW/INFO = latent, cosmetic, or note.

---

## 1. The two system-level findings

### 1.1 [HIGH] The entire adaptive engine is implemented but DISABLED in production
- FILE: `src-tauri/src/daemon/curl/transfer.rs:1236-1252`
- FUNCTION: `perform_transfer` tick
- DESCRIPTION: `AdaptiveEngine` is instantiated per task (transfer.rs:1022) and only
  `engine.segment_ctrl.update_progress(i, downloaded, speed)` is called every tick.
  The code comment states it explicitly: *"Adaptive engine evaluate() and decision
  application are disabled — the decisions (target_connections, segment split/merge/etc.)
  have no code path that reconfigures the active curl multi handle's easy handles."*
- IMPACT: `AdaptiveEngine::evaluate` (adaptive/mod.rs:448-665), `ConvergenceDetector`,
  `ProtocolAdapter`, `ServerProfiler` feedback, all `AdaptationAction`s,
  `SegmentController::evaluate`/`apply_plan`, `ChunkManager`, and
  `BufferManager::recommend` are dead in production. The connection count is fixed at
  plan time for the life of each download. The UI surfaces resolved adaptive
  config (routes/engine.rs:371-384) that the engine never uses.
- FIX: either implement the apply path (grow/shrink easy-handle count, split/merge
  ranges, apply per-connection limits) or delete the subsystem. Do not ship half-wired.

### 1.2 [HIGH] `die_orchestrator` / `UnifiedProfileStore` write path is dead; the store is permanently empty
- FILE: `src-tauri/src/daemon/engine/die_orchestrator.rs:16` (all methods),
  `profile_store.rs` writes, consumer `transfer.rs:87-102`
- DESCRIPTION: `DieOrchestrator` is constructed (state.rs:101) but none of its methods
  are called outside tests (`#[allow(dead_code)]`). Its `UnifiedProfileStore` is
  READ in production (transfer.rs:90-94 feeds `DecisionContext.stability/throughput/
  per_conn/rate_limited`) but nothing ever WRITES it, and it loads from a file that
  nothing writes. Result: those DecisionContext fields are always `(0.5, 0, 0, false)`.
- FIX: wire `merge_telemetry`/`record_preflight` into the transfer tick, or remove the
  read path.

---

## 2. HIGH-severity findings

### H1 [HIGH] `pause_all()` is a no-op — paused downloads run at FULL speed
- FILE: `src-tauri/src/daemon/engine/bandwidth.rs` (`allowed_speed_for_task` returns 0
  when paused); consumer `src-tauri/src/daemon/curl/transfer.rs:712-718`
- FUNCTION: `allowed_speed_for_task` / segment limit resolution
- DESCRIPTION: 0 is overloaded as "unlimited". `transfer.rs:713` maps `0 → None` →
  no `CURLOPT_MAX_RECV_SPEED_LARGE` → download continues at full speed while the UI
  reports it paused. Pause only freezes the countdown, not the transfer.
- FIX: return `Some(0)` + `CURLOPT_LOW_SPEED_LIMIT` semantics for paused, or
  block at the transfer loop, and keep `None` meaning "no limit".

### H2 [HIGH] Scheduler actions are level-triggered and re-fire every 60s tick
- FILE: `src-tauri/src/daemon/engine/scheduler.rs`; tick driver `daemon/mod.rs:437-477`,
  `routes/engine.rs:571-695`
- FUNCTION: `run_scheduler_tick` / scheduler evaluation
- DESCRIPTION: `AllComplete + Shutdown/Sleep` and `Notify`/`Pause` actions re-fire on
  every tick while their condition holds, because `task_snapshot` retains completed
  tasks indefinitely (cap 10k) and no per-episode edge detection exists. A machine
  whose schedules match "when idle" can be shut down/slept repeatedly and emit
  Notify spam; action-issued events queue behind the same re-fire.
- FIX: mark conditions as edge-triggered (fire once per schedule pass / per episode)
  or remove fired actions for the current interval.

### H3 [HIGH] `hlsDashDownload` never becomes true
- FILE: `src-tauri/src/daemon/engine_capabilities.rs:1504`
- FUNCTION: `parse_media_manifest` / capabilities status
- DESCRIPTION: `formats.contains("mov,mp4,m4a,3gp,3g2,mj2")` checks the exact combined
  string but the parser splits the CSV into tokens, so the literal multi-format string
  is never present → HLS/DASH downloads are never advertised despite being supported.
- FIX: split on `,` and check each token.

### H4 [HIGH] `CANDIDATE_CURL_RAW_OPTIONS` is empty → rawOptions always rejected
- FILE: `src-tauri/src/daemon/engine_capabilities.rs:205` (see full analysis in section 4)

### H5 [HIGH] Whole-engine dead policy code: `decide_connections/segments/buffer/throttle/should_rollback`
- FILE: `src-tauri/src/daemon/engine/policy_engine.rs` (`#![allow(dead_code)]` at top,
  decide_* only referenced in tests); production only calls `decide_retry` (transfer.rs:1620)
  and `decide_recovery` (transfer.rs:1606).
- FUNCTION: policy_engine API
- DESCRIPTION: The connection/segment/buffer/throttle decisions, `should_rollback`,
  `recent_decisions`, and `DecisionContext` resource fields are computed but never used
  in production. `RecoveryAction::PauseAndRetry` is wired in transfer.rs:1606-1611 but
  `decide_recovery` never emits it (and RetryConnection/RestartSegment/
  ResumeFromCheckpoint are not handled in the transfer match).

### H6 [HIGH] `AdaptiveConnectionManager` has no adaptive logic
- FILE: `src-tauri/src/daemon/engine/adaptive_connections.rs:38-73`
- DESCRIPTION: wraps four atomics + `report_speed()`; no eval loop, no thresholds, no
  stall detection, no adjustment. `AdaptiveConfig` fields (`stall_threshold`,
  `eval_interval`, speed thresholds) are never read. `AdaptiveConfig` only exists as a
  decorative "resolved" section in the profiles endpoint. (See section 1.1.)
- FIX: remove, or implement the engine and wire it.

---

## 3. MEDIUM findings

### M1 [MEDIUM] retry jitter is ALWAYS zero
- FILE: `src-tauri/src/daemon/engine/retry.rs:69-74`
- FUNCTION: `delay_for_attempt`
- DESCRIPTION: `dur.as_secs() + u64::from(dur.subsec_nanos())` then `% jitter_range`
  — `as_nanos` is exactly divisible by `capped/4` in f64, so the modulo is always 0.0.
  The thundering-herd mitigation never works; all clients retry in lockstep.
- FIX: integer math: `dur.as_nanos() % jitter_range.as_nanos()`.

### M2 [MEDIUM] `ThreadPool::with_size(0)` panics (index / mod-by-zero)
- FILE: `src-tauri/src/daemon/engine/thread_pool.rs:74-78`
- FUNCTION: `ThreadPool::spawn` dispatch
- DESCRIPTION: zero workers → `worker_txs[idx]` index-out-of-bounds / `% 0`. Not
  reachable via config (cpus ≥ 1) but a public API footgun; also `let _ = tx.send`
  silently drops tasks and queues are unbounded.
- FIX: reject 0 in `with_size`; make `spawn` return `Result`; bound the queue.

### M3 [MEDIUM] Event bus `publish_depth` is global, not per-thread
- FILE: `src-tauri/src/daemon/engine/event_bus.rs` (`publish_depth`, `pending_events`)
- FUNCTION: `publish`
- DESCRIPTION: depth accounting is process-global, so concurrent publishers all queue
  into the unbounded `pending_events` until the *publishing thread* finishes Phase 2.
  One slow subscriber stalls all publishers; `pending_events` can grow unboundedly.
- FIX: `thread_local!` depth + bounded queue with drop-oldest.

### M4 [MEDIUM] Scheduler aborts later actions when power commands are disabled
- FILE: `scheduler.rs` tick handler; driver `routes/engine.rs:571-695`
- FUNCTION: scheduler action application
- DESCRIPTION: when `power_commands_enabled()` is false the handler `return`s after the
  first disabled action, skipping the remaining actions in the tick.
- FIX: `continue` instead of `return`.

### M5 [MEDIUM] `priority_queue::reallocate` dilutes active tasks' bandwidth share
- FILE: `src-tauri/src/daemon/engine/priority_queue.rs`
- FUNCTION: `reallocate`
- DESCRIPTION: splits bandwidth across queued AND active entries, so a heavily queued
  system halves the per-active share; `allocated_kbps` is only UI-visible (not applied
  to throttle), so this is cosmetic today but misleading.

### M6 [MEDIUM] Bandwidth limit changes only apply at easy-handle creation
- FILE: `src-tauri/src/daemon/curl/easy_config.rs:591-604`; consumer `transfer.rs`
- FUNCTION: rate-limit application
- DESCRIPTION: `set_global_limit` / per-task limits take effect only on the next
  easy-handle build; in-flight transfers keep their old `MAX_RECV_SPEED`. Live
  limit changes (bandwidth endpoints, profile switch) silently do nothing until restart.
- FIX: push the new limit into active handles / the tick.

### M7 [MEDIUM] Mirror failover re-adds duplicate mirrors and marks only the first unhealthy
- FILE: `src-tauri/src/daemon/engine/mirror.rs:55-60, 102-113`; driver `transfer.rs:1632-1661`
- FUNCTION: `add_mirror` / `report_failure`
- DESCRIPTION: every failed attempt re-adds all link mirrors (no dedup) → unbounded
  list; `report_failure` marks only the FIRST url match unhealthy, so the duplicate
  healthy copy of the same dead URL can be selected and returned as the "new" mirror.
- FIX: upsert by url; mark all copies unhealthy.

### M8 [MEDIUM] Resource monitor is a stub on non-Windows
- FILE: `src-tauri/src/daemon/engine/adaptive/resource_monitor.rs:214-217, 267-270, 278-281`
- FUNCTION: `estimate_cpu_usage` / `sample_memory` / `sample_disk_io`
- DESCRIPTION: on Linux/macOS memory is hardcoded 2048 MB, disk = (0,false), CPU logs
  a WARN every sample and returns 0.0. `ResourceMonitor` IS live via
  `ResourceManager::snapshot()` (transfer.rs:105), so non-Windows DecisionContext
  resource fields are always stub values and log spam occurs per transfer tick.
- FIX: /proc/stat + /proc/self/io on Linux; sysctl/Getrusage on macOS; don't warn per sample.

### M9 [MEDIUM] `TelemetryBus::report_speed` aggregate is racy and can underflow
- FILE: `src-tauri/src/daemon/engine/adaptive/mod.rs:147-161`
- FUNCTION: `report_speed`
- DESCRIPTION: per-slot delta applied to `aggregate_speed` via fetch_add/fetch_sub is
  not atomic with the slot swap; two concurrent updates on the same slot mis-apply.
  `fetch_sub(prev - speed)` can underflow u64 (release build → ~2^64), and the last
  speed of a finished connection is never subtracted (aggregate goes stale).
- FIX: recompute aggregate from slots in `snapshot()` (as `total_bytes` already does).

### M10 [MEDIUM] `SegmentController::apply_plan` Rebalance double-downloads overlapped bytes
- FILE: `src-tauri/src/daemon/engine/adaptive/segment_controller.rs:454-480`
- FUNCTION: `apply_plan`
- DESCRIPTION: shrinking the slow segment and extending the fast segment's start does
  not offset the fast segment's `downloaded`, so the overlapped tail is re-downloaded;
  with non-idempotent server content this can corrupt the file. (Currently disabled by
  1.1, but latent.) `merge_adjacent_segments` (525-546) also discards segment b's
  downloaded progress.

### M11 [MEDIUM] `BufferManager::recommend` is unreachable in production
- FILE: `src-tauri/src/daemon/engine/adaptive/buffer_manager.rs:47`
- DESCRIPTION: only caller chain `resource_manager.update_network` ←
  `die_orchestrator.record_telemetry` is dead (see 1.2). Buffer sizes in the live
  `ResourceManager::snapshot()` are always the constructor defaults.

### M12 [MEDIUM] Plugin API exposes a registry with no runtime
- FILE: `src-tauri/src/daemon/engine/plugin_api.rs:13` (`hooks`)
- DESCRIPTION: `PluginManifest.hooks` is never executed; no plugin loading, no
  dispatch, no api_version validation; nothing is persisted (restart loses plugins).
  The endpoints (routes/engine.rs:837-911) are metadata bookkeeping only.

---

## 4. LOW findings

- **L1 [LOW]** `retry.rs` `delay_for_attempt` caps at 4 tries and the "capped" branch
  discards base_delay scaling; retry max_delay semantics unclear vs RetryPolicy.
- **L2 [LOW]** `thread_pool.rs` `ThreadPool::spawn` is dead code in production (pool
  only used for `active_count` metrics, which are always 0/1).
- **L3 [LOW]** `scheduler.rs` mac sleep path uses `systemctl` (Linux-only); silently
  fails on macOS.
- **L4 [LOW]** `priority_queue.rs` queue-budget `-0.5` and `bw_pool` accounting are
  inconsistent across reallocate paths (cosmetic).
- **L5 [LOW]** `chunk_manager.rs` `remove(0)` is O(n); `network_samples` never read;
  rtt comment/implementation mismatch. NOTE: confirmed NOT dead code per-se (field of
  AdaptiveEngine) but effectively inert under 1.1.
- **L6 [LOW]** `event_bus.rs` `[allow(dead_code)]` hides a large unused surface
  (status_history, rule engine event helpers) — see E6/E7 notes.
- **L7 [LOW]** `self_healing.rs` only `on_failure` is live (transfer.rs:1581-1582);
  everything else dead; recovery budget is global 20/min shared across all hosts;
  `recovery_window_start` never read.
- **L8 [LOW]** `rules.rs` UrlExtension matching lowercases the URL but not the
  configured extension (`["MP4"]` never matches); duplicate rule ids not rejected;
  invalid regex silently inert.
- **L9 [LOW]** `downloads.rs` rule ordering: a low-priority `SetRateLimit` can stick
  because a later high-priority `SetProfile` only sets the limit when `None`.
- **L10 [LOW]** `adaptive_connections.rs` `_mem_gb` unused; thresholds unused (dead).
- **L11 [LOW]** `resource_manager.rs` `disk_budget_per_connection` is a hardcoded
  100 MB/s constant, not detected; `is_disk_bottlenecked()` silently false when the
  monitor returns 0.
- **L12 [LOW]** `convergence.rs:81-86` cooldown elapsed check is always true
  (`last_adjustment` set to now immediately before), so the 10s cooldown always fires
  on the 2nd no-improvement.
- **L13 [LOW]** `server_profiler.rs:162-165` `per_connection_ceiling` is stomped to the
  aggregate `throughput_ceiling`; thresholds derived from it are wrong.
- **L14 [LOW]** `mirror.rs` `add_mirror` re-sorts but does not fix `active_mirror`
  index; global per-task cooldown makes the caller retry the same dead URL.
- **L15 [LOW]** `plugin_api.rs` / `metadata_cache.rs` `cached_at` is a caller-supplied
  String while the entry also keeps an `Instant`; dual time sources.
- **L16 [LOW]** `sysinfo.rs` falls back to 4 GiB on detection failure (fine, but
  memory pressure can be off on exotic systems).
- **L17 [LOW]** `adaptive/mod.rs:567,611` `AdaptationAction::SplitSegment` always
  `at_byte: 0` (would re-download if wired).
- **L18 [LOW]** `engine_capabilities.rs:763` `"skipExisting" => true` claimed without a
  runtime gate; `retryConnRefused` unconditional true; `tcpFastOpen`/
  `happyEyeballsTimeoutMs` unreachable arms (804-808).

---

## 5. INFO / verified-clean notes

- **I1 [CLEAN]** `checksum.rs` — no correctness issues found. (Minor: hex input not
  validated; read errors reported as actual="error").
- **I2 [CLEAN]** `sysinfo.rs` — correct FFI layout/usage; platform fallbacks fine.
- **I3 [CLEAN]** `metadata_cache.rs` — eviction before insert, cap respected, lazy TTL.
  (Full header map stored in memory; not exposed today.)
- **I4 [CLEAN]** `profiles.rs` — `ProfileManager` lock order consistent (no ABBA);
  active-profile fallback documented and tested. `to_retry_policy`/`to_adaptive_config`
  used by the profiles endpoint (but see PR1 in notes: resolved adaptive config never
  reaches the runtime).
- **I5 [CLEAN]** `extractor.rs` — registry fine; `engine_status()` trait method is
  implemented in CurlExtractor/YtDlpExtractor but never called (dead).
- **I6** `engine_capabilities.rs` — F5-F11 INFO items in notes (yt-dlp list parsing,
  hidden_output duplication, 5 subprocess spawns per ffmpeg_status, `available` always
  true, `socksProxy` check likely false).
- **I7** `event_bus.rs` rotation arithmetic verified correct (E2); `publish_depth`
  design bug only (M3).
- **I8** `dynamic_segments.rs` — live for progress ingestion + `segments()` read
  (transfer.rs:74-84) but its decision/rebalance path is unused (same as 1.1).
- **I9** `resource_manager.rs` `snapshot()` is live (transfer.rs:105); thread_pool
  metrics always 0/1.

---

## 6. Cross-cutting recommendations (in priority order)

1. **Unify the three parallel retry implementations** — `engine/retry.rs`, transfer's
   local `RetryPolicy` handling, and `policy_engine::decide_retry` (PE4/PE5). Fix the
   jitter bug (M1) in the single survivor.
2. **Resolve pause semantics** (H1) before touching anything else — data-leak-level
   user expectation.
3. **Decide and document the adaptive/engine vision**: either ship the apply path or
   strip the inert layers (1.1, 1.2, H5, H6, M11, M12, L2, L17). The current state
   couples large dead code with misleading UI/API surface.
4. **Add the missing throttle-apply path** (M6) and wire profile/limit changes into
   live easy handles.
5. **Serialize/edge-trigger scheduler actions** (H2, M4).

---

## 7. Closure log (2026-08-01)

All findings in this report were addressed in the repair campaign (see
[REPAIR_PLAN.md](REPAIR_PLAN.md) and [docs/testing/REPAIR_COVERAGE.md](docs/testing/REPAIR_COVERAGE.md)):

- **1.1 — Adaptive engine shipped**: decisions are now applied live to easy
  handles (split/merge/rebalance + connection redistribution) with a debounced
  rebuild loop; verified by `adaptive_segmented_download_grows_and_completes`.
- **1.2 — DieOrchestrator write path wired**: `record_preflight` on start and
  `record_telemetry` every tick feed the UnifiedProfileStore.
- **H1 — Pause is real**: `RateLimit::{Unlimited,Limit,Paused}` + a pause gate
  in both drive loops; integration test proves bytes stall and resume works.
- **H2 — Scheduler edge-triggered**; **H3/H4 — capability claims honest**;
  **M6 — live rate limits** via `set_live_rate` on raw handles each tick;
  **M9 — TelemetryBus race-free**; **M10 — prefix-segment rebalance**;
  **M1/L20 — symmetric jitter**; **A15 — no implicit low-speed abort**;
  plus M2/M3/M4/M5/M7/M12/M15/M25/M27/M28/M29/M30, L3/L8/L13/L18, and the
  frontend/i18n fixes (novaClient without window, translations loader,
  bridgeStore sync, pl.ts encoding).

*Notes file: `C:\Users\Alaa\AppData\Local\Temp\opencode\audit_notes.md` (all
F/R/T/C/E/S/P/CH/BW/CHK/DS/SH/PE/RU/DIEO/RM/SYS/AC/PL/EX/MC/M/PR/BM/CV/PA/RMON/
PS/SP/SC entries, including per-item fix sketches).*
