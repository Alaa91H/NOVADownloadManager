# Native Torrent Core

## Goal

NOVA's torrent support is being implemented as an in-process Rust engine rather than a wrapper around an external torrent executable. The engine is split from Tauri and UI code so the same protocol core can be reused by desktop and mobile hosts.

The implementation lives in `crates/nova-torrent-core` and is developed on `feature/native-torrent-core`.

## Current foundation

The first development stage establishes the protocol and data-integrity boundary required before any swarm networking is enabled:

- BitTorrent v1 `.torrent` metainfo parsing.
- Exact SHA-1 info-hash calculation from the original raw `info` dictionary bytes.
- Strict bencode limits for input size, nesting depth, container size, canonical integers and dictionary ordering.
- Safe single-file and multi-file path normalization that rejects traversal and platform-dangerous path components.
- Piece geometry and cross-file byte-range mapping.
- Per-piece SHA-1 verification before data can be accepted.
- Magnet URI parsing for hexadecimal and Base32 `urn:btih` hashes.
- Tracker and web-seed URL validation.
- BitTorrent peer handshake and length-prefixed peer-wire message codec.
- Bounded peer-frame parsing to prevent untrusted peers from forcing oversized allocations.
- Rarest-first piece scheduling with availability accounting and duplicate in-flight suppression.
- Deterministic block planning with bounded request sizes.

The host links this crate through `src-tauri/Cargo.toml`. Runtime capability reporting exposes the native foundation but deliberately keeps torrent task execution unavailable until swarm networking and persistence are wired end-to-end.

## Security and correctness boundaries

Torrent metadata and peer traffic are untrusted input. The core therefore applies these rules before network execution is added:

1. Metainfo is capped at 32 MiB.
2. Bencode nesting is capped and malformed/canonical-invalid encodings are rejected.
3. File paths cannot escape the selected download root.
4. Piece counts must exactly match the declared payload size and piece length.
5. Peer-wire frames are bounded before allocation.
6. A piece is not complete until its length and SHA-1 digest match metainfo.
7. Scheduler state prevents ordinary duplicate in-flight piece assignment.
8. Engine capabilities fail closed: unfinished network features are advertised as false and `torrentMagnet` routing remains disabled.

## Planned execution stages

### Stage 2 — Tracker discovery

Implement first-party HTTP(S) and UDP tracker clients with:

- compact IPv4/IPv6 peer decoding;
- announce lifecycle events (`started`, periodic, `completed`, `stopped`);
- tracker tier failover and retry backoff;
- response-size/time limits;
- SSRF and local-address protections aligned with NOVA's existing network policy.

### Stage 3 — Peer session engine

Add async peer connection orchestration:

- outbound peer connection limits;
- handshake/info-hash validation;
- choke/interested state machine;
- request pipelining;
- block timeout/retry;
- piece assembly and hash verification;
- peer quality scoring and eviction;
- IPv4/IPv6 support.

### Stage 4 — Magnet metadata and peer discovery

Add BEP 9/BEP 10 metadata exchange followed by:

- metadata size limits;
- metadata SHA-1 verification against the magnet BTIH;
- optional DHT (BEP 5);
- optional PEX;
- capability-gated discovery policies.

### Stage 5 — Durable storage and resume

Integrate torrent tasks with NOVA persistence:

- sparse/preallocated multi-file storage;
- atomic resume checkpoints;
- verified-piece bitmaps;
- startup recheck;
- selected-file priorities;
- safe pause/resume/cancel generation handling;
- rate limiting and priority-queue integration.

### Stage 6 — Daemon and UI integration

Only after stages 2–5 pass tests:

- register the native torrent extractor/router;
- enable `routing.torrentMagnet = "native-torrent"`;
- create torrent-specific daemon APIs;
- expose file selection, peers, trackers, availability and piece progress;
- add Qt/QML torrent dialogs and task details;
- add browser/OS magnet association handling.

## Quality gates

The root CI now runs:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path crates/nova-torrent-core/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

Torrent routing must remain disabled whenever an execution-stage capability is incomplete. This prevents NOVA from presenting parser-only support as a working torrent downloader.
