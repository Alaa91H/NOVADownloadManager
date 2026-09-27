# libcurl core audit

## C-AUD-001: Invalid SHA-256 verification for chunked or resumed transfers

**Severity:** High. **Status:** Fixed and tested.

In `src-tauri/src/daemon/curl/easy_config.rs` each `SegmentWriter` created its own streaming hash when seeing a `Content-Digest`, `Digest`, or `Repr-Digest` header. When a writer was dropped in `drop` it wrote its segment output into the same `streaming_digest_out`, so the final value could be the hash of the last-completed segment only. In `src-tauri/src/daemon/curl/transfer.rs` a completion path could prefer that value over the final output file hash.

This does not prove the integrity of the full file when the transfer is chunked, when resuming from existing data, or when the segment layout changes. The final verification decision must always be based on the SHA-256 computed from the merged output file on disk, because that is the actual final content representation.

Fix implemented: The core now calls `verify_output_sha256` to compute the hash from the merged output file exclusively, and the transfer fails if that computation cannot be performed. The function also disambiguates a hexadecimal SHA-256 representation before Base64, because 64 hexadecimal characters are syntactically valid as Base64. A regression test demonstrates that a single-last-segment hash is rejected while the full-file hash passes.

## C-AUD-002: update checker was passing Cargo.toml to cargo-audit as a lock file

**Severity:** Medium. **Status:** Fixed and verified.

`scripts/check-updates.mjs` was corrected to call `cargo audit --manifest-path src-tauri/Cargo.toml`. The command was tested after the fix with no TOML parse errors and successfully showed the dependency audit result.

## C-AUD-003: relative meta-refresh resolution did not implement full RFC 3986 semantics

**Severity:** Medium. **Status:** Fixed and tested.

The `refreshed_url` function in `src-tauri/src/daemon/utils.rs` constructed relative links manually from the page directory. Values such as `?token=...` or `#fragment` in a `meta refresh` were therefore not resolved relative to the current resource as browsers do, but were appended to the page directory. The manual construction also did not cover all `../`, query, and fragment cases supported by the standard URL parser.

Fix implemented: `refreshed_url` now uses `reqwest::Url::join` with a conservative fallback when the page URL is malformed. Four focused tests covering absolute, relative, root-relative, `../`, query-only, and fragment-only links passed.

## C-AUD-004: alternate name reservation was not atomic until the outlet was opened

**Severity:** Medium. **Status:** Fixed and tested.

`auto_rename_path` created an alternate name with `create_new` then deleted the reservation file before the transfer worker opened it. The gap between deletion and opening allowed a concurrent task to reserve the same name, despite the comment claiming TOCTOU was removed.

Fix implemented: The path now retains a zero-byte reservation file created atomically until the download writer reopens it, and it returns an alternate path only after the reservation is successfully acquired. A regression test proves two conflicting reservations produce different preserved paths on disk.

## C-AUD-005: download task broadcasting ignored some client-visible changes

**Severity:** Medium. **Status:** Fixed and tested.

The change fingerprint on `/api/downloads/events` included numeric progress and status only in most cases. Therefore a backend reanalysis updating the real filename, final URL, save path, engine state, or segment layout might not reach the frontend until a full sync roughly a minute later.

Fix implemented: The fingerprint now includes all mutable fields that the client renders, including metadata and segment layout. A regression test confirms that a backend reanalysis and a segment progress update both change the fingerprint immediately.

## C-AUD-006: analysis cache lost integrity data and mirror priorities

**Severity:** Medium. **Status:** Fixed and tested.

The cache path stored only the mirror URL and ignored `digestSha256` and `mirrorPriorities`; thus a re-analyzed link could be poorer than the first analysis and might lose final verification or mirror ordering. The cache key was the URL only, even though requests with cookies, headers, or proxies can observe different resources.

Fix implemented: The fingerprint and mirror priorities are stored and restored with the result, and the shared cache is limited to the general query without request-specific options. A regression test verifies the fingerprint and mirror ordering match in the stored result.

## C-AUD-007: browser-extension analysis used a simplified HEAD and ignored page context

**Severity:** Medium. **Status:** Fixed and tested.

`/v1/analyze` used a limited HEAD request and effectively ignored the `referrer` and `pageUrl` supplied by the extension. That is insufficient for hotlink-protected links, servers that only support GET-range, meta-refresh pages, and intermediate SourceForge/GitHub redirects.

Fix implemented: Analysis now uses the same full request pipeline as direct downloads, passing the explicit `referrer` and using `pageUrl` as a fallback. A regression test confirms referrer priority and propagation.

## C-AUD-008: segment rebalancing attributed progress to a non-existent part file

**Severity:** Medium. **Status:** Fixed and tested.

Rebalancing created a new prefix range and initialized its counter with the bytes transferred value, even though those bytes existed only — if at all — in the tail of the previous slow part file. During reconstruction that extra portion is trimmed from that file and an independent file is created for the new range; therefore the counter could report progress higher than data written and could cause scheduling to skip a range that still required downloading.

