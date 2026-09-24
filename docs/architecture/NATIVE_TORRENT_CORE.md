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
- HTTP(S) tracker announce URL construction with binary-safe info-hash/peer-id encoding.
- Bounded HTTP tracker response parsing for compact IPv4/IPv6 and dictionary peer lists.
- UDP tracker connect/announce packet codecs with transaction validation and compact peer decoding.
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
6. Torrent piece length is capped at 64 MiB before peer execution can allocate piece buffers.
7. A piece is not complete until its length and SHA-1 digest match metainfo.
8. Scheduler state prevents ordinary duplicate in-flight piece assignment.
9. BEP 10 is advertised only because bounded extended-message parsing is now implemented; unsupported extension IDs remain isolated from core piece state.
10. BEP 9 metadata is capped at 4 MiB, assembled in 16 KiB pieces, and SHA-1 checked against the magnet BTIH before parsing.
11. DHT/PEX-discovered addresses are filtered through NOVA's internal-address policy before connection attempts.
12. DHT fallback is disabled by default when a magnet already supplies trackers, preventing premature info-hash disclosure before the private flag is known.
13. Engine capabilities fail closed: unfinished durable execution features are advertised as false and `torrentMagnet` routing remains disabled.

## Planned execution stages

### Stage 2 — Tracker discovery — implemented

The tracker execution layer is now implemented with:

- first-party HTTP(S) tracker requests using DNS pinning after validating every resolved address;
- automatic proxy bypass for tracker requests so environment proxies cannot bypass endpoint pinning;
- manual redirect handling with full SSRF revalidation on every hop;
- preservation of announce parameters across redirects;
- first-party UDP connect/announce execution;
- transaction-ID validation for UDP tracker responses;
- ordered BEP 12 tracker-tier failover with duplicate suppression;
- bounded retry with exponential backoff;
- request timeouts and explicit cancellation through `CancellationToken`;
- lifecycle event helpers for `started`, periodic, `completed`, and `stopped`;
- scheduling based on tracker `interval` / `min interval` with safety bounds;
- response-body, peer-count, warning, and error-message size limits;
- tracker URL/token redaction in diagnostic failure aggregation;
- local HTTP and UDP transport tests that exercise real sockets.

The torrent engine still remains unavailable for task routing because peer-session transfer, metadata exchange, and durable resume are not complete.

### Stage 3 — Peer session engine — implemented foundation

The peer-session execution layer now includes:

- native outbound TCP connections for IPv4/IPv6 peers;
- a global outbound connection limit shared by torrent peer work;
- cancellable connect, handshake, read, write, and piece-transfer operations;
- strict BitTorrent handshake parsing and info-hash validation;
- self-peer rejection;
- validated choke/interested/bitfield/have state tracking;
- bitfield length and padding validation;
- request pipelining with bounded block size;
- block timeout and bounded retry handling;
- requeue of outstanding requests after peer choke;
- unsolicited block and wrong-piece rejection;
- deterministic piece assembly;
- SHA-1 verification before a piece is accepted;
- peer reputation accounting for success, timeout, protocol error, connection failure, and hash failure;
- automatic eviction of peers that repeatedly fail or return corrupt data;
- ranked peer failover;
- NOVA peer-id generation;
- local TCP acceptance tests covering handshake, verified piece transfer, wrong info-hash rejection, and unsolicited data.

`peerTransferExecution` remains false at the daemon capability level because this peer engine is not yet wired to durable torrent task storage/resume. This is intentionally fail-closed.

### Stage 4 — Magnet metadata and peer discovery — implemented foundation

The metadata/discovery layer now includes:

