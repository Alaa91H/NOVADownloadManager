# Android Feature Parity Matrix

## Reading this matrix

This matrix is a roadmap and audit artifact, not a marketing claim. A capability is **Verified** only when the required Android implementation and the stated tests have run. A buildable Compose shell or a native ABI proof does not prove a working download feature.

| Status | Meaning |
|---|---|
| Desktop only | Exists in the current Tauri/Axum desktop host and has no Android analogue yet. |
| Extracted foundation | A portable model/contract has been extracted or a narrow ABI proof exists; no end-user Android feature is implied. |
| Android foundation | Android UI/input/lifecycle scaffolding exists, but no core task execution is wired. |
| Planned | Architecture is documented; source has not been implemented. |
| Deferred | Intentionally excluded pending a separate design, policy, or packaging decision. |
| Verified | Implemented and tested at the stated Android evidence level. |

## Capability comparison

| Capability | Desktop implementation | Android approach | Current Android status | Required evidence before a parity claim |
|---|---|---|---|---|
| Task model | `Task`/`Segment` daemon types | Shared `nova-core-model` records | Extracted foundation | Portable serialization tests plus use in real Android task snapshots. |
| Native core handshake | N/A | UniFFI bridge API-version check | Extracted foundation; ARM64 link proof | Generated Kotlin binding call and runtime library load. |
| Compose app shell | N/A | Kotlin, Compose, Material 3, adaptive navigation | Android foundation; debug APK/JVM tests passed | Device rendering/accessibility tests. |
| Share text URL | Browser extension/native host capture | `ACTION_SEND` text/plain parser; HTTP(S)-only validation | Android foundation; JVM tests passed | Device intent test and review/create-task handoff. |
| HTTP/HTTPS direct transfer | libcurl daemon/direct engine | Extracted Rust transfer core + typed session | Planned | Real transfer to app-private staging, checksum, pause/resume/cancel, recovery. |
| Segmented/range logic | `direct.rs`, dynamic segments | Same shared Rust engine | Planned | Server fixture with range/no-range/partial cases on device. |
| Queue, priority, bandwidth profiles | Rust engine policies + AppState | Extract shared policy/core session | Planned | Core tests plus Android command/constraint integration. |
| Retry policy | Rust retry/scheduler | Shared policy; Android decides permitted execution time | Planned | Durable transitions across network/process interruption. |
| Scheduler/rules | Desktop daemon scheduler | Shared semantics + WorkManager/UIDT adapter | Planned | API-level/device policy tests, constraints, idempotency. |
| Durable recovery | Desktop persistence | Android-aware durable state and storage descriptors | Planned | Process kill/force-stop/relaunch recovery tests. |
| User-started background transfer | Desktop runtime/daemon | UIDT on API 34+ with validated fallback | Planned | Physical-device visible-progress and stop/resume tests. |
| Notifications | Tauri desktop notification/tray | Android channel, actions, task detail intent | Planned | Permission/action and duplicate-work tests. |
| App-private storage | Desktop output/data dirs | Android internal staging adapter | Planned | Resume, cleanup, integrity-failure tests. |
| SAF destination | Desktop path/file dialogs | Persisted document-tree grant adapter | Planned | Grant/revocation/provider failure tests. |
| MediaStore Downloads | Desktop filesystem destination | Pending MediaStore item then finalization | Planned | Pending/finalized/cancelled item tests. |
| Desktop browser extension pairing | Native Messaging + loopback API | Not applicable; Android share/deep-link inputs | Android-specific replacement | Intent security and user-flow tests. |
| Tauri/Axum local daemon | Tauri + Axum loopback server | No Android loopback control plane | Intentionally excluded | N/A; must remain excluded from Android bridge. |
| External yt-dlp/FFmpeg | Desktop executable discovery/subprocesses | Separate Android capability design | Deferred | Legal/policy/ABI/backend and device resource review. |
| Telegram automation | Daemon-oriented automation | Separate background integration decision | Deferred | Security, lifecycle, and policy design. |
| Secure credential storage | Desktop keyring | Android platform-backed secure store | Planned | Secret redaction and restore behavior tests. |
| Diagnostics/log export | Desktop diagnostics | Typed redacted snapshot + Android share flow | Planned | Secret/PII redaction and export-permission tests. |
| Desktop updater/window/tray | Tauri plugins | Android Activity and distribution model | Desktop only | N/A; platform-specific behavior. |

## Verified milestone boundary

The current milestone verifies all of the following, and nothing more:

1. The Android project compiles to a debug APK and passes its current JVM unit tests.
2. The Rust `Task` and `Segment` model is shared by desktop through a re-exporting dependency.
3. A versioned UniFFI bridge skeleton compiles and links as an `arm64-v8a` Android shared library against API 26.
4. The Android Compose shell is native, uses Material 3, centralizes theme/icons, holds state in a ViewModel, and accepts validated text-share URLs without creating a Kotlin download implementation.

The current milestone does **not** verify downloads, storage, notification actions, UIDT/WorkManager execution, generated bindings, runtime JNI/UniFFI loading, user-visible task controls, recovery, media, or physical-device operation.

## Parity measurement policy

Do not report a percentage of Rust reuse or Android feature parity until each item has a source ownership classification, test evidence, and a versioned milestone. At that point, report a table of verified capabilities rather than a single aggregate percentage, because direct transfer, background execution, storage, and media have materially different risk and validation requirements.
