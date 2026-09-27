# Comprehensive Repair Plan — NOVA Download Manager

**Date:** 2026-08-01
**Reference:** [AUDIT_REPORT.md](AUDIT_REPORT.md) (daemon engine audit) + [code-audit-report.md](code-audit-report.md) (microscopic audit, 99 issues) + field verification of current code (line-by-line for critical points).
**Basis:** decisions approved — ship the adaptive engine fully, cover all categories in one pass, and test every fix.

---

## 1. Executive Summary

NOVA is a large project (Tauri + Rust daemon + React + MV3 browser extension) with good security posture and a professional delivery pipeline, but it carries distributed technical debt as follows:

| Category | Count (per audit) | Verified fixed | Still present & confirmed |
|---|---:|---:|---:|
| CRITICAL | 12 | 11 | 1 (post-C12 conversion paths) |
| HIGH | 22 | ~15 | ~7 |
| MEDIUM | 31 | ~8 | ~23 |
| LOW / INFO | 34 | ~6 | ~28 |

Key findings I personally verified in the current code:

1. Pause issue — worst for user expectations: `allowed_speed_for_task` returns `0` on pause (bandwidth.rs:76-80), and transfer.rs:712-716 converts `0 → None` → does not set `MAX_RECV_SPEED` → **paused download continues at full speed**.
2. Fully implemented adaptive engine but disabled in production: `AdaptiveEngine::evaluate` and its decisions (split/merge/rebalance/change connections) have no path that modifies live easy handles (transfer.rs:1247-1252 — explicit comment). This makes ~6 whole modules (PolicyEngine, SegmentController, BufferManager, ChunkManager, ConvergenceDetector, ServerProfiler) dead code, while the API/UI surface shows decisions that are not applied.
3. `hlsDashDownload` will never be true: engine_capabilities.rs:1504 checks the composite string `"mov,mp4,m4a,3gp,3g2,mj2"` while `formats` is a list of comma-separated tokens (sorted_vec) — the condition is impossible to satisfy.
4. `CANDIDATE_CURL_RAW_OPTIONS` is empty: engine_capabilities.rs:205 — `rawOptions` is always rejected despite full verification code existing.
5. jitter errors for retry: retry.rs:69-74 — adding then `%` on an f64 range produces zero jitter always (no crowd differentiation).
6. Speed limits are not applied to live transfers: M6 — changing the limit only takes effect when a new easy handle is created.
7. Scheduler is level-triggered: H2 — Shutdown/Sleep/Notify actions re-fire every 60s while the condition holds, and M4: a `return` instead of `continue` drops remaining actions when power commands are disabled.
8. Race in `TelemetryBus::report_speed`: M9 — fetch_add/fetch_sub are non-atomic with slot switching and can underflow; last connection speed is not subtracted when it ends.
9. Harmful default in easy_config.rs:646-647: `low_speed_limit(500) + low_speed_time(15s)` cuts off any legitimate download slower than 500 B/s.
10. Double lock and profile silently swallows writes: bandwidth.rs `remove_task_limit` (3 nested locks), and profile_store.rs `save()` swallows write errors.

---

## 2. Strategic Decisions (Approved + Proposed)

| Decision | Status |
|---|---|
| Adaptive engine: ship fully (apply decisions to live easy handles) | ✅ approved by user |
| Scope of the run: all categories in one pass (staged, each stage is one PR keeping CI green) | ✅ approved by user |
| Test every fix (red → green) | ✅ approved by user |
| Dynamic connection reduction: soft (natural completion + restricting growth via convergence) in initial release; hard budgeted reduction later | Proposed — depends |
| Adaptive engine enabled by default for segmented downloads with known size, with key `direct_options["adaptive"]=false` to disable | Proposed — depends |
| Add `start_byte/end_byte` to `Segment` with `#[serde(default)]` (required for resume correctness after architecture change) | Proposed — depends |
| Allow temporary override of segment file length (truncate on complete/merge) instead of re-downloading | Proposed — depends |

---

## 3. Current Verified Status (Verification Results)

### 3.1 Already fixed — add only regression tests

