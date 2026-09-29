# Android Storage Design

## Security model

NOVA Android treats a destination as an **explicit capability**, not a desktop-style arbitrary path. Rust receives a typed opaque destination descriptor and only writes through an Android-provided adapter. The core must not construct `/storage/...` paths, infer a user-visible folder from a filename, or retain unrestricted access after a grant is revoked.

This design preserves Rust ownership of transfer and integrity semantics while keeping Android permission checks, URI grants, document creation, media finalization, and recovery at the platform boundary.

## Destination matrix

| User destination | Android adapter | Core-facing descriptor | Permission scope | Recovery behavior | Milestone status |
|---|---|---|---|---|---|
| Temporary/staging data | App-specific internal storage | Private staging session ID | App-private only | Restore checkpoint on next app session when staging survives. | Required first real-transfer destination. |
| User-selected folder | Storage Access Framework document tree | Persisted tree URI + document handle capability | Exact user-selected tree | Retain the native-complete file; retry after failure adopts the current selection and clears any old pending document. | Implemented; GitHub and provider/device checks pending. |
| Standard Downloads/media | MediaStore | Content URI + file-descriptor/writer capability | NOVA-owned MediaStore item | Write as pending, verify copied bytes with SHA-256, then publish; remove pending items on cancellation. | Implemented on Android 10+; GitHub and device checks pending. |
| Removable/external provider | SAF | Provider-backed opaque handle | Provider's explicit grant | Treat provider/network loss as a recoverable task error; never fall back to an arbitrary path. | Covered by the SAF path; provider-specific checks pending. |

The Storage Access Framework lets a user choose a document or directory and supports persistable URI access where the provider allows it.[1] On Android 10 and later, an app can contribute files it owns to `MediaStore.Downloads` without broad storage permissions; other apps' downloads are not automatically readable and must be accessed through a user-mediated mechanism such as SAF.[2]

## Proposed core contract

The current Rust core writes only to app-private staging. Android freezes the selected destination per task and owns final publication through a persisted, task-scoped URI grant:

```text
enqueue(url) -> private staging task
complete(staging) -> verified private file
publish(task_id, file, destination capability) -> content URI
```

Publication retains the private complete file until Android has committed the external item. A process restart can repeat a pending publication; completed URIs are journalled for the task and exposed to the UI's Open action. A revoked SAF grant leaves the transfer retryable. Retrying a failed task uses the current destination setting; resuming a paused task preserves its destination unless its grant was revoked.

A future direct Rust API should continue to operate on semantic capabilities rather than raw strings:

```text
DestinationDescriptor {
  kind: AppPrivateStaging | SafTree | MediaStoreDownload,
  stable_id: opaque identifier,
  display_name: validated suggested name,
  resume_capability: optional opaque token
}

open_for_write(destination) -> WriterHandle | DestinationError
commit(writer, integrity_result) -> FinalizedDestination | DestinationError
abort(writer, reason) -> Unit
```

The first production implementation may use app-private staging only. It should not pretend to support SAF or MediaStore until their permission and recovery tests exist.

## Filename and MIME handling

Remote filenames, `Content-Disposition`, MIME types, archive names, extension hints, and media metadata are all untrusted input. The Android adapter must sanitize only presentation names and preserve a safe generated identity separately. It must reject path separators, control characters, reserved or misleading names, and normalization collisions. MIME metadata informs user experience but must not be trusted as authorization to open or execute content.

| Input | Safe handling |
|---|---|
| Remote filename | Normalize as a display suggestion; generate a stable internal task ID separately. |
| Existing target conflict | Task IDs are part of generated target names, avoiding replacement of another task's output. |
| SAF provider error | Retain durable task state and surface a recoverable destination error. |
| Partial data | Keep private staging until checksum/finalization succeeds; do not present as complete. |
| Cancellation | Close descriptors and follow the selected cleanup policy; never delete outside the capability. |

## Privacy and diagnostics

Logs and diagnostics must redact persisted URI grants, absolute app-private paths, filenames where they identify a user, authorization headers, cookies, and any content metadata unnecessary for debugging. Exported diagnostics should contain task IDs, state transitions, redacted error categories, app/bridge versions, and feature capabilities only.

## Tests required before enabling destinations

| Destination | Minimum test cases |
|---|---|
| App-private staging | Resume after process kill; collision handling; checksum failure; cancellation cleanup. |
| SAF tree | Persist grant; revoke and replace grant on retry; provider unavailable; partial file; publication recovery. |
| MediaStore | Pending visibility; SHA-256 verification; successful finalization; cancellation cleanup; device storage pressure. |
| External provider | Disconnection; capacity error; inaccessible provider; no path fallback. |

## References

[1] [Android Developers — Storage Access Framework](https://developer.android.com/guide/topics/providers/document-provider)

[2] [Android Developers — Access media files from shared storage](https://developer.android.com/training/data-storage/shared/media)