Fix implemented: The independent prefix part starts at zero and the slow part counter is clamped to its new range length. A regression test shows range layouts remain adjacent without overlap and the new part does not inherit another file's progress.

## C-AUD-009: zero CPU sample produced an invalid connection range

**Severity:** Medium. **Status:** Fixed and tested.

The protocol adapter computed the maximum HTTP connections by multiplying `cpu_count` directly. With a temporary zero value from the resource monitor this produced a range like `2..=0`, which could then pass into a clamp in the adaptation engine and panic during a live download.

Fix implemented: CPU count is bumped to at least one with saturated multiplication, and the maximum is ensured not to be less than the minimum. A regression test validates the HTTP/2, HTTP/3, HTTP/1.1, and unknown-protocol ranges remain sane at a zero sample.

## C-AUD-010: connection budget calculation was vulnerable to anomalous CPU multiplication overflow

**Severity:** Low to Medium. **Status:** Fixed and tested.

The resource monitor multiplied CPU count and then multiplied by three in the medium-memory path. Although anomalous values are rare, this could overflow in debug builds and stop adaptation decisions during a live download.

Fix implemented: Saturating multiplication is used with a minimum CPU value of one before applying memory bounds and an explicit maximum of 32. A regression test proves `u32::MAX` yields the safe cap 32 without panic or overflow.

## C-AUD-011: adaptation adjustment cap could permanently block improvement

**Severity:** Medium. **Status:** Fixed and tested.

The check that allowed an adjustment rejected any attempt after reaching the per-minute cap, while the counter was only reset inside `record_adjustment`. After the minute elapsed no new adjustment could be performed to reset the counter; adaptation decisions remained blocked for the entire task.

Fix implemented: The allow-check now applies the counter only within its 60-second window and then permits the next adjustment that reinitializes the counter. A regression test confirms that an expired window with a full counter does not prevent adaptation.

## C-AUD-012: server profile probe counters and window were overflowable

**Severity:** Low to Medium. **Status:** Fixed and tested.

The measurement aggregation used unsaturated increments for probe counters and used a plateau detector that summed window speeds directly into `u64`. Long-lived or anomalous values could overflow in debug builds and stop the adaptation layer.

Fix implemented: Counters are saturated, the average speed is computed in `u128` and then clamped to `u64`. A regression test shows `u64::MAX` counters and a window of maximum speeds do not overflow while preserving the connection ceiling correctly.

## C-AUD-013: server analyzer accepted zero recommended connections and overflowable counters

**Severity:** Medium. **Status:** Fixed and tested.

The recommended connection count multiplied `cpu_count` directly; on a zero CPU sample for a stable server and a large file this could produce zero connections. Probe and consecutive-failure counters used unsaturated increments on several paths.

Fix implemented: Defensive calculation uses CPU count at least one, saturated multiplication, correct protocol bounds, and measurement counters are saturated. The full server analyzer test suite passed, including zero/max CPU samples and maxed counters.

## C-AUD-014: mirror sorting could silently change the active source

**Severity:** Medium. **Status:** Fixed and tested.

The mirror manager stored the active source as an index into a vector and then re-sorted the vector when adding a mirror. Inserting a higher-priority mirror could change indices and cause an ongoing load to switch silently to a different source that was not selected by the failover decision.

Fix implemented: The active source URL is saved before sort and its index is re-found afterward; it is only replaced if the source disappears. A regression test shows adding a higher-priority mirror after a failover does not change the active fallback source.

## C-AUD-015: retry policy was overflowable and jitter-biased under fast calling

**Severity:** Medium. **Status:** Fixed and tested.

Retry policy tests showed the jitter derived solely from the nanosecond clock could be heavily biased when calls occurred within the same clock tick; multipliers and counter increments used operations that could overflow, and non-finite or non-positive backoff factors were not normalized.

Fix implemented: An atomic sequence mixed with system time distributes jitter, saturated operations are used for durations and counters, and invalid backoff factors are treated as a safe 1.0. All retry policy tests passed, including the symmetry/diversity test that previously failed.

## C-AUD-016: task bandwidth average was overflowable by the sample window

**Severity:** Low to Medium. **Status:** Fixed and tested.

Task speed averaging summed `u64` samples directly. A sufficiently large window could overflow and expose an incorrect speed or halt debug builds, which would affect progress and ETA.

Fix implemented: The average is aggregated in `u128` and then clamped to `u64`. A regression test shows a full window of `u64::MAX` samples returns the correct average without overflow.

## C-AUD-017: active downloads counter in priority queue could wrap to zero

**Severity:** Medium. **Status:** Fixed and tested.

Starting a new download incremented a `u32` counter atomically with `fetch_add`; on a concurrent or already-wrong counter reaching its maximum this wrapped to zero, allowing the queue to start additional work as if no active downloads existed.