| ID | Issue | Current fix location |
|---|---|---|
| C1 | Tokio Runtime leak on restart | `signal_shutdown()` + oneshot (lib.rs:562-590, daemon/mod.rs:594-602) |
| C2 | `app.exit(0)` without saving | tray quit → `signal_shutdown()` + 800ms (lib.rs:767-771) |
| C3/C4 | disk_writer swallows I/O errors / no Drop | **file removed entirely** from the project |
| C5 | panic in thread_pool kills worker | `catch_unwind` (thread_pool.rs:38-51) |
| C6 | poisoned Mutex freezes EventBus | `PublishGuard` resets depth on unwind (event_bus.rs:149-196) |
| C7 | OOM from `u32::MAX` segments | `MAX_SEGMENTS = 256` (direct.rs:212) |
| C8 | yt-dlp pipe deadlock | read stdout/stderr on two parallel threads (ytdlp.rs:190-220) |
| C9 | 100% progress immediately with preallocation | transfer.rs:644-658 + tests 2484/2556/2620 |
| C10/H5 | old Watchdog destroys new generation | check `generation` in `force_error_status` (transfer.rs:2103-2109) |
| C11 | DNS without timeout | `recv_timeout(5s)` (lib.rs:372-402) |
| C12 | CPU statics non-atomic | per-instance fields (resource_monitor.rs:194-209) |
| H1 | scheduler task dies silently | spawn as a task + handle JoinError (daemon/mod.rs:457-474) |
| H2 | double canonicalize inflates TOCTOU | single canonicalize (lib.rs:200) |
| H7 | false 200 detection via `plan.connections` | `ranges.len() > 1` (transfer.rs:1301) |
| H8 | remove_file before bumping generation | bump generation first (task_api.rs:483/570) |
| M19 | phantom task | snapshot deleted before curl_jobs (task_api.rs:575-577) |
| M2 | port exhaustion on range exhaustion | sweep full range (lib.rs:121-135) |
| M18 | SSRF to proxy without scheme | parse scheme-less + DNS timeout (args.rs:97-149) |
| M20 | `retry_all_errors` default true | `unwrap_or(false)` (transfer_config.rs:378/392) |
| M21 | excessive division/multiplication | `target.max(1)` (adaptive/mod.rs:632-637) |
| M23/L12 | convergence cooldown not reset | convergence.rs:78-86 |
| H12 | `is_rate_limited` true forever at `None` | returns false on None (server_profiler.rs:138-146) |

### 3.2 Present and confirmed — must be fixed (audit IDs as reference)

