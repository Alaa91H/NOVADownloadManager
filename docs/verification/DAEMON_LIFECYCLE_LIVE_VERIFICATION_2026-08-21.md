# Daemon Lifecycle Live Verification — 2026-08-21

## Scope

This record documents a live, isolated verification pass for the NOVA daemon lifecycle after the port-file recovery and graceful-restart corrections. The checks used the compiled local NOVA binary in integration mode, a temporary home/data directory, real loopback HTTP requests, and the real native-messaging executable path. No fake daemon was used for the assertions.

The tests intentionally avoided printing any bearer token. Pairing success was verified from the framed response structure and token length only.

## Verified defects and corrections

| Area | Verified defect | Correction |
|---|---|---|
| Native-host discovery | The daemon writes `port` and `PID` on separate lines, while the native host previously attempted to parse the entire file as one port number. A daemon moved away from the preferred port could therefore be missed. | The native host now parses the first line as the port and has regression coverage for both current two-line and legacy single-line formats. |
| Desktop restart recovery | The restart/orphan cleanup path used a legacy environment-derived directory instead of Tauri's active `app_data_dir`. It could miss the current port file and fall back to a narrow port scan. | Restart and startup cleanup now receive the active Tauri data directory, use it first, and consult the legacy integration directory only as a compatibility fallback. |
| Graceful restart | Restart used a fixed short sleep before escalating to process termination, which could interrupt state persistence on a slow shutdown. | Restart now waits, with a bounded three-second timeout, for the daemon to remove its port file after graceful shutdown. Forced termination remains an escalation path only when the marker persists. |

## Live acceptance scenarios

| Scenario | Procedure | Result |
|---|---|---|
| Dynamic port selection | Bound the preferred loopback port `3199` in an isolated process, then launched the real NOVA daemon in integration mode with `NOVA_DAEMON_PORT=3199`. | Passed. The daemon selected a different unprivileged loopback port (`3200` in the run), wrote it to its port file, and exposed a successful `/v1/ping` response. |
| Current port-file format | Read the real port file written by the daemon during the dynamic-port run. | Passed. The first line held the selected port and the second line matched the running integration-process PID. |
| Native-messaging pairing on a moved port | Started the real executable with `--native-host`, sent a length-prefixed `auth.pair` request, and validated the length-prefixed reply. | Passed. The host located the dynamically selected daemon through the port file and returned `native-messaging-verified`, protocol version `4`, and a non-disclosed 32-character pairing token. |
| Graceful shutdown marker removal | Started an isolated daemon with the preferred port held, confirmed `/v1/ping`, sent `SIGINT`, and waited for the daemon port file to disappear. | Passed. The daemon chose a dynamic port (`3201` in the run), removed its port file, and no longer accepted HTTP connections before the test cleanup ended. |

## Regression and quality evidence

| Gate | Result |
|---|---|
| Rust unit tests | 725 passed; 1 documentation test ignored; 0 failed. |
| Rust formatting | Passed. |
| Clippy with `-D warnings` | Passed. |
| Repository final audit | Passed with 0 source-audit warnings; capability, installer lifecycle, branding, extension parity, and release-submission checks passed. |
| CI for the graceful-shutdown correction | Passed on Windows x64/ARM64, Linux x64/ARM64, and macOS x64/ARM64. |
| Published release integrity | `v2.4.15-alpha` is a prerelease with 20 assets. Its 19 non-manifest assets matched all 19 `SHA256SUMS.txt` entries. |

## Boundaries

This verification proves the tested Linux integration-mode lifecycle and real loopback/native-messaging contract. It does not replace a visual desktop-GUI restart acceptance test on every operating system, nor does it prove behavior under host-level forced termination, disk-full persistence failures, or third-party endpoint interference. The production release remains guarded by the normal multi-platform CI and checksum verification process.
