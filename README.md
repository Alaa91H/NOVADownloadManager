# NOVA

NOVA is a desktop-style download manager UI built with React and Vite. The local daemon uses:

- [aria2](https://github.com/aria2/aria2) for direct file downloads through JSON-RPC.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for video, playlist, and audio downloads.

## Requirements

- Node.js 20+
- `aria2c` available on `PATH`, or set `NOVA_ARIA2C`
- `yt-dlp` available on `PATH`, or set `NOVA_YTDLP`
- FFmpeg is recommended for high-quality media merging and audio conversion

Windows quick install options:

```powershell
winget install aria2.aria2
python -m pip install -U yt-dlp
winget install Gyan.FFmpeg
```

## Run

```powershell
npm install
npm run dev:full
```

The React app opens at `http://localhost:3000`. The daemon listens on `http://127.0.0.1:3199` and Vite proxies `/api` to it.

## Useful Scripts

```powershell
npm run daemon   # local NOVA API, aria2 RPC launcher, yt-dlp runner
npm run dev      # React/Vite only
npm run build    # production front-end build
npm run lint     # TypeScript validation
```

## GitHub

```powershell
git init
git add .
git commit -m "Initial NOVA download manager"
gh repo create NOVA --private --source=. --remote=origin --push
```

Switch `--private` to `--public` if you want the repository public.
