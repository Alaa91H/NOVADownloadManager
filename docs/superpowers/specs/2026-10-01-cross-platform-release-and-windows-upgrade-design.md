# Cross-platform Release Packaging and Safe Windows Upgrade Design

**Date:** 2026-10-01
**Status:** Design proposal for review
**Approved direction in chat:** Continue with Linux AppImage, macOS DMG, Android release APK, and a corrective alpha release.

## Goal

Publish one verifiable NOVA alpha release with installable packages for Windows, Linux, macOS, and Android, and prevent the Windows installer from failing halfway through an upgrade when a NOVA executable is still running.

## Current behavior and evidence

- The tagged release currently attaches Windows x64 and ARM64 setup files only. The desktop matrix uploads Linux and macOS preview bundles as short-lived workflow artifacts, while the Android job uploads a debug APK for CI rather than a release APK.
- `packaging/windows/nova-setup.nsi` recursively copies the application files into the installation directory without checking whether NOVA is running.
- `BackendBootstrap` owns `nova-native-backend.exe` through `QProcess` and stops that child when the desktop bootstrap is destroyed. Replacing the backend while the desktop is still open can therefore fail with the Windows write error shown for `bin/nova-native-backend.exe`.
- GitHub Actions has Android release-signing secret names configured. The secret values must remain confined to the signing job and must never be logged or committed.
- No Apple Developer ID or notarization secrets are configured. The alpha macOS image must be clearly identified as unsigned.

The installer dialog is consistent with an executable sharing/lock conflict. The installer must also report other write failures clearly, since endpoint protection or filesystem permissions can produce a similar message.

## Release outputs

The next corrective release is `v2.4.53-alpha`. Published tag `v2.4.52-alpha` remains immutable and unchanged.

| Platform | Release files | Architecture and signing |
|---|---|---|
| Windows | Existing per-user NSIS setup | x64 and ARM64; unsigned as today |
| Linux | Self-contained Qt AppImage | x86_64 and aarch64; include Qt/QML runtime payload and record the supported host ABI baseline |
| macOS | DMG containing the deployed `.app` bundle | Intel and Apple Silicon as separate images; unsigned and clearly labeled alpha until Apple signing/notarization credentials are configured |
| Android | Release APK | ARM64 (`arm64-v8a`); signed using the configured GitHub Actions Android signing secrets |

Every release asset receives a SHA-256 entry. The release upload gate must require the Windows installers, both Linux images, both macOS images, the signed Android APK, and the checksum manifest before considering asset publication complete. Debug APKs and short-retention preview bundles are not release assets.

Linux packaging must bundle NOVA's Qt libraries, QML modules, and required Qt plugins. The package job must establish and test the supported glibc/system ABI floor rather than claiming universal compatibility. The selected Linux packaging tools and their versions/checksums must be pinned in CI.

## Windows upgrade behavior

Before extracting any files, setup checks for the NOVA desktop process and its bundled backend.

1. If NOVA is running, request a graceful application close so the existing desktop lifecycle can stop its owned backend.
2. Wait for the desktop and backend executables to exit before writing into the installation directory.
3. If either process remains active, stop before extraction and show a localized, actionable message explaining that NOVA must be closed before retrying setup.
4. Never forcibly terminate a running download process from the installer.
5. Preserve the current install location, user data, and normal uninstall behavior.

The failure path must not leave a partially overwritten installation. A subsequent retry after the application closes must complete normally.

## CI and release flow

- Keep ordinary pull-request quality checks separate from release signing secrets.
- On an approved tag, build each platform artifact from the exact tagged commit and use its existing native architecture job where practical.
- Add dedicated package validation for Linux AppImage, macOS DMG, and Android release APK outputs.
- Keep Android signing isolated to a tag-only job. Decode the keystore into a temporary runner directory, use Gradle signing, verify the APK signature and ARM64 native library, and delete the temporary keystore in an unconditional cleanup step.
- Generate checksums only after packages are finalized. Compare the checksum manifest against the exact set of uploaded files.
- Publish the corrective release only after all required quality, native build, installer/package smoke, signing, and checksum gates pass.

## Acceptance criteria

- Windows CI installs a clean copy, launches it, runs the new setup as an upgrade while the desktop/backend are active, observes graceful shutdown, verifies the upgraded files, and uninstalls cleanly. A blocked/timeout case must exit before extraction with an actionable message.
- Linux x86_64 and aarch64 jobs produce executable AppImages containing the app, Rust backend, Native Messaging host, required Qt/QML runtime files, build metadata, and parity report. Each image passes an architecture and launch smoke check on a matching runner.
- macOS Intel and Apple Silicon jobs produce mountable DMGs with the correct architecture and a complete `.app` bundle. CI verifies the DMG structure and app executables; release notes disclose the absence of Apple signing/notarization.
- Android release CI produces a non-debug ARM64 APK with package ID `com.nova.downloadmanager`, the NOVA FFI shared library, the intended release version, and a valid signature from the configured Android release key.
- The release contains exactly the intended platform packages plus checksum metadata; every downloaded package verifies against its published SHA-256.
- CI failures block release asset publication and do not move or replace an existing tag.

## Non-goals

- Publishing a stable release or representing this alpha as production-ready.
- Publishing an Android App Bundle or Google Play listing.
- Producing a universal macOS binary, Windows ARM64 emulator package, or Linux distribution-specific DEB/RPM packages in this change.
- Force-killing NOVA or discarding active download state during Windows upgrades.
- Claiming macOS Gatekeeper trust before Apple Developer ID signing and notarization are configured.

## Design trade-offs

- AppImage provides a single Linux download per architecture, but still has a system ABI floor and must be tested on the declared baseline.
- Separate macOS DMGs are compatible with the current per-architecture build matrix; the unsigned alpha may require users to approve the app in macOS security settings.
- A signed ARM64 APK is directly installable, but keeping the Android signing key stable is required for future in-place updates.
- Asking users to close NOVA when graceful shutdown does not complete protects active downloads better than terminating the process, at the cost of an extra user action in that exceptional case.