Fix implemented: Increments are now atomic and saturating using `fetch_update`, so the counter stays at `u32::MAX`. A regression test verifies additional starts do not wrap the counter to zero.

## C-AUD-018: segment layout allowed empty ranges and progress exceeding file size

**Severity:** High. **Status:** Fixed and tested.

The segment manager accepted more connections than available bytes for a small file, creating active segments of zero length. It also stored incoming byte counters as-is and aggregated them without saturation; a late update or a new layout could display progress over 100% or reassign a previous range's counter to a different range after rebalancing.

Fix implemented: The number of segments is limited by available bytes, each segment counter is saturated at its range length, and aggregated progress is saturated at file size. A live value is not retained across a reshuffle unless the segment ID and its bounds remain identical. Regression tests cover small files, excessive progress values, and reshaping a range with a fixed identifier.

## C-AUD-019: later successful download did not fully settle host failure history

**Severity:** Medium. **Status:** Fixed and tested.

`SelfHealer::on_success` marked only the last failure record as resolved and then cleared the host counter. Older failures for the same host remained unresolved in the history, so `health_status` could continue reporting degraded condition despite the successful transfer, and the host failure map could diverge from retention windows when old records were removed.

Fix implemented: Every stored record for the successful host is marked resolved, health state excludes resolved failures, and the host failure map follows the same retention window as the record store. The recovery counter is now saturated. Regression tests cover health settlement after success and deletion of an old record with multiple host counters.

## C-AUD-020: connection coordinator could exceed the cap when capacity was exhausted

**Severity:** Medium. **Status:** Fixed and tested.

`recommended_connections_for_host` limited recommendations by available capacity then enforced a minimum of one connection. When the global or host cap was exhausted the intermediate result was zero before that enforcement, then it returned one and allowed budget overruns. Host connection summation and host counter increment were also overflowable.

Fix implemented: The recommendation now returns an explicit zero when no capacity remains to defer the consumer, and summation/increment use saturated operations. Regression tests verify exhausted global and host capacity and behavior at `u32::MAX`.

## C-AUD-021: deep nested event sequencing could exhaust live-progress server stack

**Severity:** Medium. **Status:** Fixed and tested.

After notifying subscribers, the event channel would re-invoke `publish` directly for each nested event in the queue. A subscriber that publishes one follow-up event per event could create a chain with no practical bound of nested calls; although this did not exhaust the pending event list, it could exhaust the thread stack and stop live progress broadcasting. A zero record capacity and a subscriber ID at the max value could also cause invalid indexing or reuse of an ID.

Fix implemented: Nested events are processed in a local iterative FIFO queue that preserves publish order without growing the stack. Record capacity is printed to at least one, and the bus does not issue duplicate IDs when the space is exhausted; it returns the reserved zero value to signal failure. A test of 4097 follow-up events preserves ordering and correct delivery.

## C-AUD-022: curl engine selection rejected valid URI schemes with mixed-case

**Severity:** Medium. **Status:** Fixed and tested.

`CurlExtractor::can_handle` compared lowercase prefixes only such as `https://`. URI schemes are case-insensitive, so a valid link like `HTTPS://...` or `FtP://...` could fail before parsing and download, despite the URL parser and transport being able to handle it.

Fix implemented: The selector extracts the scheme and compares case-insensitively via `eq_ignore_ascii_case` for all supported curl protocols, while preserving media option exclusion. Regression tests cover mixed-case HTTP, HTTPS, FTP, SFTP, and SCP and confirm rejection of unsupported schemes.

## C-AUD-023: plugin interface accepted undefined settings and applied partial updates

**Severity:** Medium. **Status:** Fixed and tested.

Public HTTP endpoints for plugins accepted a settings map from the client. `update_plugin_settings` added every key directly, even when not present in `PluginManifest.settings`. Because the input was applied inside the loop, subsequent validation could leave the state partially updated. The plugin manifest also accepted an empty identifier, which is invalid for paths or state management.

Fix implemented: Empty identifiers are rejected at registration, setting keys are validated against the manifest before changing any state, and updates are applied atomically. Tests prove an undeclared key is rejected while the previously declared value remains unchanged.

## C-AUD-024: rules interface reported success for malformed rules and lost signed-link extension

**Severity:** Medium. **Status:** Fixed and tested.

`add_rule` recorded an invalid regex then returned without error, while the HTTP endpoint unconditionally returned success. Duplicate rule identifiers could be added, causing the same action to execute multiple times. The `UrlExtension` check applied to the full link end; it therefore did not match `archive.zip?signature=...#...` even though the actual path extension is `.zip`.

Fix implemented: The validated interface `try_add_rule` validates the identifier, the regex, and duplication and returns an error to HTTP; a separate test-only function remains for internal path checks. The extension check now strips query and fragment before matching. Tests cover reportable errors, atomicity, duplication, and signed links.