- BEP 10 extended peer-wire message framing (message id 20);
- strict extended-handshake parsing with local `ut_metadata` and `ut_pex` negotiation;
- BEP 9 metadata requests, data, reject messages, bounded pipelining, timeout and retry;
- 16 KiB metadata piece assembly with a 4 MiB metadata ceiling;
- exact SHA-1 validation of the raw BEP 9 `info` dictionary against the magnet BTIH;
- direct conversion of verified raw `info` bytes into the same validated `TorrentMetainfo` model used for `.torrent` files;
- incoming BEP 11 `ut_pex` IPv4/IPv6 peer parsing, de-duplication, per-session caps, and network-policy filtering;
- PEX suppression for known-private torrents and for tracker-backed magnet metadata sessions while the private flag is still unknown;
- BEP 5 KRPC codecs for `ping`, `find_node`, `get_peers`, and `announce_peer`;
- compact IPv4/IPv6 DHT node and peer decoding;
- bounded iterative UDP DHT `get_peers` lookup with transaction-ID validation, cancellation, timeouts, query limits, and closest-node ordering;
- configurable DHT bootstrap nodes and optional `announce_peer` using returned tokens;
- a native Magnet resolver that prefers tracker-discovered peers, consumes PEX during metadata exchange, and uses DHT automatically for trackerless magnets;
- a privacy guard that does not automatically fall back from explicit trackers to DHT while the torrent's `private` flag is still unknown;
- bounded Magnet URI size, tracker/web-seed counts, peer-candidate queues, metadata frames, and total extended-handshake wait time;
- private-torrent cleanup that discards DHT/PEX candidate sets once verified metadata declares the torrent private;
- local TCP/UDP protocol tests for BEP 9 metadata exchange and iterative DHT discovery.

Stage 4 does not yet make torrent tasks routable. DHT server/routing-table persistence, metadata serving, durable torrent storage, resume checkpoints, and complete task lifecycle integration remain intentionally disabled or unadvertised.

### Stage 5 — Durable storage and resume — implemented foundation

The durable execution layer now includes:

- safe single-file and multi-file storage mapped directly from verified torrent payload ranges;
- sparse allocation, explicit full preallocation, and no-preallocation modes;
- selected-file storage that never creates user-visible files for `Skip` entries;
- boundary-piece caching under NOVA's private control directory when one verified piece crosses selected and skipped files;
- `High`, `Normal`, and `Skip` file priorities propagated into piece scheduling;
- versioned atomic resume checkpoints with primary, temporary, and backup recovery candidates;
- verified-piece, boundary-cache, and owned-target bitmaps;
- fail-closed owned-file tracking so resume cannot adopt or overwrite an unrelated user file;
- a tracker-redacted storage manifest that persists torrent geometry and piece hashes without storing tracker passkeys or credentialed discovery URLs;
- restart from `root + info_hash` using the persisted manifest;
- checkpoint-only startup verification plus optional full recheck that can recover valid data written before a checkpoint commit;
- generation-safe async storage sessions: pause, cancel, selection changes, and resumed runs invalidate stale workers before they can commit pieces;
- scheduler restoration from the persisted verified bitmap and file priorities;
- exact selected-byte progress accounting and final file-length synchronization;
- bounded end-to-end selected-piece transfer orchestration from native peers into durable storage;
- restart behavior that skips already verified pieces and can finalize an already-complete selection without any peer connection;
- a shared peer-request bandwidth limiter across torrent peer sessions;
- live integration with NOVA's `PriorityBandwidthQueue` and `BandwidthManager`, including dynamic task allocation, global/per-task rate changes, and global pause semantics;
- cancellation-safe bandwidth pacing that does not leave phantom reserved bandwidth after a paused run;
- local storage, restart, corruption, generation-race, boundary-piece, policy, and TCP transfer tests.

Stage 5 makes the native transfer/storage pipeline executable, but the public torrent engine remains fail-closed. `available` stays false and `routing.torrentMagnet` stays null until Stage 6 registers torrent jobs, APIs, lifecycle state, and UI surfaces.

### Stage 6 — Daemon and UI integration

With stages 2–5 implemented, the remaining integration work is:

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
