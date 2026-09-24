/*
 * Generates winget / Scoop / Homebrew package manifests for a tagged release.
 *
 * Usage: node scripts/generate-package-manifests.mjs <version> <releaseDir>
 *   <version>    release version without the leading v (e.g. 1.3.0)
 *   <releaseDir> directory containing the release assets + SHA256SUMS.txt
 *
 * Writes manifests into <releaseDir>/packaging/. The submission repos
 * (winget-pkgs, a Scoop bucket, a Homebrew tap) still need to receive these;
 * see packaging/README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'Alaa91H/NovaDownloadManager';
const PUBLISHER = 'NOVA';
const PRODUCT = 'Nova Download Manager';
const PACKAGE_ID = 'NOVA.DownloadManager';
const HOMEPAGE = `https://github.com/${REPO}`;

const [, , rawVersion, releaseDir] = process.argv;
if (!rawVersion || !releaseDir) {
  console.error('Usage: node scripts/generate-package-manifests.mjs <version> <releaseDir>');
  process.exit(1);
}
const version = rawVersion.replace(/^v/, '');
const tag = `v${version}`;
const base = `${HOMEPAGE}/releases/download/${tag}`;

// Map SHA256SUMS.txt (hash␠␠filename) into a lookup.
const sums = new Map();
const sumsPath = join(releaseDir, 'SHA256SUMS.txt');
if (existsSync(sumsPath)) {
  for (const line of readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
}

/** Find a release asset by suffix and return {name, sha256, url}. */
function asset(suffix) {
  const name = [...sums.keys()].find((f) => f.endsWith(suffix));
  if (!name) return null;
  return { name, sha256: sums.get(name), url: `${base}/${encodeURIComponent(name)}` };
}

function firstAsset(...suffixes) {
  for (const suffix of suffixes) {
    const found = asset(suffix);
    if (found) return found;
  }
  return null;
}

const legacyWinX64 = firstAsset('_windows_x64-setup.exe', '_x64-setup.exe');
const legacyWinArm64 = firstAsset('_windows_arm64-setup.exe', '_arm64-setup.exe');
const winX64User = firstAsset('_windows_x64-user-setup.exe', '_x64-user-setup.exe');
const winArm64User = firstAsset('_windows_arm64-user-setup.exe', '_arm64-user-setup.exe');
const winX64Machine =
  firstAsset('_windows_x64-machine-setup.exe', '_x64-machine-setup.exe') || legacyWinX64;
const winArm64Machine =
  firstAsset('_windows_arm64-machine-setup.exe', '_arm64-machine-setup.exe') || legacyWinArm64;
const scoopX64 = winX64User || winX64Machine;
const scoopArm64 = winArm64User || winArm64Machine;
const macX64 = asset('_x64.dmg');
const macArm64 = asset('_aarch64.dmg');

const outDir = join(releaseDir, 'packaging');
mkdirSync(outDir, { recursive: true });
const written = [];
function emit(name, content) {
  writeFileSync(join(outDir, name), content.trimStart());
  written.push(name);
}

// ── Scoop (prefer non-elevated per-user installers) ──
if (scoopX64) {
  const autoX64 = scoopX64.name.replace(version, '$version');
  const autoArm64 = scoopArm64?.name.replace(version, '$version');
  emit(
    'nova-download-manager.json',
    `
{
  "version": "${version}",
  "description": "Fast, modern, multi-engine download manager.",
  "homepage": "${HOMEPAGE}",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "${scoopX64.url}#/dl.exe",
      "hash": "${scoopX64.sha256}"
    }${
      scoopArm64
        ? `,\n    "arm64": {\n      "url": "${scoopArm64.url}#/dl.exe",\n      "hash": "${scoopArm64.sha256}"\n    }`
        : ''
    }
  },
  "innosetup": false,
  "installer": { "args": ["/S"] },
  "uninstaller": { "args": ["/S"] },
  "checkver": { "github": "${HOMEPAGE}" },
  "autoupdate": {
    "architecture": {
      "64bit": { "url": "${HOMEPAGE}/releases/download/v$version/${autoX64}#/dl.exe" }${
        autoArm64
          ? `,\n      "arm64": { "url": "${HOMEPAGE}/releases/download/v$version/${autoArm64}#/dl.exe" }`
          : ''
      }
    }
  }
}
`,
  );
}

// ── Homebrew cask (arm64 preferred, x64 fallback) ──
if (macArm64 || macX64) {
  const arm = macArm64 || macX64;
  const intel = macX64 || macArm64;
  emit(
    'nova-download-manager.rb',
    `
cask "nova-download-manager" do
  version "${version}"

  on_arm do
    sha256 "${arm.sha256}"
    url "${arm.url}"
  end
  on_intel do
    sha256 "${intel.sha256}"
    url "${intel.url}"
  end

  name "${PRODUCT}"
  desc "Fast, modern, multi-engine download manager"
  homepage "${HOMEPAGE}"

  app "${PRODUCT}.app"

  zap trash: [
    "~/Library/Application Support/com.nova.downloadmanager",
    "~/Library/Caches/com.nova.downloadmanager",
  ]
end
`,
  );
}

// ── winget (user + machine scopes) ──
const wingetInstallers = [
  { asset: winX64User, architecture: 'x64', scope: 'user' },
  { asset: winX64Machine, architecture: 'x64', scope: 'machine' },
  { asset: winArm64User, architecture: 'arm64', scope: 'user' },
  { asset: winArm64Machine, architecture: 'arm64', scope: 'machine' },
].filter((entry) => entry.asset);

if (wingetInstallers.length > 0) {
  const installerBlocks = wingetInstallers
    .map(
      ({ asset: installer, architecture, scope }) =>
        `- Architecture: ${architecture}\n` +
        `  Scope: ${scope}\n` +
        `  InstallerUrl: ${installer.url}\n` +
        `  InstallerSha256: ${installer.sha256.toUpperCase()}`,
    )
    .join('\n');

  emit(
    `${PACKAGE_ID}.installer.yaml`,
    `
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
InstallerType: nullsoft
InstallModes:
  - silent
  - silentWithProgress
Installers:
${installerBlocks}
ManifestType: installer
ManifestVersion: 1.6.0
`,
  );
  emit(
    `${PACKAGE_ID}.locale.en-US.yaml`,
    `
# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${PUBLISHER}
PackageName: ${PRODUCT}
License: MIT
ShortDescription: Fast, modern, multi-engine download manager.
PackageUrl: ${HOMEPAGE}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`,
  );
  emit(
    `${PACKAGE_ID}.yaml`,
    `
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`,
  );
}

console.log(`[packaging] wrote ${String(written.length)} manifest file(s) to ${outDir}:`);
for (const name of written) console.log(`  - ${name}`);
if (written.length === 0) {
  console.warn('[packaging] no installers found in SHA256SUMS.txt; nothing generated.');
}
