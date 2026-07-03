# Release Pipeline Optimization

## Build Once, Reuse Everywhere
The CI pipeline builds Chrome, Edge, and Firefox packages once during the `package-build` job. Downstream jobs (browser E2E, release gates, store verification) reuse these built artifacts instead of rebuilding. This eliminates redundant compilation and reduces CI runtime.

## Gated Pipeline
The pipeline uses a collect-all failure strategy. Quality gates, package builds, and release gates run independently with `continue-on-error: true`. A summary job aggregates all results and determines pipeline success, ensuring all failures are visible without early termination.

## Release Flow
Tag pushes trigger the full pipeline including release notification. The `release:notes` step generates `RELEASE_NOTES.md`, `DOWNLOADS.md`, and `RELEASE_NOTIFICATION.txt`. The Telegram notification is sent only on successful tag releases. Build-only pushes skip notification entirely.
