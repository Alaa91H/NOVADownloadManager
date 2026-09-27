# Android Build Guide

## Status and scope

This document describes the **buildable Android foundation** introduced after the initial architecture audit. It has been validated in a Linux development environment with a debug APK build and JVM unit tests. It does **not** claim emulator, physical-device, Google Play, real-transfer, SAF, or notification-action validation.

The app uses AGP `9.3.0`, Gradle `9.5.0`, `compileSdk`/`targetSdk` 37, `minSdk` 26, and NDK `28.2.13676358`. This combination matches the Android compatibility table for AGP 9.3, which specifies Gradle 9.5.0, Build Tools 36.0.0, JDK 17, and NDK 28.2.13676358.[1]

| Component | Required value | Repository location | Purpose |
|---|---:|---|---|
| Gradle | 9.5.0 | `android/gradlew` | Reproducible Android builds; distribution SHA-256 is pinned in Wrapper properties. |
| Android Gradle Plugin | 9.3.0 | `android/gradle/libs.versions.toml` | Android build and packaging. |
| JDK | 17 or newer JDK with `javac` | Local environment only | Kotlin/Java compilation. A runtime-only Java installation is insufficient. |
| Android SDK | platform `android-37.0`, Build Tools 36.0.0 | Local environment only | Android compilation. |
| Android NDK | 28.2.13676358 | Local environment only | Rust ARM ABI linking. |
| Rust | Stable with Android target | Local environment only | Compiles the `nova-mobile-ffi` `cdylib`. |

> **AGP 9 migration note:** Android Gradle Plugin 9 enables built-in Kotlin. The project intentionally does not apply `org.jetbrains.kotlin.android`; it retains only the Compose compiler plugin, as required by the current Compose setup guidance.[2] [3]

## Prerequisites

Set local SDK paths without committing them. `android/local.properties` is ignored by Git; environment variables work equally well in CI.

```bash
export ANDROID_HOME="$HOME/.local/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$HOME/.cargo/bin:$PATH"
```

The project requires these SDK packages:

```text
platform-tools
platforms;android-37.0
build-tools;36.0.0
ndk;28.2.13676358
cmake;3.22.1
```

## Build and test the Android foundation

Run all commands from the repository root:

```bash
cd android
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest
```

The validated command produces the debug APK below. This artifact only represents the Kotlin/Compose foundation; it does not include a tracked Rust library or a working download engine.

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Use the following additional quality commands once the relevant tests and lint rules are expanded:

```bash
cd android
./gradlew --no-daemon :app:lintDebug
./gradlew --no-daemon :app:assembleRelease
```

## Build the native ARM64 bridge proof

The FFI library is compiled through a repository script rather than a system-specific manual command. It targets API 26, matching the Android app's minimum SDK.

```bash
scripts/build-android-ffi.sh arm64-v8a
```

The script writes a local generated output to:

```text
android/app/src/main/jniLibs/arm64-v8a/libnova_mobile_ffi.so
```

This output, Rust target directory, and any crate-local lockfile created by an isolated Cargo invocation are ignored. They must not be committed. The script is a **proof and packaging preparation step**, not yet an app build dependency: generated Kotlin UniFFI bindings and a production repository implementation are deliberately pending a stable task-command contract.

## Reproducibility and troubleshooting

| Symptom | Cause | Corrective action |
|---|---|---|
| `javaCompiler` lacks `JAVA_COMPILER` | A JRE/runtime was selected instead of a JDK. | Set `JAVA_HOME` to a JDK 17+ home containing `bin/javac`. |
| Kotlin Android plugin error on AGP 9 | `org.jetbrains.kotlin.android` conflicts with built-in Kotlin. | Remove that plugin from module, root build file, and version catalog; retain Compose compiler plugin. |
| SDK not found | SDK path was not exported or local properties are absent. | Export `ANDROID_HOME` and `ANDROID_SDK_ROOT`, or add ignored `android/local.properties`. |
| NDK linker missing | NDK version/path does not match the script. | Install NDK 28.2.13676358 or set `ANDROID_NDK_HOME` explicitly. |
| Native library missing from APK | The current native script has not been integrated as an app build dependency yet. | Build it locally for ABI proof only; complete generated-binding and Gradle task integration in the next bridge milestone. |

## Verified evidence

| Check | Result | Boundary of the evidence |
|---|---|---|
| `:app:assembleDebug` | Passed | Debug APK built in Linux sandbox. |
| `:app:testDebugUnitTest` | Passed | JVM unit tests for pure URL validation and ViewModel state. |
| `nova-mobile-ffi` ARM64 release build | Passed | ELF shared library built with NDK r28c linker; no device load test. |
| APK installation or instrumentation testing | Not run | No emulator or physical Android device was used. |

## References

[1] [Android Developers — Android Gradle Plugin 9.3 compatibility](https://developer.android.com/build/releases/agp-9-3-0-release-notes)

[2] [Android Developers — Migrate to built-in Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin)

[3] [Android Developers — Set up the Compose Compiler Gradle plugin](https://developer.android.com/develop/ui/compose/setup-compose-dependencies-and-compiler)
