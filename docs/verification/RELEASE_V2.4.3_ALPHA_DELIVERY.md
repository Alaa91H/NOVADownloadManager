# v2.4.3-alpha Delivery Record

**Release:** [`v2.4.3-alpha`](https://github.com/Alaa91H/NOVADownloadManager/releases/tag/v2.4.3-alpha)
**Published:** 2026-08-20 02:06 UTC
**Release tag commit:** `86b8347fed1ba0efc50e59f21bfbbbaf1f48175d`
**Post-release CI safeguard commit:** `2bafc028bc32cb00ea3a5e2d8cd3483a54b7177a`
**Release workflow:** [tagged build and publication](https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32321789511)
**Safeguard workflow:** [main-branch CI](https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32323634989)

## Delivery status

| Item | Verified status | Evidence |
|---|---|---|
| Source-quality gates | Passed | Rust compilation, Clippy with warnings denied, RustSec policy audit, Rust formatting, TypeScript, ESLint, frontend tests, extension checks, and final source audit |
| Cross-platform release build | Passed | Windows x64, Windows ARM64, Linux x64, Linux ARM64, macOS x64, and macOS ARM64 all completed successfully in the tagged workflow |
| GitHub release | Published, not draft | `v2.4.3-alpha` is a public release with 20 assets |
| Download integrity | Verified after publication | `SHA256SUMS.txt` now enumerates the exact names and GitHub SHA-256 digests of all 19 non-manifest release assets |
| Recurrence prevention | Passed in CI | The follow-up workflow canonicalizes whitespace in release names before checksum generation and validates the policy locally |

## Delivered product work

The release contains the previously verified adaptive download-engine work, including dynamic connection scaling above 32 when system capacity permits and stability guards for controlled growth. The repair set also adds a managed external-tool flow with live activation: an installed and health-checked yt-dlp binary is selected by later media analysis and download work without restarting the desktop daemon.

External-tool installation now distinguishes a safe per-user target from an explicit Windows system-wide target. The latter is requested only through the elevated Windows flow; NOVA does not report success when the requested privileged install did not complete. yt-dlp release metadata and SHA-256 sources are documented in [yt-dlp installation sources](../research/ytdlp-installation-sources.md).

The browser extension repair prevents an intercepted browser download from being cancelled repeatedly when NOVA rejects the policy decision. The extension marks its own fallback restart and allows that restart to pass once. A real-daemon acceptance sequence verified loopback reachability, trusted pairing, bearer validation, and candidate handoff. The narrower managed-tools and extension test record is available in [Managed Tools and Browser Extension Verification](MANAGED_TOOLS_AND_EXTENSION_VERIFICATION_2026-08-20.md).

## Validation record

| Validation activity | Result and scope |
|---|---|
| Rust test suite | Passed locally after the managed-tool and dynamic-path changes; the suite contained 712 tests at the recorded run |
| Frontend suite | Passed locally; the recorded run contained 461 tests |
| Browser-extension suite | Passed locally; the recorded run contained 750 tests |
| Extension Python policy suite | Passed locally; the recorded run contained 125 tests |
| Managed yt-dlp acceptance | Passed: official release asset acquisition, checksum verification, temporary managed installation, and `--version` health execution |
| Real extension handoff | Passed: daemon ping, pairing, token verification, and direct candidate delivery over loopback HTTP |
| Release packaging | Passed: six native platform builds, artifact upload, provenance attestation, release publication, and package-manifest generation |

These results do **not** claim that every web service, authenticated account, DRM-protected stream, or native-host registration scenario has been tested. The extension respects the local trust boundary and does not attempt to circumvent DRM or access controls.

## Published assets

The release has 20 assets: 19 distributable or package-manifest assets plus `SHA256SUMS.txt`. The distributable set includes Chrome, Edge, and Firefox extension packages; Windows x64 and ARM64 NSIS installers; a Windows x64 MSIX package; Linux x64 and ARM64 AppImage/deb/rpm packages; and macOS x64 and ARM64 DMGs. Package-manager manifests for Winget, Scoop, and Homebrew are also attached.

> **Integrity correction, disclosed:** The original tagged publish workflow produced checksums before the release action normalized spaces in several uploaded installer names. The binary digests were correct, but those manifest filenames did not exactly match the displayed asset names. After detecting this in post-publication verification, `SHA256SUMS.txt` was regenerated from GitHub's recorded SHA-256 digests for the 19 published non-manifest assets and replaced. The published manifest now matches every asset exactly. Commit `2bafc02` additionally changes CI so future builds canonicalize whitespace *before* checksums are generated and adds `scripts/verify-release-asset-manifest.sh` as a regression check.

## Documentation changes

The project README, changelog, document index, extension documentation, CI guide, historical audit records, and repair plans are maintained in English. The extension documentation is intentionally centralized under `docs/extension/`; the extension documentation readiness tool now checks that canonical location rather than requiring a duplicate `browser-extension/README.md` that the repository's final-source audit rejects.

## References

1. [Published v2.4.3-alpha release](https://github.com/Alaa91H/NOVADownloadManager/releases/tag/v2.4.3-alpha)
2. [Tagged build and publication workflow](https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32321789511)
3. [Post-release checksum safeguard CI workflow](https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32323634989)
4. [Managed tools and browser extension verification](MANAGED_TOOLS_AND_EXTENSION_VERIFICATION_2026-08-20.md)
5. [CI operating guide](../release/CI.md)