| ID | Issue | Location |
|---|---|---|
| H1/M27 | Pause = no limit (downloads at full speed) | bandwidth.rs:76-97 + transfer.rs:712-716 |
| M6 | rate limits not applied live | easy_config.rs:591-604 + transfer.rs |
| A15 (new) | default `low_speed_limit 500 B/s / 15s` cuts slow legitimate downloads | easy_config.rs:646-647 |
| M1/L1 | jitter = 0 always + 4 parallel retry applications | retry.rs:69-74 + direct.rs:370-390 + policy_engine |
| H3 | `hlsDashDownload` impossible to detect | engine_capabilities.rs:1504 |
| H4 | `CANDIDATE_CURL_RAW_OPTIONS` empty → rawOptions always rejected | engine_capabilities.rs:205 |
| H2/M4 | scheduler level-triggered + `return` instead of `continue` | scheduler.rs:151-153 + routes/engine.rs:649-691 |
| M9 | race in `TelemetryBus::report_speed` + underflow + stalling | adaptive/mod.rs:147-161 |
| H9 | `.unwrap()` on find in segment_controller | segment_controller.rs:208-209, 238-239 |
| M10/L17 | Rebalance re-downloads overlapping bytes + Split at 0 | segment_controller.rs:454-480, adaptive/mod.rs:564-613 |
| L13 | `per_connection_ceiling` stomped by single sample | server_profiler.rs:162-165 |
| H16 | `set_alive` counts active connections incorrectly | adaptive/mod.rs:209-219 |
| M11 | `BufferManager::recommend` & `ResourceManager::update_network` dead | buffer_manager.rs:47 |
| 1.2 | `DieOrchestrator`/`UnifiedProfileStore` never written to | die_orchestrator.rs + transfer.rs:87-102 |
| M7/L14 | adding duplicate mirrors + only the first marked | mirror.rs:55-60, 102-113 |
| M8 | resource monitor stubbed on non-Windows + WARN on every sample | resource_monitor.rs:214-281 |
| M12/M31 | plugin API: no runtime, no api_version check | plugin_api.rs |
| H10/H13 | profile_store swallows write/open errors | profile_store.rs:328-354 |
| H19 | `update_size()` does not reallocate share | priority_queue.rs:144-155 |
| H20 | `Merge(0,1)` encoded | policy_engine.rs:298-303 |
| H21 | `to_adaptive_config` overrides min_connections | profiles.rs:149-167 |
| H18 | `is_disk_bottlenecked` compares MB/s with bytes | resource_manager.rs:161-163 |
| M3 | EventBus `publish_depth` global not per-thread + unbounded queue | event_bus.rs |
| M2 | `ThreadPool::with_size(0)` panics | thread_pool.rs:74-78 |
| M5 | external_tools lock via slow init | daemon/mod.rs:267-270 |
| M4 | fallback HTTP client without timeout | daemon/mod.rs:177-182 |
| M3(daemon) | second Tokio Runtime + blocking Telegram client | daemon/mod.rs:299, telegram.rs:182 |
| M10 | `plan.clone()` on every redirect | transfer.rs:372 |
| M12 | `easy.timeout()` result ignored | transfer.rs:382 |
| M13 | segment count ≠ plan.connections | transfer.rs:958,1024 |
| M15 | `next_token` saturates at usize::MAX | multi.rs:240-241 |
| M17 | 6+ ignored `easy.*()` results | easy_config.rs |
| M22 | duplicate evaluation of `segment_ctrl` | adaptive/mod.rs:538-566 vs 583-607 |
| M27 | double-lock of `task_limits` | bandwidth.rs:79-90 |
| M28 | `active.max(1)` after checking `active==0` | priority_queue.rs:193-195 |
| M29 | `(total*2).max(total)` | config.rs:108 |
| M30 | HeaderContains substring instead of eq_ignore_ascii_case | rules.rs:148-153 |
| M25/L7 | `recovery_window_start` written but not read | self_healing.rs:49,64 |
| M26/L10 | `_mem_gb` and others | adaptive_connections.rs:24 |
| L3 | mac sleep via `systemctl` | routes/engine.rs:686-691 |
| L8 | UrlExtension: URL lowercasing and extension not | rules.rs:136-141 |
| L15 | `parse_rate_to_bytes` panics with non-ASCII | easy_config.rs:57-75 |
| L18 | undocumented capability claims | engine_capabilities.rs:763, 804-808, 841 |
| M16 | `next_token`/`collect_multi_errors` | multi.rs:240-241, 299-317 |
| 1.1/H5/H6/A7 | adaptive engine + PolicyEngine + AdaptiveConnectionManager dead | see Phase 5 |

---

## 4. Phases and Implementation

> Rule of thumb: each item = fix + unit (or integration) test that reproduces the issue (red) then demonstrates the fix (green). Each phase = a single PR that keeps CI green (`pnpm lint`, `lint:eslint`, `test`, `cargo check`, `cargo test`, `clippy -D warnings`, `rustfmt`, `audit:final`).

### Phase 0 — Safety nets and foundation (done first, reviewed with every phase)

| Item | Description |
|---|---|
| 0.1 | Run the full current quality gate and document the baseline green/red status. |
| 0.2 | i18n key parity test: Vitest test ensures keys of the 132 language files match `en` (capture current deviations first). |
| 0.3 | novaClient tools parity test: SSE delta merge + retry/abort logic + `window` protection in `request()`. |
| 0.4 | Create `docs/testing/REPAIR_COVERAGE.md` to record red/green state for each item in this plan (updated automatically or manually per phase). |

### Phase 1 — Data integrity and lifecycle (remaining CRITICAL/HIGH)

