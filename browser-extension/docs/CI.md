# CI And Strict Verification

The GitHub workflow is `NOVA Browser Extension Unified Pipeline`. It avoids duplicate work by running quality gates once, building browser packages once, then reusing the built unpacked Chromium artifact for Playwright smoke tests.

## Local Full Gate

Run the same high-confidence local gate before publishing or handing off a change:

```bash
pnpm run ci
```

`pnpm run ci` performs:

- `pnpm verify:offline`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:py`
- `pnpm guard:e2e`
- `pnpm build:zip`
- `pnpm validate:manifests`
- `pnpm test:e2e`
- `pnpm verify:release:reuse-build`
- `pnpm signoff:production -- --strict`

CI builds Chrome, Edge, and Firefox packages exactly once in `package-build`. The `browser-e2e` job downloads the `nova-browser-extension-unpacked` artifact and runs Playwright against `dist/chromium` instead of rebuilding the extension.

The real unpacked-extension persistent-profile smoke remains available for controlled environments with a known-good headed browser runner:

```bash
NOVA_RUN_REAL_EXTENSION_E2E=1 pnpm test:e2e
```

## Highest Verification

`pnpm verify:highest` is the full release hardening gate for local verification. The optimized release pipeline uses `pnpm verify:release:reuse-build` after package generation so store/package checks reuse generated outputs and do not trigger redundant builds.

## Workflow Jobs

| Job | Purpose |
| --- | --- |
| `preflight` | Node/toolchain and offline repository release checks before dependency-heavy jobs |
| `quality-gates` | TypeScript, ESLint, Vitest, and Python regression tests in a single dependency install; each check continues and reports to the final result gate |
| `package-build` | Builds Chrome, Edge, and Firefox packages once, builds the store profile once, then runs release gates; collectable failures are reported at the final gate |
| `browser-e2e` | Downloads the unpacked Chromium build and runs Playwright without rebuilding |
| `pipeline-result` | Authoritative final failure gate; fails only after all available quality/package/E2E checks have reported |
| `release` | Publishes generated release notes and Chrome/Edge/Firefox assets after all gates pass |
| `telegram-release` | Sends a Telegram notification only after a successful pushed `v*` tag release publication, with direct download links and changelog |


## Collect-All Failure Policy

The CI pipeline is intentionally not fail-fast for diagnosable gates. `quality-gates`, `package-build`, and `browser-e2e` use `continue-on-error` for their internal checks and write compact reports under `.ci-results/`. The `pipeline-result` job is the single authoritative failure point. This lets one run reveal TypeScript, ESLint, Vitest, Python, package, signoff, and E2E failures together when the required artifacts exist.

Release publication is still blocked: `release` runs only after `pipeline-result` succeeds.

The release workflow intentionally does not run `pnpm signoff:production -- --strict` inside `package-build`, because that script would repeat TypeScript, ESLint, Vitest, Python, store build, and Playwright after CI already collected those gates. The standalone signoff remains a local/reproducible final check, while CI uses the individual non-duplicated gates and fails centrally in `pipeline-result`.

## Build Entrypoints

```bash
node scripts/run-python.js build.py --clean
node scripts/run-python.js build.py --clean --zip
node tools/run-release-checks.js --package-only
```

## Artifact Layout

```text
dist/
  chromium/
  edge/
  firefox/
  packages/
    NOVA-Browser-Extension-chrome-<version>.zip   # .crx when a signing key is set
    NOVA-Browser-Extension-edge-<version>.zip
    NOVA-Browser-Extension-firefox-<version>.xpi
    release-manifest.json
    SBOM.json
    SHA256SUMS.txt
    CHANGELOG.md
  release-assets/
    NOVA-Browser-Extension-chrome-<version>.zip
    NOVA-Browser-Extension-edge-<version>.zip
    NOVA-Browser-Extension-firefox-<version>.xpi
    release-manifest.json
    SHA256SUMS.txt
    CHANGELOG.md
```

## Notifications

Release notifications are optional and tag-only. Telegram is notified only after a pushed `v*` tag successfully publishes a GitHub Release; branch builds, pull requests, and workflow-dispatch dry-runs do not send Telegram messages. If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing, the notification script exits successfully and logs that the notification was skipped.

The generated message includes:

- repository and version/tag,
- release URL,
- package download links,
- changelog excerpt.

## Toolchain Policy

- Node.js is pinned by `.nvmrc` and `package.json` engines.
- pnpm is pinned to `11.6.0`.
- `pnpm/action-setup@v6.0.8` is pinned.
- `standalone:` mode is intentionally not used because it reintroduces pnpm layout noise in CI.
- `pnpm-lock.yaml` is committed for deterministic installs.
- Playwright Chromium is installed only for browser E2E jobs.

## Desktop Contract In CI

`pnpm verify:desktop-contract` verifies that protocol docs and Native Messaging host templates still describe:

- `com.nova.browserextension`,
- NOVA protocol v4,
- `/v1/pair/auto`,
- `/v1/auth/check`,
- `/v1/add`,
- `/captures`,
- `protocolVersion`.

`pnpm docs:check` additionally verifies single-instance, Minimize to system tray, Default: ON, and `Link with NOVA Browser Extension` documentation.

The browser E2E job downloads `nova-browser-extension-unpacked` from `package-build` and runs `pnpm test:e2e` with `EXTENSION_UNPACKED_DIR=dist/chromium`. It must not rebuild Chromium inside E2E, because package-build is the single authoritative browser build source for the workflow.
