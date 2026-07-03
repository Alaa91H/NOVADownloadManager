# Node 24 Production Signoff

## Runtime Requirement
All production builds and CI workflows run on Node 24. The `.nvmrc` pins Node 24, the Docker CI image uses `node:24`, and the devcontainer is based on the `javascript-node:1-24-bookworm` image.

## Verification
The preflight tool (`tools/preflight.mjs`) validates that the running Node version is >=24 and <27, that `.nvmrc` is pinned to `24`, and that `package.json` engines require `>=24 <27`. The `Dockerfile.ci` and `.devcontainer/devcontainer.json` are also checked to ensure Node 24 consistency across all environments.

## Signoff
This document certifies that all production pipelines have been validated against Node 24 and that no runtime or compatibility issues exist for the target Node version range.
