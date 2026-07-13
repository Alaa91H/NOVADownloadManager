import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));
const fail = [];

function requireFile(file) {
  if (!exists(file)) fail.push(`${file}: missing`);
}
function requireContains(file, needle, description = needle) {
  const body = read(file);
  if (!body.includes(needle)) fail.push(`${file}: missing ${description}`);
}

requireFile('src-tauri/windows/hooks.nsi');
requireFile('src-tauri/windows/installer-header.bmp');
requireFile('src-tauri/windows/installer-sidebar.bmp');
requireContains('src-tauri/tauri.conf.json', 'installerHooks', 'NSIS hooks');
requireContains('src-tauri/tauri.conf.json', '"allowDowngrades": false', 'real downgrade protection');
requireContains('src-tauri/tauri.conf.json', 'headerImage', 'branded NSIS header');
requireContains('src-tauri/tauri.conf.json', 'sidebarImage', 'branded NSIS sidebar');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_BGCOLOR', 'dark NSIS Modern UI background');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_FONT "Segoe UI"', 'NSIS font definition (Segoe UI)');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_FONTSIZE', 'NSIS font size definition');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_WELCOMEFINISHPAGE_FONT', 'NSIS welcome/finish page font');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_WELCOMEFINISHPAGE_FONTSIZE', 'NSIS welcome/finish page font size');
requireContains('src-tauri/windows/hooks.nsi', 'NOVA_NSIS_ACCENT', 'accent color definition');
requireContains('src-tauri/windows/hooks.nsi', 'SemverCompare', 'upgrade version comparison in hooks');
requireContains(
  'src-tauri/windows/hooks.nsi',
  'MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight',
  'HiDPI NSIS header scaling',
);
requireContains(
  'src-tauri/windows/hooks.nsi',
  'MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight',
  'HiDPI NSIS sidebar scaling',
);
requireContains('.github/workflows/ci.yml', 'v0.1.0+${{ github.run_number }}', 'CI fallback SemVer build metadata');
requireContains('scripts/apply-version.mjs', 'lastNumericBuildPart', 'SemVer build metadata manifest normalization');
requireContains('browser-extension/wxt.config.ts', 'lastNumericBuildPart', 'WXT build metadata manifest normalization');
requireContains('src-tauri/windows/hooks.nsi', 'NovaResolveInstallMode', 'clean/maintenance install mode detection');
requireContains('src-tauri/windows/hooks.nsi', 'NovaStopOwnedProcesses', 'owned process shutdown');
requireContains('src-tauri/windows/hooks.nsi', 'StartsWith($$install', 'install-directory process guard');
requireContains('src-tauri/windows/hooks.nsi', 'NovaRemoveLegacyInstallArtifacts', 'legacy artifact cleanup');
requireContains('src-tauri/windows/hooks.nsi', 'NovaWriteInstallReceipt', 'install receipt');
requireContains('src-tauri/windows/hooks.nsi', 'NovaWriteWindowsIntegrationRegistry', 'Windows registry integration');
requireContains('src-tauri/windows/hooks.nsi', 'NoRepair', 'Apps & Features repair metadata');
requireContains('src-tauri/windows/hooks.nsi', 'QuietUninstallString', 'silent uninstall registry command');
requireContains('src-tauri/windows/hooks.nsi', 'ModifyPath', 'Apps & Features maintenance path');
requireContains('src-tauri/windows/hooks.nsi', 'NovaUnregisterNativeMessaging', 'native host registry cleanup');
requireContains(
  'src-tauri/windows/hooks.nsi',
  'DeleteRegKey SHCTX "Software\\Google\\Chrome\\NativeMessagingHosts\\${NOVA_NATIVE_HOST}"',
  'Chrome native host cleanup',
);
requireContains(
  'src-tauri/windows/hooks.nsi',
  'DeleteRegKey SHCTX "Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NOVA_NATIVE_HOST}"',
  'Edge native host cleanup',
);
requireContains('scripts/build-tauri-assets.mjs', 'copyBrowserExtensionIfPresent', 'bundled unpacked extension copy');
requireContains('src-tauri/src/main.rs', 'is_native_messaging_launch', 'native host launch detection');
requireContains('src-tauri/src/native_host.rs', 'read_native_message', 'native messaging stdio protocol');
requireContains(
  'scripts/build-tauri-assets.mjs',
  'generateNativeMessagingManifest',
  'native messaging manifest generation',
);
requireContains(
  '.github/workflows/ci.yml',
  'pnpm run extension:package',
  'extension build before installer packaging',
);
requireContains('README.md', 'Installer lifecycle', 'installer lifecycle documentation');

// Professional build quality gates
requireContains('.github/workflows/ci.yml', 'concurrency:', 'CI concurrency controls');
requireContains('.github/workflows/ci.yml', 'timeout-minutes:', 'CI job timeout limits');
requireContains('.github/workflows/ci.yml', 'SHA-256', 'release artifact checksums');
requireContains('.github/workflows/ci.yml', 'build-metadata.json', 'build metadata generation');
requireContains('.github/workflows/ci.yml', 'Build matrix summary', 'professional build matrix summary');
requireContains('src-tauri/Cargo.toml', 'panic = "abort"', 'release panic=abort optimization');
requireContains('src-tauri/Cargo.toml', 'codegen-units = 1', 'release single codegen unit');
requireContains('src-tauri/windows/hooks.nsi', 'NOVA_BUILD_ID', 'build ID in installer');
requireContains('src-tauri/windows/hooks.nsi', 'NOVA_BUILD_COMMIT', 'commit SHA in installer');
requireContains('src-tauri/windows/hooks.nsi', '/NOVA_REPAIR', 'repair mode support');
requireContains('src-tauri/windows/installer-template.nsi', 'OriginalFilename', 'installer PE version metadata');
requireContains('src-tauri/windows/installer-template.nsi', 'MUI_FINISHPAGE_TITLE', 'branded finish page title');
requireContains('src-tauri/windows/installer-template.nsi', 'MUI_FINISHPAGE_TEXT', 'branded finish page text');
requireContains('src-tauri/windows/installer-template.nsi', 'QuietUninstallString', 'silent uninstall registry');
requireContains('src-tauri/windows/installer-template.nsi', '"NoRepair" "0"', 'repair enabled in Add/Remove Programs');

// Maximum performance release profile
requireContains('src-tauri/Cargo.toml', 'lto = "fat"', 'release fat LTO');
requireContains('src-tauri/Cargo.toml', 'overflow-checks = false', 'release overflow checks disabled');
requireContains('src-tauri/Cargo.toml', '[profile.release.package."*"]', 'release package-level optimization');

if (fail.length) {
  for (const item of fail) console.error(`FAIL ${item}`);
  process.exit(1);
}
console.log('Installer lifecycle audit passed.');
