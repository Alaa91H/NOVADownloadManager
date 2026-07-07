import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(ROOT, 'bin', 'native-curl-manifest.json');
if (!existsSync(manifestPath)) {
  console.error('native-curl-manifest.json not found. Run `pnpm run native-curl:build` first.');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const env = {
  NOVA_LIBCURL_PREFIX: manifest.prefix,
  NOVA_EXPECT_LIBCURL_VERSION: manifest.version,
  NOVA_EXPECT_LIBCURL_TAG: manifest.tag,
  NOVA_EXPECT_LIBCURL_SHA256: manifest.sourceSha256,
  NOVA_EXPECT_LIBCURL_PROTOCOLS: (manifest.protocols || []).join(','),
  NOVA_EXPECT_LIBCURL_FEATURES: (manifest.features || []).join(','),
  NOVA_LIBCURL_FEATURE_PROFILE: manifest.featureProfile || 'maximum-stable',
  NOVA_LIBCURL_LINK_MODE: 'static-ci-built-from-curl-curl',
  PKG_CONFIG_PATH: manifest.pkgConfigPath,
  PKG_CONFIG_ALL_STATIC: '1',
  PKG_CONFIG_ALLOW_CROSS: '1',
};
for (const [key, value] of Object.entries(env)) {
  console.log(`${key}=${value}`);
}
