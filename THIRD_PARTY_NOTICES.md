# Third-Party Notices

NOVA Download Manager is licensed under the MIT License (see [LICENSE](LICENSE)).
It also **bundles, links against, or invokes** third-party components that are
distributed under their own license terms. Those terms are independent of NOVA's
MIT license and **must be preserved in every redistribution** of NOVA release
artifacts (installer, portable bundle, or extracted application directory).

This file documents the primary bundled engines. License texts for individual
npm and Cargo dependencies are resolvable from `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`; run `pnpm licenses list` and `cargo about`/`cargo-license`
to regenerate a full dependency SBOM for a formal release.

---

## Bundled engines

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

### yt-dlp

- **Role in NOVA:** media-download engine for HLS/DASH and site-specific media
  workflows. Bundled as a standalone executable in the application `bin/`
  directory and invoked as a subprocess.
- **License:** The Unlicense (public domain dedication).
- **Project:** https://github.com/yt-dlp/yt-dlp · **License text:** https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE
- **Notes:** yt-dlp itself carries no redistribution restrictions, but the sites
  it interacts with may impose their own terms of use. NOVA does not modify
  yt-dlp; it ships the upstream build unchanged.

### FFmpeg

- **Role in NOVA:** post-processing for merge, remux, metadata, thumbnails,
  subtitles, chapters, and audio extraction. Bundled as a standalone executable
  in the application `bin/` directory and invoked as a subprocess.
- **License:** LGPL-2.1-or-later for the core libraries; **individual builds may
  be GPL-2.0-or-later** depending on the enabled components (e.g. `--enable-gpl`,
  `libx264`). NOVA's release pipeline bundles a system/prebuilt FFmpeg
  (`NOVA_BUNDLE_SYSTEM_FFMPEG=1`); the exact license of a given release is
  determined by the specific FFmpeg build that is bundled.
- **Copyright:** © the FFmpeg developers.
- **Project:** https://ffmpeg.org/ · **License text:** https://ffmpeg.org/legal.html
- **Redistribution obligation:** When a GPL/LGPL FFmpeg build is bundled, the
  corresponding license text **and an offer of / link to the corresponding
  source** for that exact build must accompany the release artifact. Record the
  source URL and build flags of the bundled FFmpeg in the release notes.

---

## Runtime frameworks (linked libraries)

| Component | Role | License | Project |
| --- | --- | --- | --- |
| Tauri | Desktop shell & bundler | MIT / Apache-2.0 | https://tauri.app/ |
| React | Desktop & extension UI | MIT | https://react.dev/ |
| Rust crates (tokio, axum, reqwest, serde, …) | Rust daemon | MIT / Apache-2.0 | see `src-tauri/Cargo.lock` |
| npm packages (see lockfile) | Frontend & tooling | mostly MIT / ISC / Apache-2.0 | see `pnpm-lock.yaml` |
| WebView2 (Windows) | Rendering runtime | Microsoft distributable | https://developer.microsoft.com/microsoft-edge/webview2/ |

Static `libcurl` feature dependencies built in CI (zlib, brotli, zstd, nghttp2,
libssh2) each carry their own permissive licenses (zlib, MIT, BSD) and are
covered by the same preservation requirement above.

---

## For maintainers

Before publishing a binary release:

1. Confirm the bundled FFmpeg build's license and source URL, and record them in
   the release notes.
2. Ship this `THIRD_PARTY_NOTICES.md`, the root `LICENSE`, and upstream license
   texts for curl and FFmpeg inside the installed application directory (NOVA
   stages these into `src-tauri/resources/` at build time — see
   `scripts/build-tauri-assets.mjs`).
3. Optionally regenerate a full SBOM with `pnpm licenses list` and a Cargo
   license tool for a complete dependency-level attribution list.
