# NOVA Engine Compatibility

## Runtime ownership

NOVA uses one product-owned execution model:

- direct file downloads use `nova-download-core` and in-process libcurl multi;
- media extraction, selection and transfer planning use `nova-media-core`;
- HLS/DASH protocol modeling uses `nova-stream-core`;
- post-processing is a separate local-file capability owned by `nova-media-postprocess`;
- the retired Media Bridge is not registered, discovered, executed or exposed by the runtime.

Legacy persisted tasks that still carry the historical `media-bridge` engine id are decode-only migration records. Unfinished tasks are marked `engine-retired` and instruct the user to re-add the original media URL; no bridge runtime is reconstructed.

## Public engine identities

The daemon exposes NOVA-owned identities:

- `native-transfer`
- `libcurl-multi`
- `nova-media-engine`
- `nova-media-postprocess`

Frontend and companion clients consume `engines.media` and capability fields instead of implementation-vendor names.

## Capability endpoint

`GET /api/engines/capabilities` is the runtime source of truth.

Media readiness is split explicitly into:

- `mediaExtractionReady` for first-party extraction and metadata/format resolution;
- `streamingReady` for native HLS/DASH execution;
- `postProcessingReady` for local-file mux/remux operations.

The retired `mediaReady` compatibility alias is not part of the contract. Feature code validates the capability it actually needs instead of inferring readiness from an external executable.

## Media API

Canonical first-party media endpoints are:

- `GET|POST /api/media/resolve`
- `GET /api/media/probe`
- `GET /api/media/probe-playlist`
- `POST /api/media/download`
- `GET /api/media/postprocess/status`

The resolve contract accepts explicit user-authorized request context such as User-Agent, Referer, Cookie and safe custom headers. Transport-owned headers are rejected and sensitive request context is not persisted to disk.

Retired `/api/media/bridge/*` routes are not registered.

## Browser companion contract

The browser companion uses NOVA-owned messages such as:

- `PROBE_MEDIA`
- `ADD_MEDIA`
- media capability snapshots
- selected stream-quality objects

HLS/DASH candidates are handed to NOVA Media Engine. The extension does not choose or invoke an external media resolver.

## Diagnostics

Diagnostics report NOVA capability identities and native job counts. External executable details are limited to capabilities that genuinely require a local executable, such as the temporary FFmpeg post-processing adapter.

## Compatibility policy

1. Native media ownership is authoritative.
2. Unsupported native behavior fails explicitly and closed.
3. No retired resolver fallback may be registered or reintroduced.
4. Historical `media-bridge` persisted ids are accepted only to produce a deterministic migration error.
5. Public UI, API schemas, product documentation and engine identities use NOVA-owned terminology.
