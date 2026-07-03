#!/usr/bin/env bash
set -euo pipefail

REQUIRED_NODE_MAJOR=24
REQUIRED_PNPM_VERSION=11.6.0

node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "$node_major" != "$REQUIRED_NODE_MAJOR" ]]; then
  echo "Node $REQUIRED_NODE_MAJOR is required. Current: $(node -v 2>/dev/null || echo 'not installed')" >&2
  echo "Use nvm, volta, fnm, mise, or the included Dockerfile.ci/devcontainer." >&2
  exit 1
fi

corepack enable
corepack prepare "pnpm@${REQUIRED_PNPM_VERSION}" --activate
pnpm --version
pnpm install --frozen-lockfile
pnpm verify:production
