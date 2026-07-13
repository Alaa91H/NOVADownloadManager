# NOVA Documentation

This directory is the canonical documentation home for NOVA Download Manager. The Markdown files intentionally kept outside this directory are the root `README.md` (public product landing page) and the standard repository metadata files listed under [Repository root files](#repository-root-files).

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
- [Extension feature sync](extension/NOVA_EXTENSION_FEATURE_SYNC.md)
- [Overlay](extension/OVERLAY.md)
- [Permissions](extension/PERMISSIONS.md)
- [Privacy](extension/PRIVACY.md)
- [Protocol](extension/PROTOCOL.md)
- [Security](extension/SECURITY.md)
- [Zero-click pairing](extension/ZERO_CLICK_PAIRING.md)
- [CI templates](extension/ci-templates/) — archived extension CI/build templates kept as documentation only; executable CI lives under root `.github/`.

## Maintenance

- [Dependabot and maintenance](maintenance/DEPENDABOT_AND_MAINTENANCE.md) — root Dependabot policy plus the auto-merge lane and its one-time GitHub settings.

## Repository root files

Standard project metadata files are kept at the repository root because tooling and platform conventions expect them there (GitHub community-health rendering, package/registry conventions, the installer's bundled legal notices, and the `audit:final` gate):

- `README.md` — public product landing page.
- `LICENSE` — MIT license text.
- `CHANGELOG.md` — release changelog.
- `CONTRIBUTING.md` — contributor guide.
- `CODE_OF_CONDUCT.md` — community code of conduct.
- `SECURITY.md` — security reporting policy.
- `THIRD_PARTY_NOTICES.md` — bundled curl/yt-dlp/FFmpeg license notices.

## Canonical paths

- `docs/architecture/ENGINE_COMPATIBILITY.md`
- `docs/extension/README.md`
- `docs/maintenance/DEPENDABOT_AND_MAINTENANCE.md`

## Documentation policy

Keep documentation centralized here. Do not add Markdown documentation under `browser-extension/`, `src/`, or `src-tauri/`. New repository-level Markdown at the root is limited to `README.md` and the standard metadata files listed under [Repository root files](#repository-root-files). Browser-extension CI/build templates that are not executed directly belong under `docs/extension/ci-templates/`, while executable CI and Dependabot configuration belong only under root `.github/`.
