# Browser media reliability and overlay UX review

**Date:** 2026-08-28
**Scope:** Bounded review of the NOVA browser-extension media-analysis and handoff flow, with a focus on truthful YouTube/video feedback and privacy-preserving user experience.

## Research findings

The yt-dlp project documents three relevant operational facts. First, site behavior can change independently of a download manager, making current extractor updates important; its current documentation distinguishes stable, nightly, and master channels and recommends nightly for regular users when stable is affected by external breakage. Second, high-quality YouTube formats can be split into separate video and audio streams, so FFmpeg is needed to merge them. Third, an arbitrary URL cannot reliably be classified as supported before attempting extraction because yt-dlp’s generic extractor intentionally matches every URL. The product consequence is that NOVA should perform bounded daemon analysis and present its outcome, not infer success from a visible player or offer a guaranteed pre-analysis download action. [1] [2]

The yt-dlp FAQ notes that delivery URLs can require the same session context, IP address, cookies, or headers and may not work on another machine or directly in a browser. NOVA must therefore continue to analyze stable page URLs locally and must not harvest, export, or replay cookies, signed delivery URLs, authorization headers, CAPTCHA state, or other access material. The FAQ also makes clear that a user must keep the extractor and FFmpeg current when diagnosing a capability issue. [2]

The comparative projects reviewed advertise automatic download capture, candidate/quality pickers, and handoff to a native engine. Their issue trackers also show a practical failure mode: the browser can receive an HTML navigation instead of the final file or can begin its own download before an extension has a meaningful direct candidate. A safe product response is a clear distinction between a discovered direct candidate and a page that needs daemon-backed analysis, together with an explicit refresh/retry control. It is not to capture opaque navigation pages or extend page-script privileges. [3] [4] [5]

## Decisions for this bounded cycle

| Area | Decision | Safety boundary |
|---|---|---|
| Overlay call to action | Present the action as a NOVA page analysis until a real format catalog exists; use a download label only for a verified selectable format. | Never promise that every video player or embedded site is downloadable. |
| Empty catalog feedback | Preserve daemon categories for unavailable tool, timeout, invalid output, excessive output, protected media, and no offered formats; show a short localized remedy. | Do not render raw extractor stderr, page URL query strings, delivery URLs, cookies, or headers. |
| Retry behavior | Allow one user-driven re-analysis after a terminal/empty analysis. Serialize in-flight analysis and reject stale chosen formats. | Do not loop, bypass rate controls, or retry around a service’s access policy. |
| Direct capture | Continue sending only validated, cached direct candidates through the approved bridge/outbox flow. | Do not treat an HTML page, JavaScript URL, iframe-origin source, or transient media delivery URL as a direct download. |
| Tool readiness | Surface missing/invalid yt-dlp or FFmpeg as a local-tool readiness condition with the established verified installation path. | Retain trusted-source, checksum, health-check, and atomic-install controls. |

## References

[1]: https://github.com/yt-dlp/yt-dlp "yt-dlp README: update channels, dependencies, and format selection"
[2]: https://github.com/yt-dlp/yt-dlp/wiki/FAQ "yt-dlp FAQ: supported URL limits, FFmpeg, and delivery URL context"
[3]: https://developer.chrome.com/docs/extensions/reference/api/webRequest "Chrome webRequest API"
[4]: https://github.com/amir1376/ab-download-manager/issues/1140 "AB Download Manager issue 1140: automatic browser capture failure mode"
[5]: https://github.com/PBhadoo/QDM "QDM: open-source download manager and browser handoff comparison"
[6]: https://github.com/ekremx25/linux-download-manager "Linux Download Manager: browser-to-native handoff comparison"
