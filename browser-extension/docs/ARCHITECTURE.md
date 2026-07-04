# Architecture

The extension uses a contract-first, ports-and-adapters architecture with a plugin capture pipeline, durable Outbox, Capability Registry, and strict runtime boundaries.

## Runtime Flow

```text
Popup / Options / Diagnostics
  -> Runtime Message Router
  -> Capture Pipeline
  -> Candidate Cache / Outbox
  -> BridgeManager
  -> TransportManager
  -> Native Messaging or NOVA Browser Extension loopback daemon
```

## Core Rules

- UI pages never call NOVA Browser Extension directly.
- Content scripts never receive the pairing token.
- Capture plugins never send work to NOVA Browser Extension; they only produce candidates.
- BridgeManager owns pairing, auth repair, capability sync, event stream setup, and outbox handoff.
- TransportManager owns HTTP, Native Messaging, SSE, and WebSocket adapters.
- SingleFlight protects auto-connect and outbox retry so repeated popup, alarm, startup, and context-menu events share one in-flight operation.
- Outbox persists accepted work and retries safely across MV3 service-worker wakeups.
- Capability Registry decides whether native, loopback, task-control, event-stream, and capture routes are available.

## Layers

| Layer | Responsibility |
| --- | --- |
| `contracts/` | JSON Schema and Zod compatibility contracts for NOVA protocol, candidates, errors, and runtime messages |
| `src/background/` | MV3 boot, lifecycle, alarms, context menus, commands, scanning, observers, badge, router |
| `src/bridge/` | BridgeManager, PairingManager, AuthManager, capability sync, health state |
| `src/transport/` | Native Messaging, loopback HTTP, SSE, WebSocket, loopback URL policy, payload budgets |
| `src/capture/` | DOM, embedded player hints, media, network, downloads, HLS, DASH, torrent, OpenGraph, JSON-LD capture plugins |
| `src/pipeline/` | Normalization, classification, scoring, dedupe, metadata enrichment |
| `src/outbox/` | Durable queue, idempotency, leased retries, terminal job cleanup |
| `src/storage/` | Settings, token, candidate cache, site rules, migrations |
| `src/security/` | Runtime message policy, payload budgets, redaction, permission policy, handoff policy |
| `src/ui/` | Popup, options, diagnostics, shared theme |
| `tools/` | Build, release, docs, package, E2E, architecture, and production guards |

## Desktop Boundary

The extension does not own native OS lifecycle. NOVA Browser Extension desktop must provide:

- single-instance process lock,
- Minimize to system tray,
- Default: ON close-to-tray behavior,
- Native Messaging host `com.nova.browserextension`,
- loopback daemon on `127.0.0.1:3199`,
- zero-click Browser Extension pairing,
- shutdown that releases the process lock and bridge resources.

See `DESKTOP_RUNTIME_REQUIREMENTS.md`.

## MV3 Service Worker Model

The service worker is event-driven. It does not depend on long-running intervals. Persistent state lives in browser storage or IndexedDB. Retry work is scheduled through `browser.alarms`; event streams can be closed and re-established when the service worker wakes again.

## Verification Boundaries

Architecture is enforced by:

- `pnpm guard:architecture`
- `pnpm guard:runtime`
- `pnpm guard:transport`
- `pnpm guard:storage`
- `pnpm docs:check`
- `pnpm guard:e2e`
- `pnpm verify:highest`
