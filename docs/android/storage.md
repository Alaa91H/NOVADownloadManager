# Android Storage Design

## Security model

NOVA Android treats a destination as an **explicit capability**, not a desktop-style arbitrary path. Rust receives a typed opaque destination descriptor and only writes through an Android-provided adapter. The core must not construct `/storage/...` paths, infer a user-visible folder from a filename, or retain unrestricted access after a grant is revoked.

This design preserves Rust ownership of transfer and integrity semantics while keeping Android permission checks, URI grants, document creation, media finalization, and recovery at the platform boundary.

## Destination matrix

| User destination | Android adapter | Core-facing descriptor | Permission scope | Recovery behavior | Milestone status |
|---|---|---|---|---|---|
| Temporary/staging data | App-specific internal storage | Private staging session ID | App-private only | Restore checkpoint on next app session when staging survives. | Required first real-transfer destination. |
| User-selected folder | Storage Access Framework document tree | Persisted tree URI + document handle capability | Exact user-selected tree | Report recoverable `DestinationPermissionRevoked`; request reselection. | Deferred. |
| Standard Downloads/media | MediaStore | Content URI + file-descriptor/writer capability | NOVA-owned MediaStore item | Leave item pending until validated finalization; clean up safely on cancellation. | Deferred. |
| Removable/external provider | SAF | Provider-backed opaque handle | Provider's explicit grant | Treat provider/network loss as an error; never fall back to an arbitrary path. | Deferred. |

The Storage Access Framework lets a user choose a document or directory and supports persistable URI access where the provider allows it.[1] On Android 10 and later, an app can contribute files it owns to `MediaStore.Downloads` without broad storage permissions; other apps' downloads are not automatically readable and must be accessed through a user-mediated mechanism such as SAF.[2]

## Proposed core contract

A future Rust API must operate on semantic capabilities rather than raw strings:

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
| Existing target conflict | Require an explicit typed policy: replace, rename, skip, or resume after identity validation. |
| SAF provider error | Retain durable task state and surface a recoverable destination error. |
| Partial data | Keep private staging until checksum/finalization succeeds; do not present as complete. |
| Cancellation | Close descriptors and follow the selected cleanup policy; never delete outside the capability. |

## Privacy and diagnostics

Logs and diagnostics must redact persisted URI grants, absolute app-private paths, filenames where they identify a user, authorization headers, cookies, and any content metadata unnecessary for debugging. Exported diagnostics should contain task IDs, state transitions, redacted error categories, app/bridge versions, and feature capabilities only.

## Tests required before enabling destinations

| Destination | Minimum test cases |
|---|---|
| App-private staging | Resume after process kill; collision handling; checksum failure; cancellation cleanup. |
| SAF tree | Persist grant; revoke grant; provider unavailable; partial file; rename/conflict policy. |
| MediaStore | Pending visibility; successful finalization; cancellation cleanup; device storage pressure. |
| External provider | Disconnection; capacity error; inaccessible provider; no path fallback. |

## References

[1] [Android Developers — Storage Access Framework](https://developer.android.com/guide/topics/providers/document-provider)

[2] [Android Developers — Access media files from shared storage](https://developer.android.com/training/data-storage/shared/media)
