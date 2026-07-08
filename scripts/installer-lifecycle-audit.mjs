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
requireContains('.github/workflows/build.yml', 'v0.1.0+${{ github.run_number }}', 'CI fallback SemVer build metadata');
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
  '.github/workflows/build.yml',
  'pnpm run extension:package',
  'extension build before installer packaging',
);
requireContains('README.md', 'Installer lifecycle', 'installer lifecycle documentation');

if (fail.length) {
  for (const item of fail) console.error(`FAIL ${item}`);
  process.exit(1);
}
console.log('Installer lifecycle audit passed.');