| ID | Fix | Test |
|---|---|---|
| H10/H13 | `ProfileStore::save()`/`new()` return `Result`; callers handle error (visible failure instead of silent) | Unit: write failure → declared `Err` |
| H4 | join watchdog `JoinHandle` with timeout on shutdown (no detach) | Unit + restart integration |
| C1 (regression) | Test ensures `restart_daemon` does not leak runtime (counter via indicator) | Integration |
| C2 (regression) | Test that quit saves state and removes socket file | Integration |
| H8 (regression) | Test ordering of generation bump vs remove_file | Unit |

### Phase 2 — Core download semantics (highest user impact)

| ID | Fix | Test |
|---|---|---|
| **H1 (Pause)** | `RateLimit { Unlimited, Limit(u64), Paused }` in bandwidth.rs + `rate_limit_for()`; driver loop acts as a gate: when `Paused` it only waits without `multi.action`; remove `0 = unlimited` semantics | **Integration:** start a download, `pause_all()`, freeze bytes for 1.5s, resume, complete correctly |
| **M6 (live limit)** | `refresh_rate_limits()` every tick: compute allowance (global/per-task/engine override), push `max_recv_speed` via `DerefMut` on the live easy (confirmed: takes effect within a single read window) | **Integration:** set a generous limit → measure speed → `set_task_limit(50KB/s)` → speed ≤ 1.5× → raise limit → recover |
| A15 | remove default `low_speed_limit(500)/15s` (or make it configurable only when explicitly requested) | Unit: legitimate slow download is not cut |
| **M1 (jitter)** | integer math: `dur.as_nanos() % jitter_range.as_nanos()` + unify four retry applications into one | Unit: 1000 samples → jitter non-zero and varied |
| M12 | handle result of `easy.timeout()` (and all ignored `easy.*()` in easy_config) — `?` or `map_err` | Unit: setter failure → declared error |

### Phase 3 — Capabilities and scheduler (small, fast user-visible wins)

| ID | Fix | Test |
|---|---|---|
| H3 | split `formats` on `,` and check each token (`hls`/`dash`/`mp4`…) | Unit: media capabilities report hlsDashDownload when available |
| H4 | either populate `CANDIDATE_CURL_RAW_OPTIONS` with a real list (extracted from `curl_version_info` + option map) or remove the claim; choose first if map exists | Unit: rawOptions accepted/rejected according to list |
| H2/M4 | scheduler edge-triggered: remember the fired action state per rule/interval (episode token); use `continue` instead of `return` when power commands disabled | Unit: Shutdown fires once though condition persists + other actions remain |
| L18 | verify or remove: `skipExisting`, `retryConnRefused`, `tcpFastOpen`, `happyEyeballsTimeoutMs` | Unit: honest capability map |
| L3 | mac sleep path via `pmset sleepnow` (Linux via `systemctl`, Windows via `SetSuspendState`) | Unit: platform-chosen command |
| M30 | `HeaderContains` → `eq_ignore_ascii_case` on header value | Unit: case matching |
| L8 | normalize prepared extension and lower-case before matching + reject invalid regex on creation | Unit |
| M29 | simplify `(total*2).max(total)` → `total * 2` | Unit |
| M28 | remove dead `active.max(1)` | Unit |
| H19/H18 | `update_size()` calls `reallocate()`; fix disk comparison unit (MB/s vs bytes) | Unit |
| M19 (regression) | test snapshot/jobs deletion ordering | Unit |

### Phase 4 — Adaptive engine prerequisites (land before any application-path work)

Each item here is independent and isolated; done in a single preparatory PR:

1. M9 — TelemetryBus race: remove `fetch_add/fetch_sub`; `report_speed` stores the slot only; `snapshot()` recomputes `total_speed = Σ speeds` across live slots; `aggregate_peak` via `fetch_max`.
   - Test: concurrent publishes across threads → `snapshot().aggregate.total_speed` equals sum of slots, no underflow; `mark_completed` twice counts once.
2. H9 — unwraps: use `let Some(x) = ... else { return None }` at the four `find` sites.
   - Test: malformed topology → `evaluate()` returns `None`, no panic.
3. M10 — Rebalance with prefix model: `apply_plan` trims `slow.end_byte`, sets `slow.truncate_on_complete`, and inserts prefix segment `P = [slow.end_byte, fast.start_byte)` instead of moving `fast.start_byte`; `fast` remains unchanged.
   - Stability test: after application, segments are adjacent without overlap, `fast.downloaded` unchanged, Σ downloaded ≤ Σ total.
