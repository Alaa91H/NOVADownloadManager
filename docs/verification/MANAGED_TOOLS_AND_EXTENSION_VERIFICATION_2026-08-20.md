# Managed Tools and Browser Extension Verification

**Verification date:** 2026-08-20
**Repository state:** Verified local working tree, pending commit and CI at the time of writing.
**Release status:** This report does **not** claim that these changes are already included in the published `v2.4.2-alpha` release. It records the implementation and checks completed in this working tree.

> **Verification principle.** A feature is described as verified only where a command, test, or live acceptance flow completed successfully. Platform-specific behavior that was not executable in this Linux environment is explicitly marked as unverified.

## Scope

This work addressed two production paths that must agree with one another: the daemon-managed installation of external media tools, especially **yt-dlp**, and the browser extension's capture-to-desktop handoff. It also repaired a concrete browser-download recovery fault: a download restarted by the extension after policy rejects takeover could be intercepted and cancelled again by the same extension.

| Area | Implemented behavior | Evidence recorded in this report |
|---|---|---|
| Managed yt-dlp | User-scoped verified download, health check, atomic activation, and restart-safe rediscovery | Live official-release installation test passed |
| Windows machine scope | Explicit `Program Files\YT-DLP` option with post-verification elevation request | Source, static checks, and Rust tests; not run on Windows in this environment |
| Runtime activation | Newly installed or updated tools become the active daemon paths without a daemon restart | Rust full suite and actual daemon handoff acceptance passed |
| Browser takeover recovery | A one-shot bypass lets an extension-created restart pass through once | New regression test and extension suite passed |
| Extension loopback handoff | Trusted Chromium-origin pairing, bearer check, and candidate submission | Actual Rust daemon acceptance script passed |

## Managed external tools

### Installation model

NOVA now separates installation **scope** from tool discovery. The default selection is a per-user NOVA-managed directory under the application data directory, for example `.../external_tools/yt-dlp`. This avoids requesting administrative access for the normal install path. The managed registry records the selected scope, executable path, detected version, owner, and SHA-256 value.

On Windows, the settings page additionally exposes an **Install to Program Files** action. It resolves yt-dlp's destination as `C:\Program Files\YT-DLP\yt-dlp.exe` and FFmpeg as `C:\Program Files\FFmpeg\...`. The daemon first downloads, hashes, materializes, and health-checks the binary in a user-writable NOVA staging location. Only after those checks pass does it request a UAC-approved move into the system directory. Cancellation, refusal, or a failed elevated command returns an error; NOVA does not silently report a Program Files installation while falling back to another directory.

| Step | User-scoped installation | Windows system-scoped installation |
|---|---|---|
| Destination | NOVA application-data `external_tools/<tool>` | `%ProgramFiles%\YT-DLP` or `%ProgramFiles%\FFmpeg` |
| Privilege | No elevation required | Explicit UAC approval required |
| Download staging | Destination directory | NOVA user-writable staging directory |
| Digest check | Required before materialization | Required before elevation |
| Health check | Required before atomic replacement | Required before elevation and final move |
| Activation | Immediate for subsequent daemon operations | Immediate for subsequent daemon operations after final move |

The current implementation accepts only HTTPS GitHub release-asset URLs on the expected release host, verifies the `sha256:` digest published in GitHub release-asset metadata, rejects malformed or mismatched digests, and removes staged material on failure. The yt-dlp project publishes native release binaries and checksum assets for its releases.[1] NOVA currently uses the release asset's published SHA-256 metadata; it **does not yet perform detached PGP signature verification** of `SHA2-256SUMS.sig`. That limitation is intentional and documented rather than hidden.

### Immediate activation and recovery

An installed tool is no longer merely listed as healthy in Settings. The daemon now updates its active yt-dlp or FFmpeg path after a verified install or update, invalidates cached engine capabilities, and replaces the registered yt-dlp extractor for future work. New media analyses, probes, extension stream resolutions, and new media downloads use the new executable. Existing child processes are deliberately not rewritten while running.

On daemon startup, the persisted NOVA-managed registry is discovered before capability-cache warming, so a verified managed tool is preferred immediately after restart. On removal, the daemon restores the bundled/fallback path and rebuilds the yt-dlp extractor instead of retaining a deleted executable path.

### Live yt-dlp acceptance result

