# NOVA Engine Compatibility

## Runtime ownership

NOVA uses one product-owned execution model:

- direct file downloads use `nova-download-core` and in-process libcurl multi;
- media extraction and stream planning use `nova-media-core`;
- HLS/DASH protocol modeling uses `nova-stream-core`;
- post-processing is represented as a separate capability;
- a temporary `Media Bridge` is available only where native parity is not yet complete.

No external resolver name is part of the public capability model.

## Public engine identities

The daemon exposes stable NOVA-owned identities:

- `native-transfer`
- `nova-media-engine`
- `nova-media-postprocess`
- `media-bridge` for temporary migration compatibility only

Frontend code should consume `engines.media` and must not depend on implementation-vendor names.

## Capability endpoint

`GET /api/engines/capabilities` is the runtime source of truth.

Media readiness is determined from:

- native extractor availability;
- protocol support;
- post-processing availability when required;
- optional bridge readiness only for capabilities not yet migrated.

Feature code must validate capabilities before starting work rather than assuming a particular binary exists.

## Media resolve API

Native resolution is exposed through:

- `GET /api/media/native/resolve?url=...`
- `POST /api/media/native/resolve`

The POST contract reuses NOVA's existing media request model and accepts explicit authorized request context such as User-Agent, Referer, Cookie and custom headers.

Compatibility probing, where still required, lives under the NOVA namespace:

- `/api/media/bridge/probe`
- `/api/media/bridge/probe-playlist`
- `/api/media/postprocess/status`

## Browser companion contract

The browser companion uses NOVA-owned messages such as:

- `PROBE_MEDIA`
- `ADD_MEDIA`
- media capability snapshots
- selected stream-quality objects

HLS/DASH candidates are handed to the NOVA media API. The extension never chooses an implementation vendor.

## Diagnostics

Diagnostics report NOVA capability identities and versions/capability states. External executable filenames, source repositories and package implementation details are restricted to the compatibility adapter and third-party/legal metadata where technically necessary.

## Compatibility policy

1. Native paths are preferred.
2. Unsupported native behavior fails explicitly.
3. The Media Bridge may be used only during migration.
4. No public UI, API schema, product documentation or engine identity may expose a vendor resolver name.
5. Once parity gates pass, the bridge code and release resource are deleted.
