# NOVA Documentation

This directory is the canonical documentation home for NOVA Download Manager. The only Markdown documentation intentionally kept outside this directory is the root `README.md`, which acts as the public product landing page.

## Architecture

- [Project structure](architecture/PROJECT_STRUCTURE.md) — canonical source tree, generated-file policy, and repository ownership model.
- [Engine compatibility](architecture/ENGINE_COMPATIBILITY.md) — libcurl multi, yt-dlp, FFmpeg, runtime validation, and capability contracts.
- [Capability gating](architecture/CAPABILITY_GATING.md) — how desktop UI and browser extension consume runtime engine capabilities.

## Browser extension

- [Extension overview](extension/README.md)
- [Architecture](extension/ARCHITECTURE.md)
- [Aggressive capture mode](extension/AGGRESSIVE_CAPTURE_MODE.md)
- [Desktop runtime requirements](extension/DESKTOP_RUNTIME_REQUIREMENTS.md)
- [DRM guard](extension/DRM_GUARD.md)
- [Desktop developer handoff](extension/NOVA_BROWSER_EXTENSION_DESKTOP_DEVELOPER_HANDOFF.md)
- [NOVA-Extension feature sync](extension/NOVA_EXTENSION_FEATURE_SYNC.md)
- [Overlay](extension/OVERLAY.md)
- [Permissions](extension/PERMISSIONS.md)
- [Privacy](extension/PRIVACY.md)
- [Protocol](extension/PROTOCOL.md)
- [Security](extension/SECURITY.md)
- [Zero-click pairing](extension/ZERO_CLICK_PAIRING.md)
- [CI templates](extension/ci-templates/) — archived extension CI/build templates kept as documentation only; executable CI lives under root `.github/`.

## Release and store operations

- [CI](release/CI.md)
- [Release process](release/RELEASE.md)
- [Release tag notification policy](release/RELEASE_TAG_NOTIFICATION_POLICY.md)
- [Store compliance](release/STORE_COMPLIANCE.md)
- [Store publishing](release/STORE_PUBLISHING.md)
- [Store review checklist](release/STORE_REVIEW_CHECKLIST.md)
- [Testing](release/TESTING.md)
- [Store listings](release/store-listings/)

## Maintenance

- [Dependabot and maintenance](maintenance/DEPENDABOT_AND_MAINTENANCE.md)
- [Product finalization report](maintenance/PRODUCT_FINALIZATION_REPORT.md)
- [Unification and stability audit](maintenance/UNIFICATION_AND_STABILITY_AUDIT.md)

## Canonical paths

- `docs/architecture/ENGINE_COMPATIBILITY.md`
- `docs/extension/README.md`
- `docs/maintenance/DEPENDABOT_AND_MAINTENANCE.md`

## Documentation policy

Keep documentation centralized here. Do not add Markdown documentation under `browser-extension/`, `src/`, `src-tauri/`, or the repository root, except for the root `README.md`. Browser-extension CI/build templates that are not executed directly belong under `docs/extension/ci-templates/`, while executable CI and Dependabot configuration belong only under root `.github/`. Store-facing listing copy also belongs under `docs/release/store-listings/`.
