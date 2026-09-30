# NOVA CLI

`nova` is a local Control Plane client. It discovers the daemon's Runtime capability registry before sending a command and uses the same versioned command/query envelopes as the other adapters.

Set `NOVA_API_TOKEN` to the local daemon bearer token. `NOVA_API_URL` is optional and defaults to `http://127.0.0.1:3199`. `NOVA_IDEMPOTENCY_KEY` or `--idempotency-key <key>` lets you safely retry a command after a client timeout. The client deliberately rejects non-loopback URLs until the separate authenticated and encrypted Remote API is implemented.

Run it from this directory with `cargo run --manifest-path crates/nova-cli/Cargo.toml -- <command>`.

Examples:

```text
nova capabilities
nova add https://example.org/archive.zip
nova list
nova inspect <task-id>
nova move <task-id> main
nova priority <task-id> 2
nova redownload <task-id>
nova queue list
nova profile set balanced
nova rules list
nova schedule list
nova media add https://example.org/video
nova network capabilities
nova events 0
nova diagnostics
nova logs 200 warn
```

Queue/profile/rule/schedule/media/torrent payloads that need advanced fields accept JSON. `media add` accepts either a URL or a complete JSON request. `diagnostics` and bounded, redacted `logs` use the shared query envelope. `network capabilities` filters the Runtime-owned registry to the `network.*` entries; it is read-only, and Network Profile management remains unavailable until the Runtime exposes that contract. Unified settings are also reported unavailable.
