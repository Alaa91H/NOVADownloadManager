# Engine Capability Gating

NOVA must not expose or submit an engine option unless the active Rust runtime reports that it is supported.

## Qt desktop

The C++ API layer in `desktop-native/src/api/NovaApiClient.*` owns the frontend capability snapshot exposed to QML. Native workflows query helpers such as direct/media option support before enabling controls or constructing payloads.

Primary UI surfaces include:

- `AddDownloadDialog.qml`
- `BatchImportPage.qml`
- `MediaDownloaderPage.qml`
- `SettingsPage.qml`

The daemon remains the final validator. UI gating improves correctness and UX but never replaces server-side validation.

## Browser extension

The extension consumes daemon capability contracts before sending direct or media candidates. Direct protocols must appear in the runtime `directProtocols` set. HLS/DASH and other adaptive media candidates are routed through supported media workflows rather than treated as ordinary file downloads.

## Rule

Unknown, unavailable or rejected capabilities are disabled or removed from outbound payloads. NOVA does not advertise a capability merely because a control exists in QML or the extension.
