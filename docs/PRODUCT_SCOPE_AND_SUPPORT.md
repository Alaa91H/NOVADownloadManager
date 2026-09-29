# NOVA Download Manager: Product Scope and Support

NOVA Download Manager is an open-source desktop download manager. Its Qt/QML desktop interface connects to a Rust daemon that owns direct, media, and torrent download engines, local media processing, queues, and browser handoff. The browser companion is a separate extension. The project is distributed under the MIT License; third-party notices remain subject to their own licenses in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

This document describes the current native product. Runtime capability responses are authoritative: they distinguish implemented paths from source formats, remote-server behavior, and platform features that are not available in every build.

## What NOVA can do

| Area | Implemented capability | Important condition or boundary |
|---|---|---|
| Direct files | Download HTTP/HTTPS through the in-process `libcurl multi` engine, with segmented transfer, retries, checksums and recoverable pause/resume. | Segmentation and resume depend on the linked transport capabilities and the server's correct Range and validator behavior. |
| Multi-connection downloads | Use byte-range segments when the server accepts Range requests and the linked `libcurl` capability check allows segmentation. | A server that ignores or rejects Range requests cannot provide segmented or byte-accurate resume behavior. |
| Pause and resume | Preserve owned partial output checkpoints and segmented part files, then resume through the applicable Range path. | Resume still requires compatible server behavior; NOVA reports a limitation rather than silently corrupting a file. |
| Media workflows | Use the in-process Rust media engine for supported site extraction and direct, HLS and DASH sources. HLS/DASH supports selected video/audio representations, separate audio renditions, live recording checkpoints, native track muxing, playlist batches and local codec conversion. | Site extraction, manifest layout, codecs, containers and output conversions are capability-gated. Multi-period DASH assembly is not currently advertised. Native paths do not require a separately installed `yt-dlp` or FFmpeg executable. |
| Torrent transfers | Run BitTorrent v1 magnet and `.torrent` downloads through the in-process Rust engine, including tracker and peer discovery, verified piece storage, resume, per-file priority, pause/resume, and configurable seeding. | Network reachability, tracker policy, peer availability, storage permissions and advertised runtime capabilities determine whether a task can proceed. BitTorrent v2 is not claimed. |
| Browser handoff | Capture supported download candidates through a Manifest V3 companion and a local-only desktop bridge. | The desktop application must be installed, running, and paired; browser policy and site restrictions still apply. |
| Queue controls | Manage task queues, categories, priorities, retry settings, bandwidth controls, rules, schedules, mirrors, and checksums. | Individual controls are capability-gated before they reach the daemon. |
| Accessibility and language | The Qt desktop interface provides English and Arabic dictionaries, RTL layout, keyboard and screen-reader semantics, contrast modes and text scaling. | Desktop release language scope is English and Arabic. Product names, protocols, command syntax, file extensions and sample values remain untranslated. |
| Releases | Publish installable desktop artifacts, the browser companion packages, an Android ARM64 APK, and `SHA256SUMS.txt` through the release pipeline. | Release availability follows the CI matrix; package-manager metadata files are not published as end-user release assets. |

## How the download engine makes decisions

NOVA does not advertise a capability merely because a UI control exists. At startup, the daemon validates the linked `libcurl` runtime and exposes a capability matrix. The desktop interface and browser companion consume that information, and the daemon validates again before a task is started. This prevents a non-supported option from being presented as a guaranteed feature.

For a partial direct download, NOVA treats a real destination checkpoint as task-owned data rather than a foreign duplicate. A default rename policy therefore must not create a second target file and discard the existing bytes. When an existing single-file checkpoint would otherwise be promoted into a new segmented layout, NOVA keeps a matching single-file Range resume path so the original checkpoint remains usable.

> Resume is a protocol feature, not a promise that every remote server can honor. A server must return correct Range responses for a partial file to continue. Servers that always return a full `200 OK` response cannot offer ordinary HTTP resume semantics.

## Privacy and local-service model

The desktop service binds locally and uses a trusted local pairing model for browser handoff. The project also applies protocol controls, local-address validation for outbound work, path checks for file operations, and redaction for configured credential fields. See [`SECURITY.md`](../SECURITY.md), [`architecture/CAPABILITY_GATING.md`](architecture/CAPABILITY_GATING.md), and the extension [privacy model](extension/PRIVACY.md) for implementation details and security boundaries.

NOVA is not a cloud storage service, VPN or DRM bypass tool. It includes a native BitTorrent v1 client and native media paths, but it cannot bypass source access controls or download content that the selected runtime, remote server or applicable law does not permit.

## Installation and verification

Use the GitHub [Releases page](https://github.com/Alaa91H/NOVADownloadManager/releases) to obtain the package for your platform. Verify downloaded artifacts against the accompanying `SHA256SUMS.txt` before installation. Windows releases include `.exe` installers for supported architectures; Android releases include only the ARM64 APK asset when the primary CI release job succeeds.

The browser extension packages are released separately for Chromium/Chrome, Edge, and Firefox. Load only an asset from the matching NOVA release, then pair it with the installed desktop application. Browser capture is designed for local handoff; it does not replace browser permission checks or site-specific restrictions.

## Development and quality gates

The root [`README.md`](../README.md) documents development commands. Desktop work is checked with the Qt localization/accessibility/parity gates and the Rust runtime checks; extension changes use the extension's own build and tests. Local codec and torrent capabilities are validated against their native core suites in CI. Tagged releases are created only after the main CI pipeline completes successfully; published release assets are checked against their checksum manifest.

## Contact and support

NOVA is maintained independently. Use the following project-owner channels for feedback, bug reports, collaboration, or voluntary support.

| Channel | Link | Intended use |
|---|---|---|
| GitHub | [github.com/Alaa91H](https://github.com/Alaa91H) | Source code, issues, and release information. |
| Email | [alahus2591@gmail.com](mailto:alahus2591@gmail.com) | Private project contact and detailed bug reports. |
| Telegram | [t.me/Alaa91h](https://t.me/Alaa91h) | Community contact and project updates. |
| Ko-fi | [ko-fi.com/alaa91h](https://ko-fi.com/alaa91h) | Voluntary support for maintenance and development. |

When reporting a download problem, include the NOVA version, operating system, task status or error text, and a redacted diagnostic log. Do not publish credentials, signed URLs, access tokens, or private download paths in public reports.

## Related documentation

- [Product README](../README.md)
- [Engine compatibility](architecture/ENGINE_COMPATIBILITY.md)
- [Capability gating](architecture/CAPABILITY_GATING.md)
- [Browser extension overview](extension/README.md)
- [Release process](release/RELEASE.md)
- [Security policy](../SECURITY.md)
