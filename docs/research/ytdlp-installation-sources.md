# yt-dlp Installation Research Notes

**Collected:** 2026-08-20 (GMT+2)
**Purpose:** Establish the upstream facts used to design NOVA-managed yt-dlp installation.

## Authoritative upstream facts

The official yt-dlp project distributes native release binaries, including `yt-dlp.exe` for Windows x64, `yt-dlp_arm64.exe` for Windows ARM64, `yt-dlp_linux`, `yt-dlp_linux_aarch64`, and `yt-dlp_macos`. The same release publishes `SHA2-256SUMS`, `SHA2-512SUMS`, and detached signatures (`.sig`); its public key is published in the source repository. GitHub's asset metadata does not need to expose a `digest` field for NOVA to verify these releases: NOVA can download the official checksum manifest, locate the selected asset's SHA-256 line, verify the binary against it, and optionally support detached-signature verification where an appropriate verifier is present.

The upstream documentation states that release binaries can update with `yt-dlp -U`. NOVA will not delegate its managed installation to that self-updater because it would bypass NOVA's source allow-list, checksum manifest handling, atomic replacement, registry ownership record, and post-install health validation. Instead, NOVA will repeat its own verified download/install workflow whenever the user chooses Update.

The upstream project describes three binary channels: `stable`, `nightly`, and `master`. The NOVA-managed path will use the official `stable` release endpoint by default. A channel choice is intentionally out of scope for the first managed-installer repair: the application must first make the default stable path correct, authenticated by the upstream checksum manifest, atomic, and observable.

## Design implication for Windows destinations

A normal desktop process cannot reliably write to `C:\Program Files` without elevation. Therefore the default NOVA-managed per-user destination must be writable without elevated privileges, while a machine-wide `C:\Program Files\YT-DLP` install requires an explicit, elevated installer or privileged helper. The backend must never silently fall back to a different location while reporting that it installed to Program Files.

## Sources

1. https://github.com/yt-dlp/yt-dlp#release-files
2. https://github.com/yt-dlp/yt-dlp/releases
3. https://github.com/yt-dlp/yt-dlp/wiki/Installation
4. https://github.com/yt-dlp/yt-dlp/blob/master/public.key
