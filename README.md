<p align="center">
  <img src="src/assets/logo.png" alt="NOVA logo" width="160" />
</p>

<h1 align="center">NOVA</h1>

NOVA is a desktop download manager built with Tauri (Rust) and a React/Vite front end. The download daemon runs **in-process inside the Tauri app** (no separate Node daemon) and uses:

- [aria2](https://github.com/aria2/aria2) for direct file and torrent downloads through JSON-RPC.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for video, playlist, and audio downloads.

A companion browser extension lives in [`browser-extension/`](browser-extension/).

## Requirements

- Node.js 24 (see `.node-version`)
- Rust stable toolchain (for the Tauri backend)
- Download engines: run `npm run fetch-engines` to download `aria2c` and `yt-dlp` into `bin/` and `src-tauri/resources/bin/`, or set `NOVA_ARIA2C` / `NOVA_YTDLP` to existing binaries
- FFmpeg is recommended for high-quality media merging and audio conversion

## Develop

```powershell
npm install
npm run fetch-engines   # first time only: download aria2c / yt-dlp
npm run tauri:dev       # starts the desktop app; run `npm run dev` in another terminal for the Vite dev server on port 3000
```

The embedded daemon listens on `http://127.0.0.1:3199` by default (override with `NOVA_DAEMON_PORT`).

For front-end-only work against an already-running app, `npm run dev` is enough.

## Build

```powershell
npm run tauri:build     # production NSIS installer (runs tauri:prepare first)
npm run build           # front-end bundle only
```

## Quality checks

```powershell
npm run lint            # TypeScript check (tsc --noEmit)
npm run lint:eslint     # ESLint
npm test                # vitest suite
npm run i18n:validate   # translation completeness (132 languages)
```

## Browser extension

```powershell
npm run extension:install
npm run extension:build
```
