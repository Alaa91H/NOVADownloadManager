# NOVA Android Documentation

NOVA Android is being implemented as a native Kotlin/Jetpack Compose client that incrementally reuses portable Rust contracts and transfer semantics. The desktop Tauri/Axum daemon is not embedded in Android, and Kotlin must not become a second download engine.

| Document | Purpose | Current conclusion |
|---|---|---|
| [Architecture audit](architecture.md) | Repository evidence, target boundaries, platform decisions, and implementation gates. | Foundation complete; transfer/runtime/device validation pending. |
| [Build guide](build.md) | Reproducible Gradle, SDK, NDK, JDK, APK, and native ABI commands. | Debug APK/JVM test and ARM64 link proof passed locally. |
| [Rust bridge contract](rust-bridge.md) | Typed UniFFI version boundary and expansion rules. | Handshake exists; generated Kotlin binding and task commands do not. |
| [Background execution](background-downloads.md) | UIDT/WorkManager/notification policy and recovery gates. | Documented; inert service only. |
| [Storage design](storage.md) | App-private staging, SAF, MediaStore, capability and privacy rules. | Documented; no destination adapter implemented. |
| [Media policy](media.md) | Scope and capability gates for yt-dlp/FFmpeg-like behavior. | Explicitly deferred. |
| [Testing strategy](testing.md) | Evidence levels and release test matrix. | JVM/APK/ARM64-link checks passed; no device test. |
| [Feature parity matrix](feature-parity.md) | Desktop-to-Android capability status with evidence rules. | No parity percentage or production download claim. |

## Milestone boundary

The current code supplies a buildable native Android UI foundation, validated HTTP(S) text-share ingestion, centralized Material 3 design primitives, a StateFlow ViewModel/repository boundary, shared Rust `Task`/`Segment` models, a versioned UniFFI handshake, and a reproducible ARM64 library build script. It deliberately does not yet transfer bytes, expose a generated Rust binding in the APK, use UIDT/WorkManager for work, write to SAF/MediaStore, or claim physical-device compatibility.
