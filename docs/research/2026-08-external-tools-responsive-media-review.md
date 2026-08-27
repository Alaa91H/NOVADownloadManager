# External Tools, Media Integration, and Responsive UI Review — August 2026

## Decision context

The user reported failures when installing external tools from Settings, inconsistent tool integration, YouTube download failures from the desktop media page, and options that are clipped outside the available window. A controlled, isolated acceptance test of NOVA's yt-dlp installer on 2026-08-27 failed before any download because the unauthenticated GitHub Releases metadata request returned HTTP 403. The provided NOVA log also recorded transient connection retries and `saveConfigToDisk failed`; the latter is currently only logged when Settings uses silent persistence.

## Comparative findings

| Source | Relevant finding | NOVA implication |
| --- | --- | --- |
| [yt-dlp README][1] | yt-dlp documents standalone platform artifacts, recommends the nightly channel for regular users because website changes can break stale releases, and identifies FFmpeg/ffprobe as necessary for combining separate audio and video streams and related post-processing. | Keep NOVA's managed downloader on the official nightly channel, select an exact compatible artifact, verify a published digest, and make the active yt-dlp/FFmpeg state visible before a media task starts. |
| [GitHub REST API rate-limit documentation][2] | Public unauthenticated REST traffic is limited to 60 requests per hour per originating IP. A 403 or 429 with no remaining budget must not be retried until reset; continuing can worsen the restriction. | Do not issue a release-metadata request every time Settings renders or refreshes. Cache successful and temporary-failure metadata, preserve the last verified candidate, and report update checks as indeterminate rather than "up to date" when the provider cannot be reached. Do not embed a GitHub credential in user-device code. |
| [JDownloader FFmpeg support guidance][3] | FFmpeg is requested when a selected audio/video operation needs it; the application reports the effective executable/version and supports an explicit configurable path if automatic installation does not work. | Make automatic installation, health verification, and the selected path separate user-visible states. Retain the manual-path escape hatch after strict executable validation, and do not report media capabilities as ready until the active tool is healthy. |

## Bounded engineering decision

This cycle should address four coupled, high-value issues rather than claim to redesign every page:

1. **Rate-limit-safe tool metadata**: cache GitHub release lookups per tool, preserve an explicitly failed check result, and stop exposing provider failure as "up to date" or "no compatible release" without its cause.
2. **Non-blocking, truthful tool integration**: prevent a long installation/update from monopolizing the external-tool manager lock; report the lifecycle outcome only after installation, activation, registry refresh, and health verification are complete.
3. **Desktop media readiness clarity**: keep YouTube page URLs as the source and surface actionable availability state for yt-dlp/FFmpeg. The user-facing UI must not claim a download was accepted if the media engine rejects task creation.
4. **Responsive layout containment**: replace the Media Download page's rigid `55%`/`45%` two-column split with breakpoint-aware stacking, and make the shared modal and Settings shell fit the usable viewport with scrollable content rather than clipping controls.

The work must retain existing security boundaries: no cookie harvesting or display, no signed-URL canonicalization, no DRM/access-control bypass, no embedded GitHub access token, verified external binary installation only, and no partial localization keys.

## References

[1]: https://github.com/yt-dlp/yt-dlp "yt-dlp README"
[2]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api "GitHub REST API rate limits"
[3]: https://support.jdownloader.org/en/knowledgebase/article/ffmpeg-installation-and-troubleshooting "JDownloader FFmpeg Installation, Troubleshooting and FAQ"
