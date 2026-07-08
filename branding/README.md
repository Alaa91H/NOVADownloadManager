# NOVA Branding Source

This folder is the canonical source for NOVA product artwork.

- `source/app-icon.png` - master app/logo icon used to generate desktop, web, browser-extension, Android, iOS, ICO, and ICNS icons.
- `source/installer-banner.png` - master wide banner used to generate HiDPI NSIS installer header/sidebar artwork.
- `source/profile-logo.png` - master dark profile logo used inside the NSIS sidebar artwork.

Do not manually edit generated artwork under `src-tauri/icons`, `src-tauri/windows`, `src/assets`, `public`, or `browser-extension/public/icons`. Update the files in `branding/source`, then run:

```powershell
pnpm run branding:generate
```

Those generated target folders are kept only because Tauri, Vite, WXT, and NSIS require assets in specific locations during development, packaging, and store builds. NSIS artwork is generated at 4x logical size and downscaled by the installer UI to keep the banner sharp on high-DPI displays.
