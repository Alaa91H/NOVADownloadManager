# Rust Bridge Contract

## Purpose

NOVA Android must reuse Rust domain and transfer semantics without exposing the desktop daemon or implementing a second engine in Kotlin. The bridge is therefore a deliberately small, typed boundary:

```text
Compose → ViewModel → repository → versioned mobile bridge → Rust mobile facade → shared Rust download core
```

The Android UI must not invoke `AppState`, Axum routes, Tauri commands, a loopback HTTP API, raw desktop paths, or desktop external-tool discovery. Those remain desktop-host responsibilities.

## Current implementation

Four Rust crates now define the shared/mobile boundary.

| Crate | Current ownership | Current proof | Explicitly not included |
|---|---|---|---|
| `crates/nova-core-model` | Serializable task/segment records and shared resume/range policy. | Portable unit tests plus desktop/mobile consumers. | Tauri, Android lifecycle, filesystem capabilities. |
| `crates/nova-download-core` | Shared HTTP transport, validated range streaming, file resume/fallback, and host-bounded range geometry. | Native transport fixtures plus desktop SegmentPlanner consumption. | Tauri, Axum, Android APIs, UI state. |
| `crates/nova-mobile-core` | Mobile-safe app-private transfer facade and relative-destination validation. | Unit tests reject absolute/parent traversal and accept bounded staging destinations. | Android `Context`, notifications, UIDT/WorkManager, public-storage APIs. |
| `crates/nova-mobile-ffi` | Versioned bridge plus narrow Android JNI bootstrap/transfer primitives over the mobile facade. | ARM64 packaging path and Android CI. | Download policy duplication, Kotlin HTTP transport, desktop daemon exposure. |

Android now fails closed when the native library is missing/incompatible and direct HTTP(S) bytes are routed through Rust into app-private staging. The current JNI string primitives are transitional and intentionally narrow: they prove the first native transfer without exposing generic routes or JSON contracts. The planned stable command surface remains generated typed UniFFI bindings once task/session schemas settle.

> **Do not bypass this boundary.** Exposing generic desktop routes, persisting arbitrary JSON command blobs, or reimplementing retries/segments/file transfer in Kotlin would defeat the architecture and make the two clients diverge.

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

The build path now packages the ARM64 bridge into the debug APK, and Android's native transfer host calls the versioned library before accepting work. Generated UniFFI Kotlin bindings, physical-device runtime evidence, durable process-death resume, and ABI-matrix release validation are still separate gates.

## Expansion gates

1. Continue extracting queue/status/retry contracts while preserving desktop tests and behavior.
2. Stabilize the mobile task/session schema, then generate Kotlin UniFFI bindings reproducibly and retire the temporary high-level JNI primitives.
3. Add typed pause/resume/cancel/retry commands and durable task checkpoints, including secure recovery of transfer intent after process death.
4. Move execution ownership to Android-compliant UIDT/WorkManager paths with notification actions.
5. Add SAF/MediaStore descriptor adapters without exposing arbitrary filesystem paths to Rust.
6. Add ABI matrix CI and physical-device tests before presenting Android support as fully usable.

## References

[1] [UniFFI User Guide — Interfaces and supported bindings](https://mozilla.github.io/uniffi-rs/latest/udl/interfaces.html)
