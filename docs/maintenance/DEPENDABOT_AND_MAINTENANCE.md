# Dependabot and Dependency Maintenance

The root `.github/dependabot.yml` tracks four dependency surfaces:

- root Node.js repository tooling;
- the React-based browser extension;
- the Rust runtime and shared crates under `src-tauri` and `crates`;
- GitHub Actions workflows.

Dependabot groups related updates and opens weekly pull requests. Review the
resulting source changes and require the applicable checks from
`.github/workflows/nova-ci.yml` before merging. Depending on the changed files,
these include Rust daemon and shared-core checks, Android bridge checks, and
the Qt desktop build and native UI checks across the configured targets.

The Qt desktop is native C++/QML. React is used by the browser extension only;
the retired React/Vite/Tauri desktop dependencies and WebView packaging are not
part of the current dependency surface. This repository does not define an
auto-merge workflow, so merge policy is controlled by the repository's current
GitHub rulesets and maintainer review.

For Rust changes, review the lockfile impact and the direct/transitive
dependency updates together. For Qt changes, review the Qt module and deployment
requirements for the modules actually linked by `desktop-native/CMakeLists.txt`.
