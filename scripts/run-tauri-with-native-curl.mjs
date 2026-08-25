import { existsSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(ROOT, 'bin', 'native-curl-manifest.json');

if (!existsSync(manifestPath)) {
  console.error(
    '[tauri-build] native-curl-manifest.json not found. Run `pnpm run native-curl:build` first.',
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const required = ['prefix', 'version', 'tag', 'sourceSha256', 'pkgConfigPath'];
for (const field of required) {
  if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
    console.error(`[tauri-build] Native curl manifest has no valid ${field} value.`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  NOVA_LIBCURL_PREFIX: manifest.prefix,
  NOVA_EXPECT_LIBCURL_VERSION: manifest.version,
  NOVA_EXPECT_LIBCURL_TAG: manifest.tag,
  NOVA_EXPECT_LIBCURL_SHA256: manifest.sourceSha256,
  NOVA_EXPECT_LIBCURL_PROTOCOLS: (manifest.protocols || []).join(','),
  NOVA_EXPECT_LIBCURL_FEATURES: (manifest.features || []).join(','),
  NOVA_LIBCURL_FEATURE_PROFILE: manifest.featureProfile || 'maximum-stable',
  NOVA_LIBCURL_LINK_MODE: 'static-ci-built-from-curl-curl',
  PKG_CONFIG_PATH: [manifest.pkgConfigPath, process.env.PKG_CONFIG_PATH]
    .filter(Boolean)
    .join(delimiter),
  PKG_CONFIG_ALL_STATIC: '1',
  PKG_CONFIG_ALLOW_CROSS: '1',
};

if (process.platform !== 'win32') {
  env.PATH = [join(manifest.prefix, 'bin'), process.env.PATH].filter(Boolean).join(delimiter);
}

// linuxdeploy is distributed as an AppImage. Extracting it for the duration of
// the build keeps packaging deterministic on minimal CI and container images
// where the legacy FUSE runtime is intentionally absent.
if (process.platform === 'linux') {
  if (!env.APPIMAGE_EXTRACT_AND_RUN) {
    env.APPIMAGE_EXTRACT_AND_RUN = '1';
  }

  // A failed linuxdeploy invocation leaves its AppDir in place. The GTK plugin
  // is not idempotent over those generated symlinks, so start each packaging
  // attempt from a clean, generated-only AppImage staging directory.
  rmSync(join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'appimage'), {
    recursive: true,
    force: true,
  });
}

const result = spawnSync('tauri', ['build'], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[tauri-build] Unable to start Tauri: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
