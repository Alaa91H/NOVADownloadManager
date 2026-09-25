# Zero-click Pairing

Zero-click pairing is the default Browser Extension connection model. The user should not need to copy codes, search for hidden pairing screens, or manually configure ports.

## Startup Flow

```text
browser starts
  -> extension service worker boots
  -> BridgeManager starts auto-connect
  -> Native Messaging host availability is checked
  -> loopback daemon is pinged at 127.0.0.1
  -> protocolVersion and minimumSupportedProtocolVersion are validated
  -> stored bearer token is checked through /v1/auth/check
  -> if missing or rejected: extension asks com.nova.downloadmanager to pair
  -> native host reads the current per-daemon pairing proof
  -> native host POSTs /v1/pair/auto with role marker + rotating proof secret
  -> daemon issues a native-client token separate from its master API token
  -> token is returned to the extension through Native Messaging
  -> token is stored with TTL in extension-local storage
  -> capabilities are synced over authenticated loopback HTTP
```

Direct browser HTTP is deliberately **not** allowed to mint a pairing token. Chromium, Edge and Firefox all use the registered Native Messaging host for the pairing handshake.

## Desktop Requirements

NOVA Browser Extension desktop must expose:

- Native Messaging host `com.nova.downloadmanager`.
- Loopback bridge on `127.0.0.1`.
- Zero-click endpoint `POST /v1/pair/auto`.
- Auth endpoint `POST /v1/auth/check`.
- NOVA protocol v4 fields `protocolVersion` and `minimumSupportedProtocolVersion`.
- A per-daemon `nova-daemon.pairing.json` proof record stored in the user's NOVA data directory.
- A distinct native-client bearer token that is not the daemon's internal master token.

## Security Rules

- `/v1/pair/auto` is loopback-only.
- Direct browser-origin pairing is rejected, including the pinned Chromium extension origin.
- Native auto-pair requires both a trusted NOVA native role marker and the current random daemon pairing secret.
- The pairing secret rotates every daemon start and is never returned over an unauthenticated HTTP endpoint.
- On Unix, the pairing proof file is restricted to mode `0600`.
- The daemon removes the pairing proof file on clean shutdown.
- The token returned by auto-pair is separate from the daemon master token and becomes invalid when the daemon restarts.
- Tokens and pairing secrets must never be logged, placed in query strings, copied into diagnostics, or sent to websites.
- The extension must redact token-like fields in all diagnostics.
- If a stored token is rejected, BridgeManager clears it and repeats the Native Messaging pairing path.

## Manual Recovery

If automatic pairing fails because Native Messaging is missing, the daemon is stopped, protocol compatibility fails, or the local registration is damaged, the UI repair path should:

```text
reset pairing state
repair Native Messaging registration
start or discover the NOVA daemon
read the current daemon pairing proof
pair through the native host
POST /v1/auth/check
sync capabilities
update diagnostics
```

This preserves zero-click recovery without exposing tokens or requiring manual code entry.
