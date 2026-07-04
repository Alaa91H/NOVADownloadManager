# Protocol

NOVA protocol v4 is the local contract between the Browser Extension and NOVA Browser Extension desktop.

## Transports

- Native Messaging host: `com.nova.browserextension`.
- Loopback HTTP bridge: `http://127.0.0.1:3199`.
- Event stream: SSE preferred, WebSocket optional.

All desktop communication is local-only. Remote network origins are not valid NOVA bridge targets.

## Required Endpoints

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/v1/ping` | Discover daemon, protocol, and integration state |
| `POST` | `/v1/pair/auto` | Zero-click Browser Extension pairing |
| `POST` | `/v1/auth/check` | Validate bearer token |
| `GET` | `/v1/extension-settings` | Read desktop integration capabilities/settings |
| `POST` | `/v1/add` | Add a candidate to NOVA Browser Extension |
| `POST` | `/captures` | Compatibility capture submission route |
| `POST` | `/v1/extract-page` | Optional desktop page extraction |
| `POST` | `/v1/refresh-address/candidate` | Optional refresh-address candidate preview |
| `POST` | `/v1/refresh-address/apply` | Optional refresh-address application |
| `GET` | `/api/v1/events/stream` | Preferred SSE event stream |
| `GET` | `/v1/events` | Legacy/fake-daemon SSE fallback |

All successful desktop bridge responses include `protocolVersion`; compatibility responses also include `minimumSupportedProtocolVersion`, which must not exceed the extension-supported protocol v4.

## Pairing Contract

`POST /v1/pair/auto` must:

- accept trusted local Browser Extension origins only,
- return a bearer token,
- include token TTL,
- include `protocolVersion`,
- reject remote origins,
- never require manual code entry for the normal local install path.

If this fails, the extension exposes the `Link with NOVA Browser Extension` fallback.

## Desktop Lifecycle Contract

Protocol availability depends on NOVA Browser Extension desktop lifecycle:

- A single-instance process lock must ensure that only one desktop process owns `127.0.0.1:3199`.
- Minimize to system tray must keep `/v1/ping` and Native Messaging available when enabled.
- Default: ON for close-to-tray behavior on first install.
- Real shutdown must close event streams and release the process lock.

## Task Command Fallback

Task commands are sent through Native Messaging first: `task.pause`, `task.resume`, and `task.cancel`. If Native Messaging is unavailable but the capability registry allows the command and a bearer token exists, the bridge attempts loopback HTTP fallback routes for daemon implementations that expose REST task controls.

## Security

- Protected endpoints use `Authorization: Bearer <token>`.
- Tokens are never put in query strings.
- Diagnostics redact bearer tokens and sensitive query values.
- Runtime payloads are size-budgeted before schema parsing.
- HTTP and Native Messaging request/response envelopes are budgeted and schema-validated.
