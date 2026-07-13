# Zero-click Pairing

Zero-click pairing is the default Browser Extension connection model. The user should not need to copy codes, search for hidden pairing screens, or manually configure ports.

## Startup Flow

```text
browser starts
  -> extension service worker boots
  -> BridgeManager starts auto-connect
  -> Native Messaging availability is checked
  -> loopback daemon is pinged at 127.0.0.1:3199
  -> protocolVersion and minimumSupportedProtocolVersion are validated
  -> stored bearer token is checked through /v1/auth/check
  -> if missing or expired: POST /v1/pair/auto
  -> token is stored with TTL in extension-local storage
  -> capabilities are synced
```

## Desktop Requirements

NOVA Browser Extension desktop must expose:

- Native Messaging host `com.nova.downloadmanager`.
- Loopback bridge `http://127.0.0.1:3199`.
- Zero-click endpoint `POST /v1/pair/auto`.
- Auth endpoint `POST /v1/auth/check`.
- NOVA protocol v4 fields `protocolVersion` and `minimumSupportedProtocolVersion`.
- Local-only trust policy for extension origins.

## Security Rules

- Pairing tokens must be bearer tokens with TTL.
- Tokens must never be logged, placed in query strings, copied into diagnostics, or sent to websites.
- Pairing must reject remote network origins.
- The extension must redact token-like fields in all diagnostics.
- If a token expires or is rejected, BridgeManager clears it and retries pairing once through the same validated route.

## Manual Fallback

If automatic pairing fails because Native Messaging is missing, the daemon is stopped, protocol compatibility fails, or security policy requires user activation, the popup exposes a clear button:

```text
Link with NOVA Browser Extension
```

The button runs the same repair path as automatic pairing:

```text
reset pairing state
discover Native Messaging
ping loopback
POST /v1/pair/auto
POST /v1/auth/check
sync capabilities
update diagnostics
```

This gives the user a one-click recovery path without exposing tokens or requiring manual code entry.
