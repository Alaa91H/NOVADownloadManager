# NOVA Browser Extension Desktop Developer Handoff

This checklist is for the NOVA Browser Extension desktop application team. The Browser Extension side is implemented in this repository; the native desktop lifecycle must be implemented in NOVA Browser Extension itself.

## Required Desktop Services

- Native Messaging host: `com.nova.browserextension`.
- Loopback bridge: `http://127.0.0.1:3199`.
- Protocol version: `4`, with `minimumSupportedProtocolVersion` not greater than the extension-supported version.
- Zero-click pairing endpoint: `POST /v1/pair/auto`.
- Protected bearer-token endpoints: `/v1/auth/check`, `/v1/add`, `/captures`, `/v1/extract-page`, refresh-address endpoints, settings, and task control endpoints.
- Events through SSE first, WebSocket optionally.

## Required Native Lifecycle

- Enforce a single-instance process lock before starting UI, engine, Native Messaging, loopback, tray, or scheduler.
- When a second instance starts, forward the activation intent to the running instance and exit.
- The active instance must own the loopback port, Native Messaging host, tray icon, download engine, and settings store.
- Real shutdown must close Native Messaging, HTTP, SSE, WebSocket, engine workers, and release the lock.

## Minimize To System Tray

- Feature label: `Minimize to system tray when closing`.
- Internal setting: `minimizeToSystemTrayOnClose`.
- Default: ON for first install and new profiles.
- Close button behavior when enabled: hide main window, keep NOVA Browser Extension running, keep the bridge healthy, keep tray icon available.
- Close button behavior when disabled: quit after safe confirmation if active downloads exist.
- Tray menu must include Show/Hide, Pause all, Resume all, Browser Extension help, and Quit.

## Browser Extension Pairing

Expected user experience:

- Browser opens.
- Extension detects NOVA Browser Extension through Native Messaging and loopback.
- Extension pairs automatically through `/v1/pair/auto`.
- Extension validates auth through `/v1/auth/check`.
- User can send candidates without manual token entry.

Fallback:

- If automatic pairing is blocked or unavailable, the extension shows `Link with NOVA Browser Extension`.
- That one-click action resets pairing, reconnects, pairs, authenticates, and syncs capabilities.

## Privacy Contract

The extension never sends cookies or Authorization headers collected from websites. Only safe metadata, candidate URLs, confidence, selected safe headers, and user-approved handoff payloads are sent to NOVA Browser Extension.

Tokens must be redacted from logs, diagnostics, crash reports, URLs, and support bundles.

## Acceptance Criteria

- Starting NOVA Browser Extension twice results in one running owner process.
- Second launch focuses/restores the first instance.
- Closing the main window keeps NOVA Browser Extension reachable when Minimize to system tray is enabled.
- Quitting from tray stops `/v1/ping`.
- Browser Extension pairs automatically after browser startup.
- `Link with NOVA Browser Extension` repairs pairing in one click.
- Tokens never appear in diagnostics.
