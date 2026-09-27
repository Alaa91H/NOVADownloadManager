# Download-Manager Benchmark Notes

**Research date:** 2026-08-26

This working note records externally observed patterns for use in NOVA's next bounded improvement cycle. It is not a claim that every referenced feature is suitable for NOVA or Android.

| Reference | Observed pattern | NOVA implication | Source |
|---|---|---|---|
| Gopeed | Separates its Flutter UI from a Go backend and offers Android ABI-specific artifacts; supports multiple protocols, browser integration, APIs, and extensions. | Reinforces NOVA's direction: retain a narrow typed native core boundary and avoid coupling platform UI directly to transfer semantics. Protocol expansion is not a foundation-milestone priority. | [1] |
| Rakhsh | Offers task IDs/tags/groups, ordered batches, and state/progress flows, but stores only in `Context.filesDir` and leaves external storage handling to the host. | Validates NOVA's planned immutable task snapshot/event approach and app-private-staging-first policy. NOVA should not copy its Kotlin transfer engine because NOVA's Rust core must remain authoritative. | [2] |
| Free Download Manager reference repository | Markets pause/resume, batch downloads, priorities, scheduling, bandwidth management, proxy/mirror support, and browser integration. | Confirms the general product taxonomy, but this particular repository is extremely small; treat it as feature-language reference rather than implementation evidence. NOVA already has desktop implementations of many items that need measured core extraction, not new UI duplication. | [3] |

## Initial research conclusions

1. **Event model before feature breadth.** Stable task IDs, bounded progress/state events, groups/tags, and app-private staging are prerequisite patterns. NOVA's Android design already names the first three but does not yet expose task snapshots/events through UniFFI.
2. **Platform adapters must own storage and lifecycle.** Rakhsh's app-private limitation highlights why NOVA should add SAF/MediaStore only after a typed Rust destination contract exists. [2]
3. **ABI automation is a release requirement.** Gopeed's explicit mobile packaging illustrates why NOVA must promote its local ARM64 bridge proof into reproducible CI artifacts before claiming native Android support. [1]
4. **Do not equate feature catalogues with parity.** Batch, queue, scheduling, browser capture, proxy, and media capabilities must be classified as shared-core, Android adapter, desktop-only, or deferred before implementation.

## Next research questions

- What durable state/retry and notification patterns are documented by official Android guidance for user-started transfers?
- Which download-server edge cases should direct-download engines handle (range support, validators, redirects, filename headers, retry classification)?
- Which existing NOVA code/tests reveal the highest-leverage, low-risk extraction or regression fix for the current cycle?

## HTTP correctness findings

| HTTP behavior | Evidence | Testable NOVA requirement |
|---|---|---|
| Range capability and fallback | `Accept-Ranges: bytes` advertises range support; a supported byte range returns `206` with `Content-Range`; an unsupported range request may return the full body with `200`; an invalid range returns `416`. | Persist whether resume/segmentation is eligible, verify `206` and `Content-Range` before writing a segment at an offset, restart safely on `200` fallback, and classify `416` without corrupting the partial file. [4] |
| Validator-safe resume | Resuming a partial resource must ensure that stored bytes refer to the same representation; `If-Range` can use one ETag or a date, with a non-match returning a complete `200` response. | Persist a strong validator when available; use it in resume planning; atomically discard/restart stale partials rather than merge two versions. [5] |
| Filename safety | `filename*` takes precedence over `filename` when understood; path information must be stripped, output must not overwrite an existing file, and special filenames must be avoided. | Parse filename suggestions defensively, preserve only a sanitized display name, use collision-safe destination policy, and retain an opaque task identity independent of the remote filename. [6] |

These observations produce a high-value audit focus: verify that the desktop direct-download path consistently validates ranged response semantics and stored validators across retry/resume, and add focused regression coverage before extracting those semantics to mobile.

## Product and operational patterns