4. merge_adjacent_segments: `a.downloaded += b.downloaded` before removing b (both files remain physically).
   - Test: total saved bytes before/after merge equal.
5. SplitSegment at_byte: fill `at_byte` with actual midpoint (`start + downloaded + remaining/2`).
   - Test: cut point inside `[start+downloaded, end)`.
6. L13 — per_connection_ceiling: do not stomp it on single-sample connection; only adjust when multiple connections observed (`observed_connection_count`).
   - Test: multi-connection samples don't break ceiling.
7. M23/L12 — convergence cooldown: on improvement (`ratio ≥ 1.05`) clear `cooldown_until` and zero counter.
   - Test: improvement clears cooldown.
8. H16 — set_alive: return previous value; `mark_completed/mark_failed` count on transition from alive only.
   - Test: double call counts once.
9. M11 — BufferManager/ResourceManager: call `resource_manager.update_network(agg_speed, active_conns)` in the apply step of `on_tick` (activates `recommend`).
10. 1.2 — DieOrchestrator write path: `record_preflight(host, &profiler.get(host))` on startup + `record_telemetry(host, rtt, agg_speed, status)` on each evaluation; `save_if_dirty` gated by a dirty flag.
    - Test: after a full cycle, `UnifiedProfileStore` contains non-default values.
11. M27 — double-lock: rework `remove_task_limit` into two stages (no simultaneous hold of speed_history and history_order).
12. merge_parts truncate: `FileWriter::merge_parts` truncates parts longer than expected before merging (shorter parts stay an error).
    - Test: longer part → truncated then merged; shorter part → error.
13. types.rs: add `start_byte/end_byte` to `Segment` with `#[serde(default)]` (resume-compatible).
14. easy_config.rs: helper `set_live_rate(&mut Easy2Handle<SegmentWriter>, Option<u64>)`.

### Phase 5 — Ship the adaptive engine (live application)

Design summary:

```
tick every 250ms → SegmentSet::on_tick:
  1. read progress of each piece → telemetry_bus + segment_ctrl.update_progress
  2. engine.evaluate(&telemetry_bus)  (evaluates each tick; evaluate internally rate-limited to 2s tick_interval)
  3. if AdjustConnections → redistribute_for_count(target)
  4. reconcile(engine.segments()) — idle-engine diff: spawn/suspend/truncate
  5. drop engine trackers locks before any curl_jobs lock (prevent AB-BA inversion with delete_task)
  6. refresh_rate_limits() + update_curl_task_progress + record_telemetry(DIE)
```

Implementation items:

| Item | File | Change |
|---|---|---|
| 5.1 | `multi.rs` | `CurlMultiGuard::remove(handle)`; Trait `SegmentedDrive { multi_mut, handle_count, sweep_finished, on_tick, check_errors }`; `drive_adaptive_socket/wait` with `paused` gate and completion sweep; old driver functions remain for single-path |
| 5.2 | **new** `curl/dynamic_transfer.rs` | `ActiveSegment` (id, start, end, file, progress, initial, handle, truncate_on_complete, finished, code); `SegmentSet`; Trait `Transport { add, remove, set_rate }` (production = guard, test = recorder); `spawn_segment/suspend_segment/truncate_file/reconcile/apply_decision/refresh_rate_limits/on_tick`; verify tile-bytes invariants after each mutation |
| 5.3 | `transfer.rs` | `run_segmented_libcurl` builds `SegmentSet`, seeds `segment_ctrl.reset_from_ranges(...)`, drives via `drive_adaptive_*`; refactor `update_curl_task_progress` to assume keys `HashMap<segment_id, u64>`; truncate pass before merge; generation/status checks before topology mutations |
| 5.4 | `transfer_config.rs` | `adaptive: bool` (`bool_("adaptive").unwrap_or(true)`) + `adaptiveEvalMs` → `engine.set_tick_interval` |
| 5.5 | `dynamic_segments.rs` | `replace_segments(&[(id,start,end,downloaded,speed,active)])` — engine topology mirror for UI |
| 5.6 | `die_orchestrator.rs` | no API change; add callers (limit `save_if_dirty` by flag) |

