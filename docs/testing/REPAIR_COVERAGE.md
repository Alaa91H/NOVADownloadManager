# Repair Coverage Log — NOVA Download Manager

> This file is the red→green record for each item in [REPAIR_PLAN.md](../../REPAIR_PLAN.md).
> Last updated: 2026-08-01 — Stages 0–7 completed.

## Baseline status (Stage 0.1 — 2026-08-01)

| Gate | Status | Notes |
|---|---|---|
| `pnpm lint` (tsc) | ✅ green | 0 errors |
| `pnpm lint:eslint` | ✅ green | `--max-warnings 0` |
| `pnpm test` (Vitest) | ✅ green | 314+ tests |
| `cargo check` | ✅ green | 0 errors |
| `cargo test` | ✅ green | 578/578 |
| `cargo clippy --all-targets -D warnings` | ✅ green | 0 warnings |
| `cargo fmt --check` | ✅ green | |
| `pnpm run audit:final` | ✅ green | |

## Completed items log

| Stage | Identifier | Status | Red→Green test |
|---|---|---|---|
| 0 | Fix `React.act is not a function` (NODE_ENV in setup.ts) | ✅ | ✅ |
| 0 | 0.0 bump security tweaks (`logging.rs` + `native_host.rs`) | ✅ | — |
| 0 | 0.2 i18n key parity (132 languages) | ✅ | ✅ (134 tests) |
| 0 | 0.3 novaClient (SSE/retry/window protection) + fix 4xx retry | ✅ | ✅ (10 tests) |
| 1 | H10/H13 ProfileStore returns Result (no silence) | ✅ | ✅ save_failure_is_reported |
| 1 | H4 join watchdog JoinHandle with timeout | ✅ | ✅ |
| 1 | C1/C2 signal_shutdown regression | ✅ | ✅ |
| 1 | H8 stale generation regression | ✅ | ✅ stale_generation_does_not_overwrite |
| 1 | 1.2 DieOrchestrator write path | ✅ | ✅ record_telemetry_persists_to_disk |
| 2 | H1 Pause actually stalls bytes (RateLimit enum + control gate) | ✅ | ✅ pause_actually_stalls_bytes_and_resume_completes |
| 2 | M6 live limits apply immediately (set_live_rate every tick) | ✅ | ✅ live_rate_limit_change_takes_effect |
| 2 | A15 remove default low_speed_limit(500/15s) | ✅ | ✅ |
| 2 | M1/L20 symmetric jitter (integers) | ✅ | ✅ jitter_is_symmetric_and_varied |
| 2 | M12 handle easy.*() no-ops | ✅ | ✅ set_live_rate_rejects_null_handle |
| 3 | H3 hlsDashDownload checks codecs not composite text | ✅ | ✅ hls_dash_download_declared_when_mp4 |
| 3 | H4 CANDIDATE_CURL_RAW_OPTIONS is real | ✅ | ✅ supported_raw_options_are_advertised |
| 3 | H2/M4 scheduled edge-triggered + continue | ✅ | ✅ rules_are_edge_triggered_not_level_triggered |
| 3 | L3 mac sleep via pmset | ✅ | ✅ |
| 3 | M30 HeaderContains exact | ✅ | ✅ header_contains_requires_exact |
| 3 | L8 small extension state + valid regex | ✅ | ✅ invalid_regex_rule_is_rejected |
| 3 | M29/M28 simplifications | ✅ | ✅ |
| 3 | H18 disk quota | ✅ | ✅ disk_budget_is_bytes_per_second |
| 4 | M9 TelemetryBus race-free | ✅ | ✅ telemetry_speed_aggregate_is_recomputed |
| 4 | H9 unwraps → `?` | ✅ | ✅ |
| 4 | M10 rebalance by prefix (no reload) | ✅ | ✅ rebalance_uses_prefix_segment_no_overlap |
| 4 | merge preserves history | ✅ | ✅ merge_preserves_downloaded_progress |
| 4 | SplitSegment at_byte is real | ✅ | ✅ split_at_byte_is_inside_remaining |
| 4 | L13 per_connection_ceiling constant | ✅ | ✅ |
| 4 | M23/L12 improvement cancels cooldown | ✅ | ✅ improvement_cancels_cooldown |
| 4 | H16 set_alive counts transitions once | ✅ | ✅ telemetry_set_alive_counts_transitions_once |
| 4 | M27 lock remove_task_limit | ✅ | ✅ remove_task_limit_cleans_history |
| 4 | types.rs start_byte/end_byte (schema compatibility) | ✅ | ✅ legacy_segment_without_byte_range |
| 4 | merge_parts truncates overlong parts | ✅ | ✅ |
| 5 | **Adaptive engine shipping** — decisions applied to live easy handles | ✅ | ✅ adaptive_segmented_download_grows_and_completes |
| 5 | transfer_config adaptive + adaptiveEvalMs | ✅ | ✅ |
| 5 | dynamic_segments.replace_segments | ✅ | ✅ |
| 5 | CurlMultiGuard::remove | ✅ | ✅ |
| 5 | record_preflight/record_telemetry in production | ✅ | ✅ |
| 6 | M3 pending_events queue bounded | ✅ | ✅ pending_events_queue_is_bounded |
| 6 | M2 with_size(0) → Err | ✅ | ✅ zero_size_pool_is_rejected |
| 6 | M7 mirror upsert + mark all copies | ✅ | ✅ add_mirror_deduplicates + marks_all_copies |
| 6 | M15 next_token wrapping | ✅ | ✅ socket_token_wraps_at_max |
| 6 | M25 remove recovery_window_start | ✅ | ✅ |
| 6 | M4 fallback HTTP client no timeout | ✅ | ✅ |
| 7 | novaClient without window | ✅ | ✅ works_without_window |
| 7 | translations.ts explicit loader | ✅ | ✅ |
| 7 | bridgeStore degraded mode synchronous | ✅ | ✅ setIsDegradedMode_syncs_status |
| 7 | pl.ts full encoding | ✅ | ✅ automated encoding check |

