# yt-dlp Installation Sources and Channel Policy

**Last verified:** 2026-08-21 (GMT+2)
**Purpose:** Document the upstream facts that govern NOVA-managed yt-dlp installation and YouTube format discovery.

## Authoritative upstream facts

The official yt-dlp project publishes native release binaries for all NOVA targets, including `yt-dlp.exe` for Windows x64, `yt-dlp_linux`, `yt-dlp_linux_aarch64`, and `yt-dlp_macos`. GitHub release metadata for the selected official asset supplies a SHA-256 digest. NOVA obtains only an HTTPS asset URL from the official GitHub release, verifies the asset against that published digest before installation, applies the executable atomically, and performs a post-install health check.

Upstream documents three binary channels: `stable`, `nightly`, and `master`. It also states that `stable` may become stale when websites change and recommends `nightly` for regular users. Because YouTube changes independently of desktop-release schedules, NOVA's managed installer uses the official **yt-dlp nightly** release channel by default. The nightly source remains restricted to `yt-dlp/yt-dlp-nightly-builds`, and the same GitHub-host allow-list, SHA-256 verification, atomic replacement, registry ownership record, and health validation apply before a tool becomes available to a task.

> NOVA does not invoke yt-dlp's self-updater for managed installations. Every installation or update remains inside NOVA's verified acquisition and replacement workflow.

The official FAQ explains that higher-quality YouTube formats commonly contain separate audio and video tracks, requiring FFmpeg to merge them. NOVA therefore sends the selected video `formatId` as `formatId+bestaudio/best` when the selected format has video but no audio. It uses the stable watch URL, rather than an expiring `googlevideo` stream URL, so yt-dlp resolves fresh media URLs when the managed task starts.

A live metadata-only acceptance check on 2026-08-21 verified the latest official nightly binary after SHA-256 validation. It successfully resolved a public YouTube page, returned its title, duration, direct page URL, and a catalog of available video formats including format IDs, resolutions, codecs, bitrates, and sizes where YouTube provided them. The equivalent stable binary was blocked by YouTube's current anti-bot flow in the same environment.

## Cookies and access boundaries

The official FAQ states that some sites, including YouTube, may require requests to originate from the same IP address and use the same cookies and headers as a browser session. NOVA does not bypass a CAPTCHA, manufacture cookies, or silently export browser data. If YouTube requires authentication for a particular account, region, or IP, the user must explicitly provide an authorized session through the application's supported cookie configuration. Errors remain visible and actionable rather than being misrepresented as successful downloads.

## Design implication for Windows destinations

A normal desktop process cannot reliably write to `C:\Program Files` without elevation. The default NOVA-managed per-user destination is therefore writable without elevated privileges, while a machine-wide `C:\Program Files\YT-DLP` install requires an explicit elevated flow. The backend must never silently select another path while reporting that it installed to Program Files.

## Sources

1. [yt-dlp README: release channels, binaries, FFmpeg, and yt-dlp-ejs](https://github.com/yt-dlp/yt-dlp#installation)
2. [yt-dlp FAQ: cookies, same-IP access, headers, and FFmpeg merging](https://github.com/yt-dlp/yt-dlp/wiki/FAQ)
3. [Official yt-dlp nightly releases](https://github.com/yt-dlp/yt-dlp-nightly-builds/releases)
4. [yt-dlp public signing key](https://github.com/yt-dlp/yt-dlp/blob/master/public.key)