Strict byte rules: invariant `Σ active.finished_len + Σ active.(initial+progress clamped)` = all unique bytes; each segment file = tile `[start, start+len)` contiguous; cut point exclusive (`mid`: original `[start, mid-1]`, tail `[mid, end]`).

Cap constraints: `max_segments = min(64, max_connections_per_download)`; split rejected when `remaining < 2*min_segment_bytes`; merge rejected if sum insufficient; `redistribute_for_count` changes topology only on real difference (reconcile = diff not rebuild).

Phase 5 tests (integration against local range server — existing helpers: `spawn_range_server`, `run_task_to_completion`, `test_state`):

1. `adaptive_segmented_download_grows_and_completes` — 8 MiB, connections=2, small evalMs → segment count grows beyond initial during run, final file matches bytes.
2. `pause_actually_stalls_bytes` — after start and some progress, `pause_all()` → bytes do not move → resume → complete correctly.
3. `live_rate_limit_change_takes_effect` — changing live limit measured effectively.
4. `segment_count_responds_to_growth_decision` — number of handles increases (`SegmentSet::active_handles()` behind `#[cfg(test)]`).
5. Unit: reconcile with fake `Transport` — split → one add + truncate; rebalance → prefix add + truncate without re-sending `fast`; merge → no ops; shrink → no new adds; tile stability after each mutation.

### Phase 6 — Remaining MEDIUMs

| ID | Fix | Test |
|---|---|---|
| M3 | `thread_local!` for `publish_depth` + bounded queue drop-oldest | Unit: slow publisher does not block others; queue limit |
| M2 | `with_size(0)` → `Err`; `spawn` returns `Result`; bounded queue | Unit: 0 rejected; queue overflow does not lose |
| M7/L14 | `add_mirror` upsert by url (dedupe); `report_failure` marks all copies unhealthy; cooldown per-mirror not per-task | Unit |
| M8 | real readings on Linux (`/proc/stat`, `/proc/self/io`) and macOS (`host_statistics64`, `getrusage`) instead of constants; remove WARN per sample | Unit (platform-mocked) |
| M12/M31 | decision: either implement plugin load/activation with `api_version` check, or remove misleading API surface — chosen: **api_version check + document hooks roadmap** in this run | Unit: api_version rejected/accepted |
| M10 | `plan.clone()` on redirect → clone only mutable fields | Unit |
| M13 | align number of segments with `plan.connections` (or `ranges.len()` after dynamic change) | Integration |
| M15/M16 | `next_token` wrap safely; `collect_multi_errors` O(n) with token map | Unit |
| M17 | handle all ignored `easy.*()` results | Unit |
| M22 | evaluate `segment_ctrl` once per tick | Unit |
| M5 | external_tools lock via `discover_and_initialize` → per-step atomic lock | Unit |
| M4 | fallback HTTP client with timeouts | Unit |
| M3(daemon) | unify runtime — Telegram thread reuses main Runtime via `Handle` | Unit |
| M25/L7 | `recovery_window_start` either read or removed | Unit |
| M26 | clean `_mem_gb` and dead constants | Unit |
| L15 | `parse_rate_to_bytes` handle non-ASCII safely (treat chars as bytes) | Unit |
| L16 | `AtomicU64::fetch_add` inside Mutex → regular `store` | Unit |
| L17 | `from_u32(2)` → explicit match instead of wildcard | Unit |
| L18 (capabilities) | nested bandwidth tables: explicit documented ordering | Unit |
| L19 | unify profile locks ordering | Unit |
| L20 | jitter also subtracts (symmetric distribution) | Unit |

### Phase 7 — Frontend, extension, and translation

| ID | Fix | Test |
|---|---|---|
| new | guard `window` in `novaClient.request()` (non-browser environment) | Vitest unit |
| new | loader in `translations.ts:288` selects dictionary with `key === 'default'` explicitly | Unit |
| new | `bridgeStore.setIsDegradedMode` synchronized with state, not independent | Unit |
| new | `pl.ts` (extension): fix encoding (Polish text previously corrupted) | automated encoding check |
| new | `zh.ts` etc: raw English keys → pass to translator (documented as remaining work outside code) | — |
| 0.2 | i18n key parity test across 132 languages | Vitest |
| new | `logging.rs`: build `task_summaries`/`task_trace` without cloning full loop on demand | simple perf test |

