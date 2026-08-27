# Video Extension Reliability and UX Review

**Date:** 2026-08-27
**Scope:** A bounded follow-on assessment after `v2.4.39-alpha`, focused on browser-extension media capture, YouTube page routing, managed media analysis, and truthful user-facing status.

## Evidence-based findings

| Topic                  | Finding                                                                                                                                                                                                                                                                                              | Decision for NOVA                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yt-dlp freshness       | The yt-dlp project describes its nightly channel as the recommended release channel for regular users because the less-frequent stable channel can become externally broken as sites change.[1]                                                                                                      | Retain NOVA's verified managed external-tool installation/update path and make missing or outdated tool readiness immediately actionable in the extension UI.                                                                                                     |
| YouTube formats        | yt-dlp documents that YouTube often exposes higher quality video and audio separately, making FFmpeg required for a merged result.[2]                                                                                                                                                                | Do not route a YouTube page or transient `googlevideo` delivery URL into a direct browser download. Route a stable page URL to NOVA's managed analysis, clearly show the tool/FFmpeg prerequisite, and keep response acceptance daemon-authoritative.             |
| Access limitations     | yt-dlp explains that some YouTube formats/features can require externally supplied PO tokens and that cookie use is sensitive and may carry account risk.[3] YouTube's Terms prohibit downloading or circumventing Service restrictions except when explicitly authorized or otherwise permitted.[4] | Do not add cookie extraction, cookie export, PO-token generation, CAPTCHA evasion, DRM bypass, or direct delivery-URL replay. Surface a bounded, privacy-preserving failure and offer the existing tool-health/update route.                                      |
| Browser download state | Chrome documents that download changes carry state, resumability, danger, and interruption reasons; extensions should monitor rather than infer outcome from the initial start call.[5]                                                                                                              | Track direct browser downloads by ID and report explicit completion, interruption, or browser safety-block states rather than a generic optimistic toast. Never auto-accept danger warnings.                                                                      |
| Popup UX               | Chrome's extension guidance separates service-worker, content-script, and popup failures, and recommends inspecting component-specific errors.[6] Mature media extensions emphasize immediate detection with a compact, discoverable action rather than an empty popup.[7]                           | Preserve the compact YouTube “Resolve via NOVA” affordance even with no generic candidate. Add a concise, localized state model that distinguishes scanning, analysis, desktop unavailable, tools unavailable, rejected by NOVA, and successful queue acceptance. |

## Candidate bounded improvements

1. Add an explicit **managed-media readiness snapshot** to the desktop bridge response, covering daemon connection, yt-dlp health/version, and FFmpeg availability without exposing installation paths or credential-bearing URLs.
2. Make the popup's YouTube primary action use the stable scanned page URL whenever possible, including the empty-candidate state, and show a repair path when readiness is insufficient rather than silently failing after a click.
3. Add stable, localized UI states for analysis/retry and direct-download completion/interruption. Do not parse browser error strings; use structured state/reason categories only.
4. Strengthen regression coverage for stable YouTube routes, readiness failures, duplicate primary clicks, delayed accepted responses, and direct-download terminal state changes.
5. Apply only constrained popup CSS improvements that keep controls within the browser action surface and remain keyboard-accessible. No image asset is necessary for this cycle.

## References

[1]: https://github.com/yt-dlp/yt-dlp 'yt-dlp README — release channels'
[2]: https://github.com/yt-dlp/yt-dlp/wiki/FAQ 'yt-dlp FAQ — FFmpeg requirement for YouTube audio/video merge'
[3]: https://github.com/yt-dlp/yt-dlp/wiki/extractors 'yt-dlp extractor guidance — YouTube limitations and token/cookie cautions'
[4]: https://www.youtube.com/static?template=terms 'YouTube Terms of Service — permissions and restrictions'
[5]: https://developer.chrome.com/docs/extensions/reference/api/downloads 'Chrome downloads API'
[6]: https://developer.chrome.com/docs/extensions/get-started/tutorial/debug 'Chrome extension debugging guidance'
[7]: https://downloadhelper.net/ 'Video DownloadHelper product overview'
