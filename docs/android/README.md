# NOVA Android Documentation

NOVA Android is being implemented as a native Kotlin/Jetpack Compose client that incrementally reuses portable Rust contracts and transfer semantics. The desktop Tauri/Axum daemon is not embedded in Android, and Kotlin must not become a second download engine.

| Document | Purpose | Current conclusion |
|---|---|---|
| [Architecture audit](architecture.md) | Repository evidence, target boundaries, platform decisions, and implementation gates. | Shared native transfer path implemented; background/device validation still pending. |
| [Build guide](build.md) | Reproducible Gradle, SDK, NDK, JDK, APK, and native ABI commands. | Debug APK/JVM test and ARM64 link proof passed locally. |
| [Rust bridge contract](rust-bridge.md) | Typed bridge version boundary and expansion rules. | Handshake plus narrow native transfer/control primitives exist; generated high-level UniFFI task bindings remain pending. |
| [Background execution](background-downloads.md) | UIDT/WorkManager/notification policy and recovery gates. | Native in-process session exists; JobService remains reconciliation-only pending UIDT/WorkManager ownership. |
| [Storage design](storage.md) | App-private staging, SAF, MediaStore, capability and privacy rules. | App-private staging/finalization implemented; SAF/MediaStore adapters pending. |
| [Media policy](media.md) | Scope and capability gates for yt-dlp/FFmpeg-like behavior. | Explicitly deferred. |
| [Testing strategy](testing.md) | Evidence levels and release test matrix. | JVM/APK/ARM64-link checks passed; no device test. |
| [Feature parity matrix](feature-parity.md) | Desktop-to-Android capability status with evidence rules. | No parity percentage or production download claim. |

## Milestone boundary

The current code supplies a buildable native Android UI foundation, validated HTTP(S) ingestion, a StateFlow repository boundary, shared Rust models/range planning, a versioned native bridge, and a first real app-private transfer path through `nova-mobile-core -> nova-download-core -> libcurl`. Pause/cancel are enforced inside Rust, resume intent is encrypted with Android Keystore, and partial staging bytes are reused through validated HTTP range semantics. Android-compliant UIDT/WorkManager ownership, notification actions, SAF/MediaStore output, generated high-level UniFFI task bindings, and physical-device compatibility evidence remain pending.
