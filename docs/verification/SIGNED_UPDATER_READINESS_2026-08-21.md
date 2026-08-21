# Signed Updater Readiness — 2026-08-21

**Repository:** [`Alaa91H/NOVADownloadManager`](https://github.com/Alaa91H/NOVADownloadManager)  
**Audited release:** [`v2.4.11-alpha`](https://github.com/Alaa91H/NOVADownloadManager/releases/tag/v2.4.11-alpha)  
**Tagged CI run:** [32469120673](https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32469120673)  
**Status:** **Safely unavailable by design; not falsely advertised as enabled.**

## Scope and conclusion

NOVA currently ships the updater plugin, its frontend integration, and an explicit configuration-status command. However, it deliberately does **not** claim that in-application updates work while its endpoint and public-key fields are placeholders. This is the correct product behavior until a real public key, a trusted HTTPS metadata endpoint, updater artifacts, signatures, and metadata publication are configured as one verifiable release pipeline.[1]

> **Security boundary:** Tauri requires signed update artifacts and does not allow signature verification to be disabled. The public key may be embedded and shared, but the corresponding private key must remain secret. Losing that private key prevents future trusted updates for existing installations.[1]

| Area | Audited state | Result |
|---|---|---|
| Embedded updater configuration | `src-tauri/tauri.conf.json` contains `https://__UPDATER_ENDPOINT__` and `__UPDATER_PUBKEY__`. | Intentionally unconfigured. |
| Runtime guard | `get_updater_configuration_status` marks placeholder values as unavailable; the frontend presents an honest explanation and an **Open releases** fallback. | Safe and tested. |
| Build signing secret | CI supplies `TAURI_SIGNING_PRIVATE_KEY` and its password to the Tauri build step. | Present, but not sufficient alone. |
| Updater artifact generation | `bundle.createUpdaterArtifacts` is not configured. | Missing. |
| Published updater files | `v2.4.11-alpha` has no `.sig` asset and no `latest.json` asset. | Missing. |
| Release integrity | The published release is a non-draft prerelease. Its 19 non-manifest assets match all 19 entries in `SHA256SUMS.txt`. | Passed independently. |

## Why the current release must not enable the updater

The normal package files currently attached to a release are not an updater channel. Tauri needs updater artifacts produced during the build, their matching textual signatures, and metadata that provides a valid download URL plus the **signature contents** for each supported target. A path or URL to a `.sig` file is not accepted in the metadata; the signature text itself is required.[1]

The current release publication step deliberately collects installers, application packages, extension packages, and package-manager manifests. It does not collect `.sig` files, and it does not generate a static update metadata document. Therefore, replacing the placeholders prematurely would cause an application to reach an incomplete channel, which would be worse than the present clear unavailable state.

## Required trusted inputs

The remaining external dependency is the **Tauri public key that matches the already configured GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`**. Only the public-key text is required for the repository. The private key and its password must not be committed, pasted into source files, written to logs, or sent through issue comments.[1]

| Required input | Owner/source | Validation before use |
|---|---|---|
| Tauri public key | Maintainer who controls the matching private signing key | Confirm it is public-key text, not a filename or a private-key block. |
| Static HTTPS update endpoint | Maintainer-controlled GitHub Releases or another HTTPS host | Confirm that an unauthenticated production client can retrieve valid metadata. |
| Release-channel policy | Maintainer | Decide whether alpha builds consume stable-only metadata or a separately hosted alpha metadata channel. |

## Implementation plan once the public key is supplied

The following work should be completed in one reviewed change set, then validated through a new tagged build. It is intentionally not partially enabled beforehand.

1. Set `bundle.createUpdaterArtifacts` to `true` in `src-tauri/tauri.conf.json`. Tauri will then produce platform-specific updater bundles and matching `.sig` files while the signing secret is available during the build.[1]
2. Replace `__UPDATER_PUBKEY__` with the supplied public-key text. Replace `https://__UPDATER_ENDPOINT__` with a real HTTPS endpoint. The endpoint may use Tauri’s documented `{{current_version}}`, `{{target}}`, and `{{arch}}` variables if a dynamic service is chosen.[1]
3. Extend artifact collection to include only valid updater bundles and their `.sig` files. Do not publish unverified signatures or unrelated signing outputs.
4. Generate `latest.json` after all platform assets and signatures have been normalized. The document must contain a valid version and, for every advertised platform, an HTTPS URL and the exact signature text. Tauri validates the complete metadata document before it checks the requested platform or compares versions.[1]
5. Add `latest.json` and updater assets to the final SHA-256 manifest only after their content has been finalized. Preserve the existing manifest-versus-release-assets diff check.
6. Publish the metadata to the selected endpoint and test it from a clean installed previous version on each supported target. Verify: no update response for the current version, valid update detection for an older version, signature validation, download progress, installer handoff, restart behavior, and failure behavior for altered metadata or a substituted signature.

## Release-channel decision

Because alpha tags are correctly published as GitHub prereleases, GitHub’s stable `releases/latest` route is unsuitable as the sole metadata location for alpha-to-alpha updates. The project should choose one explicit policy before enabling the channel.

| Policy | Behavior | Suitable when |
|---|---|---|
| Stable-only metadata | All builds check a static document that tracks the newest stable release. Alpha installations may update only when a later stable version exists. | Alpha builds are test artifacts rather than a continuous tester channel. |
| Separate alpha metadata | Stable and alpha metadata are hosted at distinct HTTPS locations; the app selects its endpoint by a deliberate channel setting. | Testers must receive alpha-to-alpha updates without exposing alpha builds as stable. |
| Dynamic service | A server receives the requesting version, target, and architecture, then returns `204` when no update is appropriate or a signed update record when one is available. | The project needs explicit cohorts, staged rollout, rollback policy, or channel targeting. |

The project must not silently route prerelease builds through a stable endpoint or publish alpha metadata as stable. This preserves the release policy already verified in `v2.4.11-alpha`.[2]

## Verification record

| Check | Result |
|---|---|
| Tagged CI build | Passed for Windows x64, Windows ARM64, Linux x64, Linux ARM64, macOS x64, and macOS ARM64. |
| Release status | `v2.4.11-alpha` is published, non-draft, and marked prerelease. |
| Release integrity | 20 total release assets: `SHA256SUMS.txt` plus 19 non-manifest assets. Every GitHub SHA-256 digest matched the published manifest entry. |
| Updater asset query | No published filename matched `.sig`, `latest.json`, or `updater`. |
| Placeholder guard | Updater endpoint and public-key placeholders remain present, so the tested application path does not attempt an invalid update request. |

## References

[1]: https://v2.tauri.app/plugin/updater/ "Tauri v2 Updater documentation"
[2]: https://github.com/Alaa91H/NOVADownloadManager/releases/tag/v2.4.11-alpha "NOVA Download Manager v2.4.11-alpha"
[3]: https://github.com/Alaa91H/NOVADownloadManager/actions/runs/32469120673 "Tagged CI build and publication for v2.4.11-alpha"