### Phase 8 — Final quality and documentation

| Item | Description |
|---|---|
| 8.1 | `evaluate()` tests with convergence/rebalancing (were I12-I14) — after Phase 5 become live tests. |
| 8.2 | Update `AUDIT_REPORT.md` with "fixed" status for each item (closure log). |
| 8.3 | `CHANGELOG.md` + README summary documenting actual adaptive engine capabilities. |
| 8.4 | Run full gate: `pnpm lint`, `pnpm lint:eslint`, `pnpm test`, `pnpm run verify:capabilities`, `pnpm run audit:installer`, `pnpm run audit:final`, `cargo check`, `cargo test`, `clippy -D warnings`, `rustfmt --check`. |

---

## 5. Testing Strategy (summary)

- Red → Green: every fix starts with a failing test (proves the bug) then passes (proves the fix). Both states documented in `docs/testing/REPAIR_COVERAGE.md`.
- Layers: unit (component) → integration (local range server + real download path) → E2E (Playwright available) → CI gate.
- Existing helpers reused: `spawn_range_server`, `run_task_to_completion`, `test_state` (transfer.rs:2214-2342) — generalized for Phase 5 tests.
- Platforms: platform-specific tests (mac sleep, /proc/stat, sysinfo) are mocked via cfg and do not require real devices in CI.
- No broken tests merged: any PR that fails the CI gate is rejected before merge.

---

## 6. File change map (aggregate)

Rust — src-tauri/src:
- `daemon/engine/bandwidth.rs` — RateLimit enum + rate_limit_for + fix double-lock.
- `daemon/engine/adaptive/mod.rs` — TelemetryBus, set_alive, at_byte, connect BufferManager.
- `daemon/engine/adaptive/segment_controller.rs` — unwraps, prefix-rebalance, merge saved state, reset_from_ranges, truncate_on_complete/prefix_of, enforce max_segments.
- `daemon/engine/adaptive/convergence.rs` — clear cooldown on improvement.
- `daemon/engine/adaptive/server_profiler.rs` — per_connection_ceiling, observed_connection_count.
- `daemon/engine/adaptive/resource_monitor.rs` — real Linux/macOS readings.
- `daemon/engine/die_orchestrator.rs` — callers added (no API change).
- `daemon/engine/policy_engine.rs` — Merge(0,1) with correct identifier.
- `daemon/engine/priority_queue.rs` — update_size→reallocate, remove dead code.
- `daemon/engine/profiles.rs` — min_connections, Result from save.
- `daemon/engine/profile_store.rs` — Result from save/new.
- `daemon/engine/resource_manager.rs` — fix disk unit, update_network.
- `daemon/engine/self_healing.rs` — recovery_window_start.
- `daemon/engine/mirror.rs` — upsert + mark all copies + per-mirror cooldown.
- `daemon/engine/plugin_api.rs` — api_version check.
- `daemon/engine/event_bus.rs` — thread_local depth + bounded queue.
- `daemon/engine/thread_pool.rs` — reject with_size(0), spawn Result, bounded queue.
- `daemon/engine/config.rs` — simplification (total*2).
- `daemon/engine/rules.rs` — lower-case extension, HeaderContains, valid regex.
- `daemon/engine/adaptive_connections.rs` — cleanup/remove.
- `daemon/engine/dynamic_segments.rs` — replace_segments.
- `daemon/engine_capabilities.rs` — hlsDash, rawOptions, L18 claims.
- `daemon/curl/transfer.rs` — SegmentSet, update_curl_task_progress by key, pause gate, integrations.
- `daemon/curl/multi.rs` — remove, SegmentedDrive, drive_adaptive_*, next_token, O(n).
- `daemon/curl/easy_config.rs` — set_live_rate, remove default low_speed, handle results, parse_rate_to_bytes.
- `daemon/curl/dynamic_transfer.rs` — **new:** SegmentSet/Transport/ActiveSegment.
- `daemon/curl/transfer_config.rs` — adaptive + adaptiveEvalMs.
- `daemon/curl/task_api.rs` — regressions only.
- `daemon/ytdlp.rs` — regressions only.
- `daemon/mod.rs` — external_tools lock, HTTP client, Telegram runtime.
- `daemon/direct.rs` — merge_parts truncate.
- `daemon/types.rs` — start_byte/end_byte.
- `daemon/scheduler.rs` / `routes/engine.rs` — edge-trigger + continue + mac sleep.
- `daemon/telegram.rs` — unified runtime.
- `lib.rs` — regressions C1/C2 only.
- `logging.rs` — O(n) improvement for on-demand loops.

