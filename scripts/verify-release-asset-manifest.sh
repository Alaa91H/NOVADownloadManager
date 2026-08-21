#!/usr/bin/env bash
# Verify the canonical release-asset naming policy used by CI. The release
# pipeline must generate its package-manager metadata before the final SHA-256
# manifest so the manifest enumerates every uploaded release asset.
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$repo_root/.github/workflows/ci.yml"

require_workflow_fragment() {
  local fragment=$1
  if ! grep -Fq "$fragment" "$workflow"; then
    printf 'Missing CI release-manifest safeguard: %s\n' "$fragment" >&2
    exit 1
  fi
}

require_workflow_fragment 'canonical="${f// /.}"'
require_workflow_fragment 'Release filename collision:'
require_workflow_fragment 'names exactly the downloadable release assets'
require_workflow_fragment 'Collect release files and generate final manifest'
require_workflow_fragment 'node ../_repo/scripts/generate-package-manifests.mjs'
require_workflow_fragment "diff -u <(printf '%s\\n' \"\$release_assets\") <(printf '%s\\n' \"\$manifest_assets\")"
require_workflow_fragment 'Manual dispatch accepts the documented X.Y.Z[-prerelease] input'
require_workflow_fragment 'VERSION="v$VERSION"'

workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
cd "$workspace"

printf 'linux package\n' > 'Nova Download Manager_2.4.3-alpha_linux_amd64.AppImage'
printf 'windows package\n' > 'Nova Download Manager_2.4.3-alpha_windows_x64-setup.exe'
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

sha256sum --check --strict SHA256SUMS.txt >/dev/null

# Generate the package-manager metadata from the same canonical assets and
# verify that Scoop's future-update URL preserves the platform segment of the
# installer filename. A missing `_windows_` here makes `scoop update` fetch a
# non-existent release asset even though first-time installation works.
node "$repo_root/scripts/generate-package-manifests.mjs" 2.4.3-alpha "$workspace" >/dev/null
jq -e '.autoupdate.architecture["64bit"].url | contains("_windows_x64-setup.exe")' \
  packaging/nova-download-manager.json >/dev/null
rm -rf packaging

manifest_assets=$(awk '{print $2}' SHA256SUMS.txt | sort)
release_assets=$(find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -printf '%f\n' | sort)
if ! diff -u <(printf '%s\n' "$release_assets") <(printf '%s\n' "$manifest_assets"); then
  echo 'SHA-256 manifest does not enumerate the canonical release assets exactly.' >&2
  exit 1
fi

printf 'Release asset naming and SHA-256 manifest policy verified.\n'