| Reference | Observed pattern | Transferable NOVA action | Boundary / caution |
|---|---|---|---|
| Motrix | Core is separated from UI; sessions are durable; notification/secret storage have platform implementations; release documentation names beta gates and migration limits. | Make core/host separation enforceable, add redacted diagnostics and durable session contracts, and state release evidence precisely. | Motrix's JSON-RPC/headless server and plugin runtime are not a reason to reintroduce an Android loopback service. [7] |
| AB Download Manager | Project has an explicit shared/downloader/android layout and treats queue/scheduler/browser integration as first-class product areas. | Prioritize moving queue/retry/task contracts from NOVA desktop composition into portable Rust crates before Android UI claims parity. | Repository feature text alone is not proof of Android behavior; NOVA must validate its own execution and storage model. [8] |
| HTTP Downloader | Exposes a rich add-task policy surface: parts, retry count, speed limits, proxy/site settings, credentials, headers, queueing and verification. | Add a typed preflight/metadata contract and make per-task policy overrides explicit, validated, and redacted from diagnostics. | Do not copy its very high connection defaults or raw-secret command options. NOVA must retain safe connection/bandwidth limits and secure storage. [9] |

## Revised candidate backlog

1. **High confidence, high leverage:** extract a portable direct-download preflight contract that records range eligibility, total-length knowledge, validators, sanitized filename suggestion, and an explicit response classification. Add desktop regression tests for `206`, `200` range fallback, `416`, and validator mismatch.
2. **High confidence, bounded scope:** define typed task snapshot/event records in `nova-core-model` so Android receives durable state by bridge rather than reconstructing it from UI conditions.
3. **Medium confidence:** define task grouping/labels as portable metadata only after their persistence and search semantics are documented; do not add UI-only grouping.
4. **Defer:** plugin marketplace, arbitrary resolver plugins, remote web control, BitTorrent, mirror selection, and media extraction require separate security, policy, and lifecycle designs.

## NOVA audit and implemented improvements

The audit of the live `daemon/curl/transfer.rs` path confirmed that NOVA runs libcurl multi transfers, performs a bounded range preflight, and uses the resolved boolean to select segmented versus single-connection execution. It also uncovered two bounded correctness/security gaps addressed in this cycle:

| Finding | Change | Evidence |
|---|---|---|
| Raw host extraction in adaptive decision context included URL user info and did not distinguish ports. The same mismatch existed between origin learning and connection leasing. | `direct::host_key` now uses the libcurl URL API, removes bracket duplication for IPv6, excludes credentials/path/query/fragment, includes the effective port, and is used by adaptive decisions and connection leases. | New unit coverage exercises credentials, query/fragment removal, port separation, malformed URLs, and IPv6. The direct host-key and transfer suites pass. |
| A normal libcurl preflight returned `code == 206` to the dispatch planner but did not set `PreflightData.supports_range`, leaving adaptive profile seeding with a false value. | The resolver now stores the discovered range result in `PreflightData` before returning it. | New loopback range-server regression test asserts that the resolver result and adaptive metadata both report range support. The full transfer suite passes. |

The next mobile extraction should consume these normalized, typed facts rather than reparsing raw URLs or rediscovering range behavior in Kotlin.

## References

[1]: https://github.com/GopeedLab/gopeed "Gopeed repository"
[2]: https://github.com/ItsBenyaamin/rakhsh "Rakhsh repository"
[3]: https://github.com/DreamPack-Software/FreeDownloadManager "Free Download Manager reference repository"
[4]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests "MDN: HTTP range requests"
[5]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests "MDN: HTTP conditional requests"
[6]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition "MDN: Content-Disposition"
[7]: https://github.com/agalwood/Motrix "Motrix repository"
[8]: https://github.com/amir1376/ab-download-manager "AB Download Manager repository"
[9]: https://erickutcher.github.io/ "HTTP Downloader project"