Frontend — src/:
- `api/novaClient.ts` — guard window.
- `lib/i18n/translations.ts` — explicit dictionary loader.
- `store/bridgeStore.ts` — synchronize degraded mode.
- `test/` — i18n parity + novaClient tests.

Browser extension:
- `src/i18n/locales/pl.ts` — encoding fix.

Docs:
- `REPAIR_PLAN.md` (this document) — update status per phase.
- `docs/testing/REPAIR_COVERAGE.md` — red/green registry.
- `AUDIT_REPORT.md` — closure log.

---

## 7. Sequence and Dependencies

```
Phase 0 (foundation/safety)
   │
   ▼
Phase 1 (data safety) ──► Phase 2 (download semantics) ──► Phase 3 (capabilities/scheduler)
   │                               │
   ▼                               ▼
Phase 4 (engine prerequisites) ──► Phase 5 (ship adaptive engine)
                                                │
                                                ▼
                            Phase 6 (medium) ──► Phase 7 (frontend/i18n)
                                                │
                                                ▼
                                        Phase 8 (final quality)
```

- Phase 4 gates 5 (no application-path work before fixing TelemetryBus race, unwraps, and byte-accounting).
- Phase 2 gates integration tests in 5 (pause gate and live limits must be correct because Phase 5 tests depend on them).
- Phases 3, 6, and 7 are independent and may overlap.
- Each phase starts and ends with CI green.

---

## 8. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| AB-BA deadlock: engine_trackers ↔ curl_jobs in on_tick | Low | High | Drop engine locks before curl_jobs; document lock order in both places; review |
| connection count oscillation | Medium | Medium | convergence cooldown + max_adjustments_per_minute + 5s debounce + reconcile as diff |
| incorrect byte accounting near split/merge at file end | Medium | High | tile stability after each mutation + reject split when `remaining < 2*min` + truncate pass before merge |
| old Watchdog evolving new generation | Low | High | check generation/status before topology mutations (already present for other paths) |
| connection reduction not immediate (soft) | Low | Low | documented as first-release constraint; hard option behind flag later |
| regression for single/unknown-size path | Low | High | keep old driver functions; engine only when `segmented && total_size ≥ min`; integration tests for both paths |
| resume schema compatibility | Low | Medium | `#[serde(default)]` on new fields; test resuming old snapshot |
| i18n/UI errors during flow | Low | Low | i18n key parity test in Phase 0.2 |

---

## 9. Definition of Done

1. Each item above has a red→green test documented in `docs/testing/REPAIR_COVERAGE.md`.
2. Adaptive engine runs in production: decisions applied to live easy handles and measured in integration tests (segment growth, actual pause stall, live limits).
3. No false capability claims in `engine_capabilities.rs`.
4. No `#[allow(dead_code)]` on engine decision blocks without written justification (or remove them).
5. Full quality gate green (Section 4 / Phase 8.4).
6. `AUDIT_REPORT.md` and `code-audit-report.md` updated with closure log, and `CHANGELOG.md` documents changes.

---

## 10. Open decisions for review

1. Enable the adaptive engine by default (proposal: yes, for segmented downloads with known size) or behind a flag in the first release?
2. Accept the constraint "soft reduction via natural completion" for the initial delivery, with a hard option later?
3. Allow temporary override of segment file length (truncate on complete) — proposal: yes (alternative re-downloads data).
4. Add `start_byte/end_byte` to the persistent `Segment` schema (proposal: yes, `serde(default)`).
5. Fate of Plugin API: api_version check + roadmap doc, or remove misleading surface?

---

This plan is executable phase-by-phase; start with Phase 0 then Phase 1 upon approval.