The ignored acceptance test `daemon::external_tools::installer::tests::live_ytdlp_release_installs_verifies_and_executes` was explicitly run. It fetched the current official Linux x86_64 yt-dlp release, verified the expected SHA-256 value, installed into a temporary NOVA-managed directory, executed `yt-dlp --version`, validated the parsed version, and cleaned up the temporary directory. The result was **1 passed, 0 failed**.

## Browser extension capture and handoff

### Recovery from a declined takeover

The download interceptor must cancel early to win the browser's native-download race. Previously, when settings later determined that a download should remain in the browser, NOVA restarted that download but had no marker identifying it as its own recovery request. The fresh `onCreated` event could therefore be cancelled again, resulting in a repeat loop or a lost browser download.

The interceptor now creates a short-lived, one-shot restart marker keyed by URL and filename before calling `browser.downloads.download`. The next matching `onCreated` event consumes the marker and bypasses capture. If the browser rejects the restart operation, the marker is removed immediately, so a later user-created download is still evaluated normally. A regression test covers policy decline, browser restart, and the absence of a second cancellation.

### Actual daemon handoff acceptance

The repository includes `scripts/verify_real_extension_handoff.sh`. Against a daemon started with `--integration`, the script completed the same protocol sequence used by the Chromium extension path:

1. It queried `/v1/ping` and confirmed protocol version 4 with browser integration enabled.
2. It called `/v1/pair/auto` from NOVA's pinned Chromium extension origin.
3. It extracted the issued pairing token and passed `/v1/auth/check` with a bearer header.
4. It submitted a direct-download candidate to `/v1/add` and verified both `ok: true` and `accepted: true`.

This real daemon acceptance flow passed. It verifies the daemon-side loopback contract, origin-gated pairing, bearer authentication, and candidate conversion/addition. It does **not** claim that a production browser profile, native-host installer registration, every streaming service, or every site adapter was exercised in this Linux sandbox.

## Verification record

All results below were obtained after the changes described above. The ordinary Rust suite retains one ignored external-network acceptance test; that test was run separately and is listed explicitly.

| Gate or acceptance flow | Result |
|---|---:|
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | **712 passed; 0 failed; 1 ignored** |
| Live official yt-dlp install acceptance (`--ignored`) | **1 passed; 0 failed** |
| `cargo fmt --all -- --check` | **Passed** |
| `cargo clippy -- -D warnings` | **Passed** |
| `cargo audit --deny warnings` | **Passed** |
| `pnpm run test` | **461 passed; 0 failed** |
| `pnpm run lint` | **Passed** |
| `pnpm run lint:eslint` | **Passed** |
| `pnpm run format:check` | **Passed** |
| `pnpm --filter nova-browser-extension test` | **751 passed; 0 failed** |
| `pnpm --filter nova-browser-extension lint` | **Passed** |
| `python3 -m pytest browser-extension/tests/ -q` | **125 passed** |
| `pnpm run audit:final` | **Passed with 0 source-audit warnings** |
| Actual Rust-daemon loopback handoff script | **Passed** |

## Reproduction commands

```bash
export PATH="$HOME/.cargo/bin:$PATH"
. "$HOME/.nvm/nvm.sh" && nvm use 24
cd /path/to/NOVADownloadManager

# Normal Rust suite and the explicit networked yt-dlp acceptance check.
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml \
  external_tools::installer::tests::live_ytdlp_release_installs_verifies_and_executes \
  -- --ignored --nocapture

# Start a test-only integration daemon, then run actual loopback handoff.
NOVA_DAEMON_PORT=3199 \
NOVA_INTEGRATION_API_TOKEN=nova-e2e-integration-token-2026 \
cargo run --locked --manifest-path src-tauri/Cargo.toml -- --integration
# In a second terminal:
scripts/verify_real_extension_handoff.sh
```

## Known boundaries

The system-wide Program Files path is intentionally Windows-only and needs administrator approval. Its UAC flow is covered by source review, formatting, compilation, and the Rust suite, but was **not executable** in this Linux-based verification environment. The normal per-user installer and the actual download/verification/health/activation chain were executed live.

NOVA does not bypass DRM, access controls, browser security boundaries, or provider terms. A capture candidate is only a handoff request; final success still depends on the remote server, the user's authorization, the tool's supported extractor, and the configured runtime capabilities.

## References

[1]: https://github.com/yt-dlp/yt-dlp#release-files "yt-dlp release files"
[2]: https://github.com/yt-dlp/yt-dlp/wiki/Installation "yt-dlp installation documentation"
[3]: https://github.com/Alaa91H/NOVADownloadManager "NOVA Download Manager repository"
