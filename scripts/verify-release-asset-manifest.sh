#!/usr/bin/env bash
# Verify the canonical release-asset naming policy used by CI. The published
# list must contain installable packages (including the Android APK) plus the
# final SHA-256 manifest, never package-manager metadata files.
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$repo_root/.github/workflows/ci.yml"

require_workflow_fragment() {
  local fragment=$1
  if ! grep -Fq -- "$fragment" "$workflow"; then
    printf 'Missing CI release-manifest safeguard: %s\n' "$fragment" >&2
    exit 1
  fi
}

forbid_workflow_fragment() {
  local fragment=$1
  if grep -Fq -- "$fragment" "$workflow"; then
    printf 'Unexpected CI release-manifest behavior: %s\n' "$fragment" >&2
    exit 1
  fi
}

require_workflow_fragment 'canonical="${f// /.}"'
require_workflow_fragment 'Release filename collision:'
require_workflow_fragment 'names exactly the downloadable release assets'
require_workflow_fragment 'Collect release files and generate final manifest'
require_workflow_fragment "-o -name '*.apk'"
require_workflow_fragment 'android-apk:'
require_workflow_fragment 'needs: [build, android-apk, e2e]'
require_workflow_fragment "diff -u <(printf '%s\\n' \"\$release_assets\") <(printf '%s\\n' \"\$manifest_assets\")"
require_workflow_fragment 'Manual dispatch accepts the documented X.Y.Z[-prerelease] input'
require_workflow_fragment 'VERSION="v$VERSION"'
require_workflow_fragment "prerelease: \${{ contains(github.ref_name, '-') }}"
require_workflow_fragment "make_latest: \${{ !contains(github.ref_name, '-') }}"
require_workflow_fragment 'function Ensure-WingetFfmpeg'
require_workflow_fragment 'winget install --exact --id Gyan.FFmpeg'
require_workflow_fragment 'Chocolatey could not install ffmpeg; attempting winget fallback.'
forbid_workflow_fragment 'node ../_repo/scripts/generate-package-manifests.mjs'

workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
cd "$workspace"

printf 'linux package\n' > 'Nova Download Manager_2.4.3-alpha_linux_amd64.AppImage'
printf 'windows package\n' > 'Nova Download Manager_2.4.3-alpha_windows_x64-setup.exe'
printf 'android package\n' > 'Nova Download Manager_2.4.3-alpha_android_arm64-v8a.apk'
printf 'extension package\n' > 'NOVA-Browser-Extension-chrome-2.4.3.0.zip'

for f in *; do
  [ -f "$f" ] || continue
  canonical="${f// /.}"
  [ "$canonical" = "$f" ] && continue
  [ ! -e "$canonical" ] || {
    printf 'Unexpected filename collision: %s -> %s\n' "$f" "$canonical" >&2
    exit 1
  }
  mv -- "$f" "$canonical"
done

for f in *; do
  [ -f "$f" ] && sha256sum "$f" >> SHA256SUMS.txt
done

if find . -maxdepth 1 -type f -name '* *' -print -quit | grep -q .; then
  echo 'Canonical release assets must not contain whitespace.' >&2
  exit 1
fi

for forbidden in \
  nova-download-manager.json \
  nova-download-manager.rb \
  NOVA.DownloadManager.installer.yaml \
  NOVA.DownloadManager.locale.en-US.yaml \
  NOVA.DownloadManager.yaml; do
  if [ -e "$forbidden" ] || grep -Fq "  $forbidden" SHA256SUMS.txt; then
    printf 'Non-installable package-manager metadata must not be published: %s\n' "$forbidden" >&2
    exit 1
  fi
done

sha256sum --check --strict SHA256SUMS.txt >/dev/null

manifest_assets=$(awk '{print $2}' SHA256SUMS.txt | sort)
release_assets=$(find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -printf '%f\n' | sort)
if ! diff -u <(printf '%s\n' "$release_assets") <(printf '%s\n' "$manifest_assets"); then
  echo 'SHA-256 manifest does not enumerate the canonical release assets exactly.' >&2
  exit 1
fi

printf 'Release asset naming, Android APK inclusion, metadata exclusion, and SHA-256 manifest policy verified.\n'
