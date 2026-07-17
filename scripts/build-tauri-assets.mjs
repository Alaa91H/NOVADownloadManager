import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_DIR = join(ROOT, 'src-tauri', 'resources');
const RESOURCE_BIN_DIR = join(RESOURCE_DIR, 'bin');
const CURL_BINARY = process.platform === 'win32' ? 'curl.exe' : 'curl';
const NATIVE_CURL_MANIFEST = 'native-curl-manifest.json';
const NATIVE_HOST_NAME = 'com.nova.downloadmanager';
const NATIVE_MESSAGING_DIR = join(RESOURCE_DIR, 'native-messaging');

// The browser extension is packaged separately for stores/releases. When a
// built unpacked output is present, we also bundle it into Tauri resources so
// the desktop app can open a matching local companion folder for manual
// Load-unpacked installation and diagnostics.

function run(command, args, label, cwd = ROOT) {
  const executable = process.platform === 'win32' && !extname(command) ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error.message);
    throw new Error(`${label} failed`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function copyIfExists(source, target) {
  if (existsSync(source)) {
    rmSync(target, { force: true });
    copyFileSync(source, target);
    return true;
  }
  return false;
}



function splitCsvEnv(name) {
  return String(process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function generateNativeMessagingManifest() {
  const extensionManifestPath = join(ROOT, 'browser-extension', 'src', 'manifest.json');
  const firefoxIds = new Set(splitCsvEnv('NOVA_FIREFOX_EXTENSION_IDS'));
  if (existsSync(extensionManifestPath)) {
    try {
      const extensionManifest = JSON.parse(readFileSync(extensionManifestPath, 'utf8'));
      const geckoId = extensionManifest?.browser_specific_settings?.gecko?.id;
      if (typeof geckoId === 'string' && geckoId.trim()) firefoxIds.add(geckoId.trim());
    } catch (error) {
      throw new Error(`Could not read extension manifest for native messaging metadata: ${error.message}`, { cause: error });
    }
  }

  const chromiumOrigins = splitCsvEnv('NOVA_CHROMIUM_EXTENSION_IDS')
    .map((id) =>
      id
        .replace(/^chrome-extension:\/\//, '')
        .replace(/\/$/, '')
        .trim(),
    )
    .filter((id) => /^[a-p]{32}$/.test(id))
    .map((id) => `chrome-extension://${id}/`);

  mkdirSync(NATIVE_MESSAGING_DIR, { recursive: true });
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'NOVA Download Manager Native Messaging Host',
    path: '__NOVA_NATIVE_HOST_PATH__',
    type: 'stdio',
    allowed_origins: chromiumOrigins,
    allowed_extensions: [...firefoxIds].sort(),
  };
  writeFileSync(join(NATIVE_MESSAGING_DIR, `${NATIVE_HOST_NAME}.json`), JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(
    join(NATIVE_MESSAGING_DIR, 'native-messaging-build.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        chromiumNativeMessaging: chromiumOrigins.length > 0,
        firefoxNativeMessaging: firefoxIds.size > 0,
        host: NATIVE_HOST_NAME,
        pathPatchedByInstaller: true,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`[tauri-assets] Generated native messaging manifest for ${NATIVE_HOST_NAME}`);
  return manifest;
}

function copyBrowserExtensionIfPresent() {
  // The user requested to stop bundling the browser extension in the installer
  // since it is built and distributed separately.
  const target = join(RESOURCE_DIR, 'browser-extension');
  rmSync(target, { recursive: true, force: true });
  return false;
}

function copyLegalNotices() {
  const notices = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
  for (const notice of notices) {
    const copied = copyIfExists(join(ROOT, notice), join(RESOURCE_DIR, notice));
    if (!copied) {
      throw new Error(
        `Required legal notice ${notice} is missing from the repository root; it must ship inside the installed application.`,
      );
    }
  }
  console.log('[tauri-assets] Staged LICENSE and THIRD_PARTY_NOTICES.md into installer resources');
}

async function main() {
  mkdirSync(RESOURCE_BIN_DIR, { recursive: true });

  console.log('[tauri-assets] Building frontend...');
  run(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], 'Vite build');

  copyLegalNotices();

  // Daemon is now compiled into the Tauri binary (Rust/axum) — no Node.js bundling needed.
  // yt-dlp and ffmpeg are external plugins discovered at runtime from PATH or
  // user-configured paths. They are NOT bundled in the installer.

  console.log('[tauri-assets] Preparing resources...');
  // The direct engine is the statically linked libcurl compiled into the Tauri
  // binary, so the standalone curl(.exe) tool is redundant and no longer bundled.
  rmSync(join(RESOURCE_BIN_DIR, CURL_BINARY), { force: true });
  copyIfExists(join(ROOT, 'bin', NATIVE_CURL_MANIFEST), join(RESOURCE_DIR, NATIVE_CURL_MANIFEST));
  rmSync(join(RESOURCE_BIN_DIR, 'aria2c.exe'), { force: true });

  const nativeMessagingManifest = generateNativeMessagingManifest();
  const browserExtensionBundled = copyBrowserExtensionIfPresent();

  // Fall back to the tag-stamped tauri.conf.json version (see apply-version.mjs)
  // so the resource manifest never drifts from the installer version.
  const stampedVersion = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;

  const manifest = {
    builtAt: new Date().toISOString(),
    version: process.env.VITE_APP_VERSION || process.env.BUILD_TAG || process.env.GITHUB_REF_NAME || stampedVersion,
    files: {
      directEngine: existsSync(join(RESOURCE_DIR, NATIVE_CURL_MANIFEST)) ? 'static-libcurl' : 'cargo-fallback',
      mediaEngine: false,
      postProcessor: false,
      nativeLibcurl: existsSync(join(RESOURCE_DIR, NATIVE_CURL_MANIFEST))
        ? 'static-ci-built-libcurl'
        : 'cargo-fallback',
      browserExtension: browserExtensionBundled ? 'bundled-unpacked-chrome-mv3' : 'github-releases',
      nativeMessaging: nativeMessagingManifest ? 'generated-manifest-with-installer-patched-path' : false,
    },
  };
  writeFileSync(join(RESOURCE_DIR, 'resource-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log('[tauri-assets] Ready.');
}

main().catch((error) => {
  console.error(`[tauri-assets] ${error.message}`);
  process.exit(1);
});
