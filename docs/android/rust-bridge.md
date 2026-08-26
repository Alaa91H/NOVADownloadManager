# Rust Bridge Contract

## Purpose

NOVA Android must reuse Rust domain and transfer semantics without exposing the desktop daemon or implementing a second engine in Kotlin. The bridge is therefore a deliberately small, typed boundary:

```text
Compose → ViewModel → repository → generated UniFFI binding → Rust mobile facade → extracted Rust core
```

The Android UI must not invoke `AppState`, Axum routes, Tauri commands, a loopback HTTP API, raw desktop paths, or desktop external-tool discovery. Those remain desktop-host responsibilities.

## Current implementation

Two crates are present today.

| Crate | Current ownership | Current proof | Explicitly not included |
|---|---|---|---|
| `crates/nova-core-model` | Serializable `Task` and `Segment` records shared with the desktop daemon. | Unit-tested portable model crate and desktop re-export compile path. | Queue policy, transfer session, persistence, filesystem behavior. |
| `crates/nova-mobile-ffi` | UniFFI ABI scaffolding, `BridgeInfo`, `BridgeError::IncompatibleVersion`, `BRIDGE_API_VERSION = 1`, and `initialize(clientBridgeApiVersion)`. | Rust tests, Clippy, and an ARM64 Android `cdylib` proof using NDK r28c. | Download creation/control, events, storage, Android context, `AppState`, Axum, or any Kotlin transfer code. |

The current Android repository implementation reports `BridgeNotPackaged`. That is intentional and truthful: no generated Kotlin UniFFI binding is incorporated into the APK yet, so the UI cannot claim that it drives downloads.

> **Do not bypass this boundary.** Passing JSON blobs through an ad-hoc JNI call, exposing a generic desktop route endpoint, or reimplementing retries/segments/file transfer in Kotlin would defeat the architecture and make the two clients diverge.

## Version compatibility

The bridge uses a simple compatibility handshake before any operational command is introduced:

```text
initialize(clientBridgeApiVersion) -> BridgeInfo | IncompatibleVersion
```

The Android side must reject an incompatible native library before it presents task controls. The protocol version is independent of the app version. A bridge schema change that changes a request, result, record, enum, error, or event is a compatibility decision and must include tests.

| Contract rule | Required behavior |
|---|---|
| Version check | Invoke once before task controls become available; report a redacted diagnostic on failure. |
| Typed records and errors | Use UniFFI records/enums/errors, not JSON strings or panic text. |
| Durable identifiers | Use opaque task IDs; do not derive identity from file paths or titles. |
| Bounded events | Coalesce progress and paginate histories; never marshal full task state for each received byte. |
| Ownership | Rust owns download semantics; Android owns intent validation, jobs/services, storage descriptors, permissions, and notifications. |
| Diagnostics | Redact request headers, cookies, authorization material, persisted grants, absolute private paths, and user identifiers. |

UniFFI is appropriate for exposing typed Rust records, errors, objects, and asynchronous APIs to Kotlin, but the generated bindings should be committed or generated reproducibly only after the command contract stabilizes.[1]

## Planned command surface

The following is a target contract, not a claim that the methods exist today.

| Command family | Illustrative typed operations | Ownership boundary |
|---|---|---|
| Session | `initialize`, `getCapabilities`, `getDiagnostics` | Rust describes capabilities; Android decides whether OS policy allows execution. |
| Tasks | `createTask`, `listTasks`, `getTask`, `start`, `pause`, `resume`, `cancel`, `retry` | Rust validates state transitions and transfer policy. |
| Queue and settings | `setPriority`, `setBandwidthPolicy`, `getSettings`, `updateSettings` | Rust owns shared policy schema; Android maps user preferences and constraints. |
| Events | `observeEvents(sinceEventId)` | Rust emits bounded snapshots/events; Android converts them to `Flow` and UI state. |
| Storage handoff | `prepareDestination`, `finalizeDestination` | Android grants an opaque descriptor/writer; core never assumes arbitrary POSIX output paths. |

## Native ABI proof and local packaging

`./scripts/build-android-ffi.sh arm64-v8a` compiles `nova-mobile-ffi` for `aarch64-linux-android` and uses the NDK API-26 Clang driver. It writes a local generated library to `android/app/src/main/jniLibs/arm64-v8a/`. The output is ignored because it is build output, not a source artifact.

This command proved that the current narrow bridge links for ARM64. It did **not** prove that Android can load it at runtime, that UniFFI Kotlin bindings are generated, or that a download can survive process death. Those require the next bridge and device-validation gates.

## Expansion gates

1. Extract portable queue/status/retry contracts while preserving desktop tests and behavior.
2. Add generated Kotlin UniFFI bindings in a reproducible Gradle task, then package matching ABI libraries.
3. Replace `UnpackagedRustDownloadsRepository` with a binding-backed repository that performs the version handshake.
4. Implement one app-private direct-transfer task using the extracted core; add pause/resume/cancel and durable checkpoints.
5. Add Android execution, notification, and storage adapters only after the core command semantics exist.
6. Add ABI matrix CI and physical-device tests before presenting Android support as usable.

## References

[1] [UniFFI User Guide — Interfaces and supported bindings](https://mozilla.github.io/uniffi-rs/latest/udl/interfaces.html)
