# NOVA Browser Extension

> The Manifest V3 browser companion for **NOVA Download Manager**. It discovers eligible download and media candidates in the browser, then hands them to the local NOVA desktop application through Native Messaging or the authenticated loopback bridge.

## Product boundaries

The extension is a companion, not a bypass mechanism. It does not circumvent DRM, account access controls, browser security boundaries, or service terms. A candidate can be handed to NOVA only when the desktop daemon advertises the relevant runtime capability and accepts the authenticated request.

| Capability | What the extension does | What NOVA Desktop decides |
|---|---|---|
| Direct files | Detects links, browser downloads, and safe network evidence | Validates protocol and starts the libcurl task |
| HLS and DASH | Detects manifests and presents available candidates | Resolves and downloads supported media through yt-dlp/FFmpeg |
| Browser download takeover | Cancels an eligible browser download early and places a durable handoff job in the outbox | Accepts the candidate when the daemon is reachable; retries are safe and idempotent |
| Recovery after a policy decline | Restarts the browser download once and bypasses its own restart event | Does not create a NOVA task |
| Pairing and events | Performs trusted-local pairing and listens for daemon events | Issues and validates scoped loopback bearer tokens |

## Features

The extension supports direct-link capture, context-menu capture, deep DOM scanning, media-element inspection, OpenGraph and JSON-LD discovery, HLS/DASH detection, and filtered candidate presentation. Its user-approved aggressive profile expands discovery through page-context `fetch`, XHR, `MediaSource`, WebSocket, EventSource, object-URL, and network-observer evidence. Platform-specific adapters improve extraction confidence for supported sites; they do not guarantee that every service or every protected stream can be downloaded.

The floating video control is draggable, persists its position as a relative viewport location, and returns to its default upper-right placement on double click. The extension stores queued handoff requests in its outbox so a browser-captured item can be retried after the desktop application becomes reachable.

## Local bridge and pairing

NOVA uses a local-only transport model. Chromium-family builds use a pinned extension origin for the loopback pairing fallback; the Native Messaging host `com.nova.downloadmanager` is preferred because it does not expose the pairing token to unrelated extensions. Firefox relies on the registered native host because its profile-specific extension origin is not a stable allowlist boundary.

The complete protocol and security model are documented in the following canonical files:

- [Extension architecture](ARCHITECTURE.md) — layer boundaries, lifecycle, capture pipeline, and transport roles. (`docs/extension/ARCHITECTURE.md`)
- [Desktop runtime requirements](DESKTOP_RUNTIME_REQUIREMENTS.md) — daemon, Native Messaging, loopback, and diagnostics prerequisites. (`docs/extension/DESKTOP_RUNTIME_REQUIREMENTS.md`)
- [Zero-click pairing](ZERO_CLICK_PAIRING.md) — trusted-local pairing and token lifecycle. (`docs/extension/ZERO_CLICK_PAIRING.md`)
- [Protocol](PROTOCOL.md) — versioned API messages and capability contract.
- [Security](SECURITY.md) — local trust boundary, permissions, redaction, and payload limits.
- [Privacy](PRIVACY.md) — data handling and non-collection commitments.

## Requirements

| Tool or component | Supported requirement | Purpose |
|---|---|---|
| Node.js | `>=24 <27` | Build tools and automated tests |
| pnpm | `>=11 <12` | Workspace package manager |
| Python | 3.11+ | Policy and compatibility tests |
| Chromium | Current Playwright-compatible version | Browser automation where enabled |
| NOVA Desktop | Running local daemon and installed native host for full handoff | Pairing, capabilities, task delivery, and task events |

## Desktop launch and connection

**NOVA Download Manager Extension** expects the desktop application to be installed and running. The desktop side maintains a `single-instance` runtime and exposes its local bridge at `http://127.0.0.1:3199` unless an alternate safe loopback port is selected. Browser integration is **Default: ON** when the daemon reports it available; the extension still verifies protocol compatibility and pairing before enabling task handoff.

The popup presents **Link with NOVA** when it needs to pair or repair a pairing. Keep the desktop application running; choosing **Minimize to system tray** is supported when closing its window, so background downloads and the browser bridge can remain available without leaving the main window open.

## Development commands

Run commands from the repository root unless noted otherwise.

```bash
# Extension development and routine checks
pnpm --filter nova-browser-extension dev
pnpm --filter nova-browser-extension typecheck
pnpm --filter nova-browser-extension lint
pnpm --filter nova-browser-extension test
pnpm --filter nova-browser-extension test:e2e
pnpm --filter nova-browser-extension run ci
# Equivalent commands from browser-extension/:
# pnpm test:e2e
# pnpm run ci
python3 -m pytest browser-extension/tests/ -q

# Packaging and store-readiness checks
pnpm --filter nova-browser-extension build:zip
pnpm --filter nova-browser-extension verify:offline
pnpm --filter nova-browser-extension verify:store
```

The `test` command executes unit, contract, and loopback-integration coverage. The actual daemon acceptance script at `scripts/verify_real_extension_handoff.sh` verifies ping, trusted pairing, bearer authentication, and direct candidate handoff against an integration daemon. Its exact scope and limitations are recorded in the [managed-tools and extension verification report](../verification/MANAGED_TOOLS_AND_EXTENSION_VERIFICATION_2026-08-20.md).

## Project layout

```text
browser-extension/
├─ src/background/       Manifest V3 service worker and download interception
├─ src/bridge/           pairing, capabilities, reconnect policy, and handoff gateway
├─ src/capture/          page scan, network evidence, media and manifest capture
├─ src/content/          isolated-world scanner and MAIN-world page tap
├─ src/contracts/        protocol and candidate schemas
├─ src/outbox/           durable, idempotent handoff queue and retry worker
├─ src/transport/        Native Messaging, loopback HTTP, SSE, and WebSocket adapters
├─ src/ui/               popup, options, overlay, and diagnostics interface
├─ src/tests/            unit, contract, and integration tests
├─ tests/                Python policy, compatibility, and packaging checks
└─ native-messaging/     host manifest templates
```

## Documentation and CI

Repository documentation is centralized under `docs/`; the executable workflow is `.github/workflows/ci.yml`. The CI guide is [docs/release/CI.md](../release/CI.md). It describes the relevant workflow stages, the distinction between source checks and platform builds, and the expected verification commands. (`docs/release/CI.md`)

For visual behavior, permissions, and user-facing capture settings, see [Overlay](OVERLAY.md), [Permissions](PERMISSIONS.md), [Aggressive Capture Mode](AGGRESSIVE_CAPTURE_MODE.md), and [DRM Guard](DRM_GUARD.md).

## License

NOVA Browser Extension is distributed under the MIT License. See [LICENSE](../../LICENSE).
