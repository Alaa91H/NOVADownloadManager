# NOVA Branding Source

This folder keeps the canonical artwork used by the current product surfaces.

- `source/icon-hires.png` (or `source/app-icon.png` as a fallback) generates the
  Qt desktop, browser-extension, and Android launcher icons.
- `source/profile-logo.png` is the high-resolution logo used by the repository
  README and product documentation.
- `source/installer-banner.png` is retained artwork from the retired installer
  design; current Qt packaging does not consume it.

Do not edit generated icons by hand. Update the canonical icon source and run:

```powershell
pnpm run branding:generate
```

The generator writes only to `desktop-native/resources/icons`,
`browser-extension/public/icons`, and the Android launcher icon directories.
The retired React/Vite/Tauri desktop assets, WebView resources, and NSIS artwork
are not build targets for the current product.
