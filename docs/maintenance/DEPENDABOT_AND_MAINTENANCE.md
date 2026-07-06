# Dependabot and Dependency Maintenance

The repository uses a single root `.github/dependabot.yml` for all product ecosystems:

- root npm frontend
- `browser-extension` npm package
- `src-tauri` Cargo dependencies
- GitHub Actions workflows

The browser extension no longer owns a nested Dependabot configuration in the integrated product. Its standalone CI templates are preserved because the extension release audits validate them, but dependency PRs are centralized at the product root.

Dependabot PRs should be treated as build candidates. Merge only after the full product gates pass: desktop UI checks, browser extension checks, static libcurl build verification, Rust `cargo check`, and Tauri installer build.
