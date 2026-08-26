# Android Testing Strategy

## Evidence levels

Android readiness is evidence-based. A passing build means sources compile; it does not establish that background execution, native loading, storage grants, notifications, or transfer recovery work on a device.

| Level | Command or environment | What it proves | What it does not prove | Current result |
|---|---|---|---|---|
| Portable Rust model | `cargo test --manifest-path crates/nova-core-model/Cargo.toml` | Shared model serialization/default compatibility. | Transfer, storage, Android ABI. | Passed before Android foundation completion. |
| UniFFI bridge | `cargo test` and Clippy in `crates/nova-mobile-ffi` | Handshake and narrow bridge source correctness. | Generated Kotlin binding or device loading. | Passed before Android foundation completion. |
| Desktop regression | `src-tauri` checks/tests | Desktop re-export remains compatible with extracted models. | Android behavior. | Passed before Android foundation completion. |
| Android JVM | `:app:testDebugUnitTest` | Pure Kotlin URL validation and ViewModel state. | Android framework, Compose rendering, native loading. | Passed. |
| Android APK | `:app:assembleDebug` | Android sources, resources, manifest, and dependencies package. | Installation or runtime behavior. | Passed. |
| ARM64 native link | `scripts/build-android-ffi.sh arm64-v8a` | UniFFI `cdylib` links against Android API 26 ABI. | APK native load or real UniFFI invocation. | Passed. |
| Instrumented/emulator | Gradle managed device or emulator | Framework integration on specified image. | Physical-device vendor behavior. | Not run. |
| Physical device | Supported API/ABI device matrix | Lifecycle, UIDT, SAF, MediaStore, notifications, network, and process-loss behavior. | Broad ecosystem compatibility beyond matrix. | Not run. |

## Commands

Set local paths first:

```bash
export ANDROID_HOME="$HOME/.local/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$HOME/.cargo/bin:$PATH"
```

Run the currently validated foundation checks:

```bash
cd android
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest
cd ..
scripts/build-android-ffi.sh arm64-v8a
```

Before a release candidate, add and execute:

```bash
cd android
./gradlew --no-daemon :app:lintDebug :app:connectedDebugAndroidTest
./gradlew --no-daemon :app:assembleRelease
```

`connectedDebugAndroidTest` requires an available emulator or physical device. It must not be reported as passed until such a target is configured and the command succeeds.

## Current unit coverage

| Test target | Behaviors currently covered |
|---|---|
| `SharedUrlValidatorTest` | Extract first valid HTTP(S) URL; reject non-web and malformed values. |
| `DownloadsViewModelTest` | Surface a validated shared URL for review; clear it without creating a fictitious task. |
| `nova-core-model` tests | Preserve Task/Segment serialization/default semantics. |
| `nova-mobile-ffi` tests | Accept matching bridge version and reject incompatible version. |

## Required test additions by implementation gate

| Gate | Test additions required before enabling user-facing behavior |
|---|---|
| Generated UniFFI binding | Kotlin handshake success/incompatibility test, ABI package test, redacted error mapping test. |
| One direct task | URL/header validation, task transition table, pause/resume/cancel, retry eligibility, checksums, partial recovery. |
| Android execution | UIDT path API 34+, fallback path below API 34, notification actions, backgrounding, OS stop, process loss. |
| Storage | App-private staging; SAF persisted grant/revocation; MediaStore pending/finalization; capacity and filename conflicts. |
| Diagnostics | Snapshot size limits, PII/secret redaction, log export permission handling. |
| Release matrix | ARM64 physical device plus at least one other supported ABI/API; fresh install and upgrade from previous app version. |

## Test-data safety

Tests must use a controlled local HTTP fixture or a dedicated public fixture under project control. They must never commit real authorization headers, cookies, signed URLs, user filesystem paths, document-tree URIs, or downloaded user content. Fixture downloads should have a known byte sequence and checksum so transfer and resume tests have deterministic assertions.
