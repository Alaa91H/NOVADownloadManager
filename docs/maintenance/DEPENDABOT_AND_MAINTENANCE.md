# Dependabot and Dependency Maintenance

The repository uses a single root `.github/dependabot.yml` for all product ecosystems:

- root npm frontend
- `browser-extension` npm package
- `src-tauri` Cargo dependencies
- GitHub Actions workflows

The browser extension no longer owns a nested Dependabot configuration in the integrated product. Its standalone CI templates are preserved because the extension release audits validate them, but dependency PRs are centralized at the product root.

Dependabot PRs should be treated as build candidates. Merge only after the full product gates pass: desktop UI checks, browser extension checks, static libcurl build verification, Rust `cargo check`, and Tauri installer build.

## Auto-merge

`.github/workflows/ci.yml` automatically merges low-risk
Dependabot updates once CI proves they build and pass tests, and holds
higher-risk updates for manual review.

### Policy

| Ecosystem | patch | minor | major |
| --- | --- | --- | --- |
| npm (root + `browser-extension`) | auto-merge | auto-merge | manual |
| `github-actions` | auto-merge | auto-merge | manual |
| `cargo` (`src-tauri`) | auto-merge | **manual** | manual |

Cargo `minor` bumps are held on purpose: for `0.x` crates a minor bump is
effectively breaking (Cargo convention), and the fast `validate` CI job does not
compile Rust — only the installer build does. This keeps risky Rust bumps such as
`reqwest 0.12 -> 0.13` or `tower-http 0.6 -> 0.7` out of the auto-merge lane.

Held updates get a `needs-manual-review` label and an explanatory PR comment.

### Required one-time GitHub settings

The workflow enables GitHub's native auto-merge (`gh pr merge --auto`). Auto-merge
**only completes after the required status checks pass** — so these settings are
what actually gate merges on the tests:

1. **Allow auto-merge** — Settings → General → Pull Requests → check
   *"Allow auto-merge"*.
2. **Branch protection / ruleset on `main`** — Settings → Branches (or Rules) →
   protect `main` and enable *"Require status checks to pass before merging"*,
   selecting the CI checks:
   - `Validate frontend and translations` (required — covers all npm/UI/extension updates)
   - `Build Windows NSIS installer` (recommended — the only job that runs
     `cargo check`; required if you ever widen cargo auto-merge beyond patch)

   Do **not** require pull-request approvals if you want unattended merges — the
   `GITHUB_TOKEN` cannot approve Dependabot PRs, so a required approval would stall
   auto-merge. Required status checks are sufficient gating for a solo maintainer.

> Without both settings, `--auto` has nothing to wait for and could merge
> immediately. Configure them before relying on the workflow.

### Widening or tightening the policy

Edit the two `if:` conditions in the workflow:

- To auto-merge cargo minor bumps too, drop the `package-ecosystem != 'cargo'`
  clause — **and** make `Build Windows NSIS installer` a required status check so
  Rust is compiled first.
- To auto-merge patch only, remove the `semver-minor` branch from the auto-merge
  step and add it to the manual-review step.
