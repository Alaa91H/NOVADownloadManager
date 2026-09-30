# Windows release package

The Windows installer source is [`windows/nova-setup.nsi`](windows/nova-setup.nsi).
It creates separate x64 and ARM64 per-user setup files from the matching native
preview bundles, which already contain the Qt runtime, NOVA UI, Rust backend,
and Native Messaging host. No third-party download executable is installed by
the setup.

For release-request commits, CI builds and silently installs/uninstalls both
setups before it creates a tag. After the immutable tag passes the complete
quality, Rust, Android, desktop, and CodeQL gates, CI rebuilds both installers,
creates SHA-256 checksum files, and attaches them to the draft GitHub release.
The installer job also runs for pull requests that touch desktop or packaging
code, so installer regressions block those changes.

To compile locally, stage the Windows preview bundle at
`preview/NOVA-Native-Windows-x64` or `preview/NOVA-Native-Windows-arm64`, create
the `dist` directory, install NSIS 3.12.0, then invoke `makensis` from the
repository root with `APP_VERSION`, `APP_FILE_VERSION`, `APP_ARCH`, and
`APP_SOURCE_DIR` defines. The Windows CI workflow is the canonical release
recipe and validates installation and removal on a clean runner.

The setup currently installs per-user under `%LOCALAPPDATA%`, creates a Start
Menu shortcut, offers an optional desktop shortcut, registers an uninstaller,
and uses the NOVA application icon and version metadata. Authenticode signing is
not configured yet, so the generated setup files are unsigned.
