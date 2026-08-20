# Comprehensive Micro-Audit Report for Project NOVA — Updated Edition

**Date:** 31 July 2026
**Scope:** 60+ Rust files across the following modules: `daemon/engine/` (23 files + `adaptive/`), `daemon/curl/` (8 files), `daemon/routes/` (9 files), `daemon/resource_intelligence/` (7 files), `daemon/external_tools/`, plus `mod.rs`, `state.rs`, `types.rs`, `utils.rs`, `direct.rs`, `persist.rs`, `ytdlp.rs`, `telegram.rs`, `native_host.rs`.
**Lines inspected:** ~20,000+ lines (full reading, not superficial search).
**Methodology:** line-by-line review against the actual code at `HEAD = 0767363`; re-check of every claim in the previous audit report (29 July 2026); experimental tests on Windows 10 for critical parts (disk preallocation).
**Note:** This report corrects and supersedes the 29 July report; claims from the old report that are no longer true in the current revision are listed in the “Corrections to previous report” section.

---

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Summary of Findings by Severity](#summary-of-findings-by-severity)
3. [Network Security Issues (SSRF)](#network-security-issues-ssrf)
4. [Correctness and Continuity Issues (Correctness)](#correctness-and-continuity-issues-correctness)
5. [Concurrency Issues](#concurrency-issues)
6. [Memory Management and libcurl FFI Issues](#memory-management-and-libcurl-ffi-issues)
7. [Performance Issues](#performance-issues)
8. [Dead Code (revised)](#dead-code-revised)
9. [Architectural Issues](#architectural-issues)
10. [Confirmed Strengths](#confirmed-strengths)
11. [Corrections to Previous Report](#corrections-to-previous-report)
12. [Priority Fix List](#priority-fix-list)
13. [Statistical Summary and Final Verdict](#statistical-summary-and-final-verdict)

---

## Executive Summary

NOVA is a download manager built on Tauri + Rust with an internal download engine that uses libcurl via raw FFI (easy + multi), a local HTTP server on `127.0.0.1` via axum, and a browser extension. The engine was significantly reworked compared to the prior audit: the old `daemon/adaptive/` module was removed entirely, and `AdaptiveEngine`, `ResourceIntelligenceEngine`, `SelfHealer`, and `PolicyEngine` were wired into the actual download flow.

Overall summary: the current architecture shows marked improvements in core defense layers (scheme restriction, SSRF checks at creation, lock ordering, component integration). No critical (Critical) issues were observed in the current revision. The most important finding is an SSRF vulnerability via redirects and mirror services in the actual download path: the effective target is not re-validated after any redirect or when switching to a mirror, nor is the RIE redirect chain re-checked.

---

## Summary of Findings by Severity

| ID | Severity | Location | Summary |
|----|----------|----------|--------|
| SEC-1 | High | `curl/transfer.rs:299-453,1273-1281` + `routes/downloads.rs:731-735` | Effective target after redirects is not re-validated (SSRF) |
| SEC-2 | Medium | `routes/downloads.rs:757-764` + `curl/transfer.rs:1494-1520` | Mirrors injected from `Link` header are accepted without SSRF checks and switched to in failover without checking |
| COR-1 | Medium | `curl/easy_config.rs:1197-1201` | Disk preallocation does not actually work on NTFS (experimental test confirmed) |
| SEC-3 | Low | `curl/task_api.rs:405` | URL update uses non-pinned DNS check (TOCTOU) |
| SEC-4 | Low | `ytdlp.rs:949`, `routes/probes.rs:315/618/720` | yt-dlp checks and probes are not DNS-pinned |
| COR-2 | Low | `direct.rs:359` vs `engine/retry.rs:6` | Two separate `RetryPolicy` types with differing logic |
| COR-3 | Low | `direct.rs:425-426` | Any error containing `ssl`/`tls` is considered transient in `is_transient_error` |
| CON-1 | Low | `engine/thread_pool.rs:37-40` | `Relaxed` ordering on worker counter |
| PERF-1 | Low | `external_tools/installer.rs:208-214` | `block_in_place` + `block_on` |
| DEAD-1 | Low | `engine/chunk_manager.rs` | Entire unit is dead in production |
| ARCH-1 | Low | `engine/adaptive_connections.rs` + `engine/adaptive/mod.rs` | Two parallel adaptive systems operating together |
| ARCH-2 | Informational | `engine/plugin_api.rs:49` | `api_version` hardcoded without compatibility check |

---

## Network Security Issues (SSRF)

### SEC-1 — Effective target after redirects is not re-validated (High)

Locations:
- `daemon/curl/transfer.rs:299-453` — `resolve_effective_target()` follows HTTP redirect chains and meta-refresh (up to 5 hops) without any call to `is_safe_target_url`.
- `daemon/curl/transfer.rs:1273-1281` — `plan.url = effective_url` assigns without re-validation.
- `daemon/routes/downloads.rs:731-735` — the final target from RIE redirect chain is written into `job.task.url` after only checking the *scheme* (`supported_direct_url`).
- `daemon/curl/task_api.rs:29-30` — setting `--resolve host:port:ip` covers **the original host only**; any new host after a redirect is free to be resolved again.

Vulnerability mechanism: at creation the original host is pinned to the external address (correct check). But if the external server responds with `302 Location: http://169.254.169.254/...` or `http://127.0.0.1:8080/...`, then:
1. the curl engine follows the redirect (FOLLOWLOCATION is enabled by default, limit 20) and downloads from the internal target, writing content to disk;
2. the RIE path (`background_resolve_and_start` → `state.rie.resolve`) performs HEAD/RANGE/GET checks on the internal target without any SSRF check across the entire `resource_intelligence/` module (zero calls to `is_safe_target_url`).

Impact: exfiltration of internal services (cloud metadata, router config) to the user's disk; blind SSRF with leakage of metadata (size/etag/content-type/filename) from internal hosts. Practical path: a malicious web page triggers a browser download to a URL on an attacker-controlled server that responds with a 302 to an internal address; the extension hands the URL to NOVA; the pinned check passes (original host external) and NOVA follows the redirect into the internal network.

Remediation: re-run `is_safe_target_url_pinned(&effective_url)` after `resolve_effective_target` and before calling `run_libcurl_download`; reject any redirect/meta-refresh to internal hosts; re-apply the pinned check to the `final_url` coming from RIE before writing it into `task.url`.

### SEC-2 — Mirrors injected from Link header accepted without checking, switched to without check (Medium)

Locations:
- `daemon/routes/downloads.rs:757-764` — `link_mirrors` from `report.server_capabilities.link_mirrors` are inserted into `direct_options` without any `is_safe_target_url`.
- `daemon/curl/transfer.rs:1494-1520` — on download failure mirrors are registered into `MirrorManager` and then `plan.url = new_url` (failover) without SSRF checks.
- `daemon/routes/downloads.rs:227,263-285` — mirrors coming from rules (`RuleAction::AddMirror`) are recorded directly without checking (the only check is in the `/api/mirrors` endpoint: `routes/engine.rs:797-800,1018-1019`).

Impact: an external server can advertise `Link: <http://127.0.0.1:...>; rel=duplicate` and NOVA will accept it as a failover mirror, and will fetch from it on primary failure without any destination verification.

Remediation: validate every mirror with `is_safe_target_url_pinned` at insertion (whether from a probe or from rules) and again when used for failover.

### SEC-3 — URL update uses non-pinned DNS check (Low)

Location: `daemon/curl/task_api.rs:403-405` — `update_task_metadata()` uses `is_safe_target_url(&parsed.normalized)` (non-pinned), while the creation path uses `is_safe_target_url_pinned` (task_api.rs:30). A DNS rebinding TOCTOU is possible: the function checks the address, and then DNS is later resolved again by libcurl.

Remediation: use `is_safe_target_url_pinned` in the update path as well, and update resolve entries in `direct_options`.

### SEC-4 — yt-dlp checks and probes not DNS-pinned (Low)

Locations: `daemon/ytdlp.rs:949`, `daemon/routes/probes.rs:315,618,720` — these all use the non-pinned version. The verification is time-of-check: done before yt-dlp/curl resolves DNS. The impact is limited because the server that executes the final request is implicitly checked via `validate_resolve_entry` in the curl path, but these remain weaker check points compared to the pinned path.

---

## Correctness and Continuity Issues (Correctness)

### COR-1 — Disk preallocation does not actually work on NTFS (Medium, experimental test confirmed)

Location: `daemon/curl/easy_config.rs:1197-1201` — when `preallocate_bytes = Some(size)` the code calls `file.set_len(size)`.

Experimental result (Windows 10): `File::set_len` maps to `SetEndOfFile` on Windows which extends the logical file length only and does not reserve actual blocks on NTFS. Preallocation does not prevent running out of disk during writes, so the feature promise (prevent mid-download failure) is not realized on NTFS. The current code handles the side effects (apparent file growth) via `effective_downloaded` (transfer.rs:690-721) and `f.set_len(0)` on error (transfer.rs:864) — the behavior is safe regarding corruption, but does not deliver the advertised protection.

Remediation: on Windows either replace with `SetFileValidData` (requires `SeManageVolumePrivilege`) or remove preallocation and instead check for free disk space before starting.

### COR-2 — Two separate `RetryPolicy` types (Low)

Locations: `daemon/direct.rs:359` (used in the transfer loop: `transfer.rs:1241,1557` via `transfer_config.rs:373`) vs `daemon/engine/retry.rs:6` (used in `config.rs:91`, `profiles.rs:183`, `persist.rs:262`, `policy_engine.rs:328`).

Impact: two different retry and error-classification logics; a setting stored via `to_retry_policy()` may not be honored by the actual transfer loop. Requires unifying the types under a single source of truth.

### COR-3 — `is_transient_error` treats any error containing `ssl`/`tls` as transient (Low)

Location: `daemon/direct.rs:425-426`. The `permanent_ssl` list (402-410) excludes some certificate errors, but any other message containing `ssl` or `tls` (e.g. an unrecoverable protocol version error) is retried. Also `is_permanent_error` (446-455) classifies 500/501/504 as permanent while 502/503 are transient — the classification is inconsistent between the two functions.

---

## Concurrency Issues

### CON-1 — `Relaxed` ordering on worker counter (Low)

Location: `daemon/engine/thread_pool.rs:37,40` — `fetch_add(1, Ordering::Relaxed)` / `fetch_sub(1, Ordering::Relaxed)`. The impact is informational only (`active_count`), but the value may be observed stale. Fix: use `Acquire`/`Release`.

Positive notes in the same file:
- independent channel per worker (comment C-04) — no contention on a single receiver channel (thread_pool.rs:26-30).
- `catch_unwind` around each task with panic logging (38-50) — worker does not die.
- round-robin distribution with resend-on-full behavior (74-96).

### CON-2 — `active_count` and `spawn()` unused in production

Location: `thread_pool.rs:111` — `#[allow(dead_code)]` on `spawn()`. Workers are managed via `ResourceManager`, the public scheduling API is unused. Not a bug, but partially dead code.

### CON-3 — `ProfileManager` lock ordering consistent (verified — no issue)

The previous report's claim about "inconsistent lock ordering" was found to be incorrect in the current revision: `active_profile()` locks `active_profile` then `profiles` (profiles.rs:218-225), and `set_active()` locks `active_profile` only (237); no path locks `profiles` first, so no ABBA.

### CON-4 — `curl_jobs → task_snapshot` lock ordering documented and observed

Confirmed enforced in: `task_api.rs:75-83` (creation), `routes/downloads.rs:723` (background update), `transfer.rs:1306` (rename). No path locks the opposite order.

### CON-5 — `event_bus` capacity limited to 100 events

Location: `engine/event_bus.rs` (`EventBus::new_with_capacity(100)`), multiple publishers (persist.rs:252, mod.rs:274, routes/engine.rs:192/345/824, downloads.rs:237/277). Without backpressure events may be dropped under high publish pressure; operational impact (missed notifications), not a crash.

---

## Memory Management and libcurl FFI Issues

| ID | Location | Description | Status |
|----|----------|------------|--------|
| FFI-1 | `easy_config.rs:37-38` | `CString::new(value).map_err` — no panic on NUL | Fixed (previously panicked) |
| FFI-2 | `easy_config.rs:44-49` | check `CURLE_OK` with freeing memory on failure | Fixed |
| FFI-3 | `direct.rs:70-72` | `set_url` handles NUL via `map_err` | Good |
| FFI-4 | `resource_manager.rs:85-93` | `unsafe` with `MemoryStatusEx::zeroed()` — check `dw_length` before call | Present (less severe because it's filled prior to call) |
| FFI-5 | `easy_config.rs:39-43` | intentional leak of `CString` to ensure pointer lifetime — freed on libcurl failure | Accepted and documented |

General note: the current FFI layer is much improved from the previous report; every `CString::new` in the easy-config path goes through `map_err`, and every `curl_easy_setopt` checks the error code.

---

## Performance Issues

### PERF-1 — `block_in_place` + `block_on` in installer (Low)

Location: `external_tools/installer.rs:208-214`. The HTTP request is executed inside `block_in_place(|| handle.block_on(...))` — not disastrous but less efficient for runtime workers than using `reqwest::blocking`.

### PERF-2 — active wait loop in `hidden_output_timed`

Location: `routes/common.rs:48-70` — a `sleep(50ms)` loop waits for an external process to finish. The function is blocking (does not starve the reactor) but consumes polling cycles; low impact.

### PERF-3 — good design items worth noting

- SSE at 250ms with full concurrency (SSE heartbeat 10s, full resync every 60s) — downloads.rs:55-142.
- `preflight_resolved` prevents duplicate checks (RIE then curl) — transfer.rs:323-334.
- capability query in `/api/health` uses `spawn_blocking` — downloads.rs:33.
- `MAX_TASKS = 10_000` prevents unbounded growth — task_api.rs:15,78.

---

## Dead Code (revised)

The previous report's claim that “~40% of the codebase is dead and the adaptive/intelligence systems are disconnected” is no longer true. The current reality (after line-by-line review):

| ID | Location | Description | Status |
|----|----------|-------------|--------|
| DEAD-1 | `engine/chunk_manager.rs` | `ChunkManager` + `SlidingWindow` + `recommend_chunk_size` + `update_remaining_bytes` — no consumer in production (full search: no call outside tests) | completely dead |
| DEAD-2 | `engine/self_healing.rs` | 10 `allow(dead_code)` occurrences (fields/funcs) — but `SelfHealer` itself is wired in (transfer.rs:1443-1479) | partial |
| DEAD-3 | `engine/resource_manager.rs` | `allow(dead_code)` at 51,57,77,93 | partial |
| DEAD-4 | `engine/retry.rs:80` | one field | partial |
| DEAD-5 | `engine/event_bus.rs:364` | one function | partial |
| DEAD-6 | `resource_intelligence/mod.rs:166` | `minimal_resolve` | partial |
| DEAD-7 | `external_tools/` | `types.rs:28,226-316` (8 spots), `registry.rs:8`, `mod.rs:304,310`, `health.rs:10,176`, `capabilities.rs:86-124` (4 spots) | partial |

Corrective notes:
- `engine/adaptive/resource_monitor.rs:36-42` uses `cfg_attr(not(target_os = "windows"), allow(dead_code))` — this is not dead code but Windows-only fields annotated for non-Windows builds. Correct.
- `engine/adaptive/` is fully wired: `AdaptiveEngine` in `state.rs:39`, created in `transfer.rs:984`, and segment progress updated in `transfer.rs:1134-1141` via `segment_ctrl.update_progress`.
- `AdaptiveConnectionManager` is wired: `tracker.adaptive.report_speed` in `transfer.rs:493` and created at `transfer.rs:1029`.
- `checksum.rs` is wired: verification interfaces in `routes/engine.rs:728-746` and SHA-256 check after completion in `transfer.rs:1381-1384`.
- `scheduler.rs` is wired via a scheduled thread in `daemon/mod.rs` with `power_commands_enabled` gated for Shutdown/Sleep actions.

---

## Architectural Issues

### ARCH-1 — Two parallel adaptive systems operating together (Low)

- `engine/adaptive_connections.rs::AdaptiveConnectionManager` (atomic counters, tunes global connections) and `engine/adaptive/mod.rs::AdaptiveEngine` (SegmentController via `segment_ctrl.update_progress`) are both active in the same download loop. The boundary of responsibility is undocumented; risk of conflicting decisions (one increases connections while the other decreases).

### ARCH-2 — Separate stores for server profiles (Low)

- `resource_intelligence/stability.rs::ServerProfileStore` (inside `state.rie`) vs `engine/adaptive/profile_store.rs::UnifiedProfileStore` (inside `DieOrchestrator`). A single download path reads the first (transfer.rs:87-102) while the second is recorded to (record_preflight/record_telemetry). There is no exchange between the stores despite overlapping purpose.

### ARCH-3 — Duplicate `RetryPolicy`

See COR-2 — two types of the same name with differing logic.

### ARCH-4 — `api_version` hardcoded (Informational)

Location: `engine/plugin_api.rs:49,190` — `api_version: "1.0.0"` hard-coded without an actual compatibility check at load time.

### ARCH-5 — `DynamicSegmentScheduler::new` has reserved and unused `_max_segments`

Location: `engine/dynamic_segments.rs` — the third parameter is unused (reserved for future). Indicates planned redesign of the segmentation system.

---

## Confirmed Strengths

| ID | Location | Description |
|----|----------|-------------|
| POS-1 | `direct.rs:136-183` | `DirectUrl::parse` rejects any scheme outside (http/https/ftp/ftps/sftp/scp), and rejects any URL starting with `-` (flag injection protection). |
| POS-2 | `utils.rs:35-94,155-193` + `task_api.rs:30` | Three-layer SSRF protection: check, DNS-pinned check (returns IP + resolve entry), and check of `--resolve/--connect-to` entries. |
| POS-3 | `utils.rs:696` + `resource_intelligence/mod.rs:188-194` + `curl/args.rs:96` | Proxy URLs are validated before use and rejected if unsafe. |
| POS-4 | `direct.rs:295-355` | `merge_parts`: checks each part size before copying, uses a temp random-name file (no collision), `sync_all` on file and folder, safe `rename`, final size verification, and cleanup of parts. |
| POS-5 | `direct.rs:432-456` | `is_permanent_error` excludes Cloudflare/anti-bot challenges (403) from permanent classification; `ssrf blocked` is always permanent (no retries). |
| POS-6 | `transfer.rs:323-334` | skip preflight when RIE succeeded — prevents duplicate checks and preserves session state. |
| POS-7 | `transfer.rs:1246` | `learned_host_ceiling == Some(1)` immediately disables segmentation for hosts that failed — smart adaptation without hardcoded hosts. |
| POS-8 | `engine/scheduler.rs:59,71-79` | Shutdown/Sleep actions are gated by `power_commands_enabled` (disabled by default). |
| POS-9 | `task_api.rs:15,78` | `MAX_TASKS = 10_000` with atomic insertion between two locks. |
| POS-10 | `transfer.rs:1381-1384` + `routes/engine.rs:728-746` | SHA-256 verification after completion and manual verification endpoints with automatic algorithm detection. |
| POS-11 | `engine/metadata_cache.rs` | TTL 3600s and max 2048 entries — prevents unbounded memory growth. |
| POS-12 | `daemon/mod.rs:445-462` | guard prevents the native core from accessing any non-loopback address at startup.

---

## Corrections to Previous Report

| Previous claim | Claimed location | Verdict in current revision |
|----------------|------------------|----------------------------|
| “~40% of the codebase is dead; adaptive/intelligence systems are disconnected” | 29 July report | Incorrect. `AdaptiveEngine`, `AdaptiveConnectionManager`, `SelfHealer`, `PolicyEngine`, `RIE`, `scheduler`, `checksum` are all wired into the actual flow. |
| “`daemon/adaptive/` and `disk_writer.rs` duplicate” | ARCH-2/DUP-1 | Resolved. The folder was removed; only `engine/adaptive/` remains and there is no `disk_writer.rs`. |
| “Inconsistent lock ordering in ProfileManager (possible lock death)” | BUG-HIGH-1 | Incorrect. Lock order is unified `active_profile → profiles` and documented (profiles.rs:234-236). |
| “`CString::new(url).unwrap()` → panic” | CURL-1 | Fixed. `map_err` is used (easy_config.rs:37-38). |
| “`setopt_*` does not check CURLcode” | CURL-2 | Fixed. Checks `CURLE_OK` + free on failure (easy_config.rs:44-49). |
| “`adaptive_engine` field has allow(dead_code)” | state.rs:110 | Incorrect. It is used in creation and updates (transfer.rs:984,1134-1141). |

---

## Priority Fix List

### High (P0)

| # | Location | Issue | Action |
|---|----------|-------|--------|
| P0-1 | `transfer.rs` + `downloads.rs:731-735` | Effective target after redirect and `final_url` from RIE are not re-validated | Run `is_safe_target_url_pinned` before committing to transfer |
| P0-2 | `downloads.rs:757-764` + `transfer.rs:1494-1520` | Link/Rule mirrors not validated and used in failover | Validate every mirror at insertion and on use |

### Medium (P1)

| # | Location | Issue | Action |
|---|----------|-------|--------|
| P1-1 | `easy_config.rs:1197-1201` | Disk preallocation does not work on NTFS | Use `SetFileValidData` with privilege, or check free space instead of preallocation |
| P1-2 | `direct.rs:359` / `engine/retry.rs:6` | Two separate `RetryPolicy` types | Unify the type and feed the actual transfer loop from profile settings |
| P1-3 | `task_api.rs:405` | Non-pinned check in URL update | Use the pinned variant and update resolve entries |

### Low (P2)

| # | Location | Issue | Action |
|---|----------|-------|--------|
| P2-1 | `thread_pool.rs:37-40` | `Relaxed` on counter | Use `Acquire`/`Release` |
| P2-2 | `direct.rs:425-426` | `ssl`/`tls` treated as transient in `is_transient_error` | Narrow list to actually recoverable patterns |
| P2-3 | `chunk_manager.rs` | Unit dead in production | Remove it or move it to tests-only |
| P2-4 | `external_tools/installer.rs:208-214` | `block_in_place`+`block_on` | Use `reqwest::blocking` |
| P2-5 | `engine/adaptive_connections.rs` vs `engine/adaptive/mod.rs` | Two adaptive systems | Document boundaries or merge |
| P2-6 | `plugin_api.rs:49` | `api_version` hardcoded | Perform an actual compatibility check |

---

## Statistical Summary and Final Verdict

| Category | Count | Dominant Severity |
|----------|-------|-------------------|
| SSRF (redirects/mirrors) | 2 | High/Medium |
| Correctness (preallocation, retry) | 3 | Medium/Low |
| Concurrency | 2 | Low |
| Performance | 2 | Low |
| Dead code | 1 full file + 6 partial | Low |
| Architecture | 5 | Low/Informational |
| Critical bug | 0 | — |
| High bug | 1 | — |

Final verdict: the current revision of the engine is actually wired into the flow (contrary to the July report) and adheres to solid security controls at creation. The single real-impact issue is the lack of re-validation of the destination after redirects and when using mirrors — this must be addressed before the network security layer can be considered complete. The remaining observations are improvements and do not prevent operation.
