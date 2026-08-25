#!/usr/bin/env bash
# Install CI system dependencies resiliently when an Ubuntu mirror rotates an
# archive between apt-get update and download. Every retry discards stale index
# files, refreshes metadata, and preserves apt's own bounded download retries.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <apt-package> [<apt-package> ...]" >&2
  exit 2
fi

readonly max_attempts=3
for attempt in $(seq 1 "$max_attempts"); do
  echo "Installing Linux build dependencies (attempt ${attempt}/${max_attempts})..."
  sudo rm -rf /var/lib/apt/lists/*
  sudo apt-get -o Acquire::Retries=3 update -qq

  if sudo env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=3 \
    install -y -qq --no-install-recommends --fix-missing "$@"; then
    exit 0
  fi

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "Linux build dependency installation failed after ${max_attempts} attempts." >&2
    exit 1
  fi

  sleep "$((attempt * 15))"
done
