# Microsoft Store (MSIX) packaging

Nova Download Manager is packaged for the Microsoft Store as a full-trust
desktop MSIX. CI builds a sideloadable `.msix` on the `windows-x64` job via
`pnpm run msix:build` and attaches it to tagged releases.

## Before submitting to the Store

1. Reserve the app name in [Partner Center](https://partner.microsoft.com/dashboard)
   and open **Product management → Product identity**.
2. Copy these values into [`AppxManifest.xml`](./AppxManifest.xml):
   - `Identity/@Name` → **Package/Identity/Name**
   - `Identity/@Publisher` → **Package/Identity/Publisher** (e.g. `CN=1234ABCD-…`)
   - `Properties/PublisherDisplayName` → your registered publisher display name
3. Replace the placeholder tile art in the generated `Assets/` with correctly
   sized PNGs (Store requires exact dimensions: 44×44, 150×150, 310×150, 50×50).
4. Sign the `.msix` with a certificate whose subject matches `Identity/@Publisher`
   (the Store re-signs on ingestion, but signing is required for sideload testing):
   `signtool sign /fd SHA256 /a /f cert.pfx /p <pw> Nova-Download-Manager-*.msix`
5. Upload the `.msix` in the Partner Center submission.

## Local build

```
pnpm run tauri:build          # produces src-tauri/target/release/nova.exe + resources
pnpm run msix:build           # writes dist-msix/Nova-Download-Manager-<ver>-x64.msix
```

Requires the Windows 10/11 SDK (`makeappx.exe`).
