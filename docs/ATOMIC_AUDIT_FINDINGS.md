# Atomic Audit Results and Proofs of Fix

**Project:** NOVA Download Manager
**Work branch:** `fix/verified-transfer-progress`
**Audit date:** 17 August 2026
**Scope of verification:** UI source, Rust core, browser extension, credential chains, Linux packages, and download/analysis/progress paths.

## Proof methodology

An item is not recorded as a defect unless demonstrated by one of: a reproducible failing test, a failed standard automated check, an explicit build log, or a deterministic text scan. A fix is not considered complete until the same gate is re-run or a regression test covering the path is executed.

| Identifier | Proven defect | Proof / evidence | Mitigation | Verification criterion |
|---|---|---|---|---|
| `TR-001` | The libcurl multi-socket transfer loop does not complete a local HTTP server request and can hang the transfer test. | A single transfer test timed out, and system activity showed a connection established with no request progress. | Consolidate transfer execution onto the supported libcurl multi engine and remove the unreliable socket path and its remnants. | All Rust tests pass, including direct download, progress, stop/resume, and intermediate links. |
| `I18N-001` | The browser extension Bengali, Persian, and Thai files contain thousands of replacement characters `U+FFFD`, making the UI unreadable. | A Unicode scan identified 1,435 replacements in `bn.ts`, 2,004 in `fa.ts`, and 2,668 in `th.ts`. | Regenerate translations from the English reference file with strict key and placeholder verification (e.g., `{count}`) and ensure outputs contain no replacement character. | No `U+FFFD` exists in any app or extension source, and extension type checks pass. |
| `I18N-002` | Visible text positions and comments in the UI contain an unintended replacement character. | A Unicode scan identified affected strings on the media page, a yt-dlp alert, and other UI locations. | Replace the character with an appropriate semantic marker (em dash or separator dot) and clean comments. | A source scan returns no results for `U+FFFD`. |
| `FMT-001` | Four UI files violated the project's Prettier formatting. | `pnpm run ci:format` failed and named the files explicitly. | Apply Prettier to the specified files only. | `pnpm run ci:format` succeeds with no warnings. |
| `PKG-001` | The initial Linux build failed linking due to missing system development libraries. | The linker log showed missing `idn2`, `rtmp`, `ssh`, Kerberos, LDAP, and systemd. | Install the corresponding development packages in the build environment. | DEB and RPM builds succeed and their metadata verify. |
| `PKG-002` | AppImage packaging failed post-build because `patchelf` was missing in linuxdeploy's GStreamer plugin. | Detailed log: `Error: patchelf not found` then exit code 2 from the GStreamer plugin. | Install `patchelf` and re-run AppImage packaging. | AppImage is produced and runtime/archive info commands run successfully. |

## Items inspected and not proven to be direct source defects

| Item | Result | Decision |
|---|---|---|
| Production JavaScript dependencies | No high or critical vulnerabilities in the locked package audit. | No action required. |
| RustSec audit | No advisories classified as vulnerabilities in the audit report; 17 allowed advisories exist, mostly in the GTK3/Wry transient chain, with an unsafe `glib` warning. | Local patching is not appropriate because the locked Tauri chain is already compatible with the latest releases within its constraints; follow Tauri/Wry upgrades when a compatible path is available. |
| UI tests | 29 test suites and 458 tests passed. | No action required. |
| Rust tests | 647 tests passed. | No action required. |
| Clippy | Passed with `-D warnings`. | No action required. |

## Functional acceptance criteria

The following items will be re-executed in the final verification cycle after audit fixes are merged:

| Path | Required success evidence |
|---|---|
| Download of a direct link with known size | A complete file matching the test content, and an intermediate progress marker before 100%. |
| Download of a streamed unknown-size resource | Correct content and progress reported as indeterminate (truthful) rather than a misleading fixed zero value. |
| HTML intermediate link, redirect, or broken mirror | The parser reaches the real file or transitions to a healthy mirror. |
| Progress UI page | Live transition from indeterminate to a real percentage without a visual jump or premature completion announcement. |
| Installer package | DEB, RPM, and AppImage exist, are inspectable, and have consistent version metadata. |

## Operational note

Linux installer files were created and verified in a Linux x86_64 environment. This does not substitute for testing GUI window interactions on a real desktop session or for Windows/macOS packages; those remain platform-specific gates to be executed in their native environments before a multi-platform release.