## Second pass (2026-08-01) — Completed items log

| Stage | Identifier | Status | Red→Green test |
|---|---|---|---|
| A | Encoding 10 Latin files (de, es, fr, id, it, nl, pt, ro, sv, tr) — 0 U+FFFD | ✅ | automated check fix-locale-encoding.mjs |
| A | Upgrade encoding check to fail CI on any Latin U+FFFD | ✅ | nova-extension-feature-parity-check |
| B | M8 real Linux readings (meminfo/self.io/stat) + WARN once | ✅ | fallback_warning_logged_once + linux_proc_readings |
| B | M22 segment_ctrl.evaluate() once per tick | ✅ | |
| B | M13 attempted_segments = actual pieces | ✅ | |
| B | M10 clone_with_url instead of plan.clone() | ✅ | |
| B | L17 from_u32 documented | ✅ | from_u32_out_of_range_defaults_to_normal |
| B | M26 remove _mem_gb | ✅ | |
| C | M3 Telegram uses shared Handle (no second runtime) | ✅ | |
| C | logging without cloning full loop | ✅ | task_summaries_aggregate + task_trace_* |
| C | set_live_rate failure logged once not every tick | ✅ | |
| C | L18 document bandwidth table overlap | ✅ | |
| D | M12 reject incompatible api_version | ✅ | incompatible_api_version_is_rejected |
| D | zh.ts/zh_TW.ts translate all English values (sched_engine, rename, logging, progress…) | ✅ | i18n-parity zh/zh_TW |
| D | add zh.ts: candidate.detail.* | ✅ | |

## Documented remaining (outside the two passes)

| Item | Status |
|---|---|
| bn/fa/th (addition): 6,107 U+FFFD characters — non-Latin text collapsed irreversibly, requires manual re-translation | ⬜ follow-up — check warns (does not break CI) |
| A wider recovery map for additional Latin languages if they appear | ⬜ follow-up |
| Stage 8.1: evaluate() live tests with convergence (moved into stage 5 tests) | ✅ covered |
