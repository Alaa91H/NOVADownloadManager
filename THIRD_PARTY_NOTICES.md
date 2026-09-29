# Third-Party Notices

NOVA Download Manager is licensed under the MIT License (see [LICENSE](LICENSE)).
It also bundles or links against third-party components distributed under
their own license terms. Those terms are independent of NOVA's MIT license and
**must be preserved in every redistribution** of NOVA release artifacts
(installer, portable bundle, or extracted application directory).

This file documents the primary bundled engines. License texts for individual
npm and Cargo dependencies are resolvable from `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`; run `pnpm licenses list` and `cargo about`/`cargo-license`
to regenerate a full dependency SBOM for a formal release.

---

## Bundled engines

### remade-ffmpeg (Rust codec engine)

- **Role in NOVA:** in-process desktop audio/video decoding, encoding,
  filtering, remuxing, and container conversion. The Android FFI dependency
  graph also includes the crate. NOVA vendors the published `remade-ffmpeg`
  0.2.0 crate and its Rust dependency graph; native media tasks do not launch
  an `ffmpeg`-named executable.
- **License:** Apache-2.0. The upstream license text is preserved at
  `vendor/remade-ffmpeg-0.2.0/LICENSE-APACHE`.
- **Copyright:** Copyright 2026 Mata Network and contributors.
- **Project:** https://github.com/Remade-With-Rust/remade_ffmpeg_rs ·
  **Published crate:** https://crates.io/crates/remade-ffmpeg/0.2.0
- **Local changes:** NOVA adds a packet-boundary controlled transcoder with
  pause/cancel/progress callbacks in the vendored `src/transcode.rs`.
- **Notes:** The upstream release identifies itself as pre-1.0 and not yet
  independently audited. Codec and output-container availability is checked
  against the embedded registries at runtime. See
  [NATIVE_CODEC_BACKENDS.md](docs/architecture/NATIVE_CODEC_BACKENDS.md).

### curl / libcurl

- **Role in NOVA:** in-process direct-download engine. NOVA links a static
  `libcurl` (built from the latest stable upstream curl release by
  `scripts/build-native-curl.mjs`) through the Rust `curl` / `curl-sys` crates,
  and may also ship a `curl` command-line binary in the application `bin/`
  directory.
- **License:** curl license (an MIT/X derivative).
- **Copyright:** © 1996–2026 Daniel Stenberg and many contributors.
- **Project:** https://curl.se/ · **License text:** https://curl.se/docs/copyright.html
- **Notes:** The curl license requires that the copyright notice and permission
  notice appear in all copies. NOVA satisfies this by shipping this notice and
  the upstream `COPYING` file alongside the linked/bundled binary.

### Legacy optional FFmpeg tool manager

- **Role in NOVA:** legacy optional tool-management API only. The native media
  extraction, mux, subtitle, and conversion paths do not require or invoke this
  executable. Standard NOVA release workflows do not bundle it.
- **License:** LGPL-2.1-or-later for the core libraries; **individual builds may
  be GPL-2.0-or-later** depending on the enabled components (e.g. `--enable-gpl`,
  `libx264`). If an administrator uses the legacy tool-management API to install
  or provide an FFmpeg build, the exact license depends on that build.
- **Copyright:** © the FFmpeg developers.
- **Project:** https://ffmpeg.org/ · **License text:** https://ffmpeg.org/legal.html
- **Redistribution obligation:** If a distribution later bundles a specific
  FFmpeg build, include that build's license text and corresponding source offer
  or link, and record the build source and flags with that distribution.

---

## Runtime frameworks (linked libraries)

| Component | Role | License | Project |
| --- | --- | --- | --- |
| Qt 6.8 and selected Qt modules | Native Qt/QML desktop UI | Terms depend on the selected Qt distribution and modules; see the official licensing guide | [Qt 6.8 licensing](https://doc.qt.io/qt-6.8/licensing.html) |
| React | Browser-extension UI | MIT | https://react.dev/ |
| Rust crates (tokio, axum, reqwest, serde, …) | Rust daemon and native engines | Per-crate terms; see `src-tauri/Cargo.lock` and upstream notices | see `src-tauri/Cargo.lock` |
| npm packages (see lockfile) | Browser extension and repository tooling | Per-package terms, commonly MIT / ISC / Apache-2.0 | see `pnpm-lock.yaml` |

Static `libcurl` feature dependencies built in CI (zlib, brotli, zstd, nghttp2,
libssh2) each carry their own permissive licenses (zlib, MIT, BSD) and are
covered by the same preservation requirement above.

---

## For maintainers

Before publishing a binary release:

1. Ship this `THIRD_PARTY_NOTICES.md`, the root `LICENSE`, and the upstream
   license texts required by the Qt, Rust, and bundled native dependencies in
   each desktop distribution. The Qt deployment and packaging steps must match
   the libraries actually included in that artifact.
2. Optionally regenerate a full SBOM with `pnpm licenses list` and a Cargo
   license tool for a complete dependency-level attribution list.
