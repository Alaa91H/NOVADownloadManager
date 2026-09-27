# YouTube Managed Download Verification

**Date:** 2026-08-21 (GMT+2)
**Scope:** Browser-extension quality selection, desktop `yt-dlp` task delivery, managed-tool installation, and cross-platform packaging.

## Result summary

| Verification area | Result | Evidence |
|---|---:|---|
| Extension contract for an explicit YouTube quality | Passed | The contract carries the stable watch URL, the selected `formatId`, reported size, and an idempotency key. |
| Extension-to-daemon managed handoff | Passed | A loopback integration test delivered the selected format to `POST /v1/media/add` and asserted the watch URL, `formatId`, and size received by the daemon fixture. |
| Video-only format handling | Passed | Rust tests prove that a video-only format such as `137` becomes `137+bestaudio/best`; muxed and audio-only formats preserve their selected ID. |
| Managed `yt-dlp` installation | Passed | The official nightly binary was acquired only after checking the GitHub-published SHA-256 digest, installed in a temporary managed location, and passed its `--version` health check. |
| Live YouTube catalog discovery | Passed | The verified official nightly binary resolved a public YouTube page and returned its title, duration, page URL, format IDs, resolutions, codecs, bitrates, and sizes where provided. |
| Actual media-file download from sandbox IP | Blocked externally | A later download-only invocation received YouTube's explicit “Sign in to confirm you’re not a bot” challenge. NOVA did not bypass the challenge, fabricate cookies, or report the download as successful. |
| Local quality gates | Passed | 716 Rust tests, 761 browser-extension tests, TypeScript, ESLint, Prettier, release audit, and production builds passed before push. |
| Cross-platform CI | Passed | GitHub Actions run `32435178587` completed successfully: frontend validation, lint/typecheck, Windows x64/ARM64, macOS x64/ARM64, Linux x64/ARM64, and build-matrix summary all succeeded. |

## Implemented behavior

The floating control and popup analysis panel no longer hand an expiring `googlevideo` stream URL to the browser's generic download path. On explicit quality selection, the extension sends the stable page URL and the selected yt-dlp `formatId` to NOVA through `POST /v1/media/add`. The desktop daemon creates a managed media task. A video-only choice automatically requests the best compatible audio and delegates merging to FFmpeg; a muxed format or audio-only format retains its exact selected ID.

The extension opens NOVA after an explicit quality selection without attaching a capture parameter. This focuses the desktop application but does not create a second capture-review dialog for a task the user has already approved by selecting a quality.

NOVA's managed installer now uses the official yt-dlp nightly channel, which upstream recommends for regular usage because site extractors can change between stable releases. The release source is restricted to the official repository and the existing SHA-256, atomic-replacement, and executable-health safeguards remain mandatory.

## Access-boundary finding

> The remaining end-to-end file-transfer step requires an authorized YouTube session when YouTube applies its anti-bot challenge to the current IP. This is an upstream access-control decision, not a NOVA download-engine success or failure.

The official yt-dlp FAQ explains that some services require the same IP address plus browser cookies and headers. A complete authenticated acceptance test must therefore be performed with a user-authorized session and content the user is permitted to download. NOVA must surface such a requirement clearly and must not attempt to bypass CAPTCHA, account controls, DRM, or service terms.

## References

1. [yt-dlp README — release channels, dependencies, and format support](https://github.com/yt-dlp/yt-dlp#installation)
2. [yt-dlp FAQ — same-IP access, cookies, headers, and FFmpeg merging](https://github.com/yt-dlp/yt-dlp/wiki/FAQ)
3. [GitHub Actions run 32435178587](https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32435178587)
