import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(ROOT, 'bin', 'native-curl-manifest.json');
if (!existsSync(manifestPath)) throw new Error('Missing bin/native-curl-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const required = ['version', 'tag', 'sourceSha256', 'prefix', 'pkgConfigPath', 'staticLibrary', 'protocols', 'features'];
for (const key of required) {
  if (!manifest[key]) throw new Error(`Native curl manifest missing ${key}`);
}
if (!existsSync(manifest.prefix)) throw new Error(`Native curl prefix missing: ${manifest.prefix}`);
if (!existsSync(manifest.pkgConfigPath)) throw new Error(`pkg-config path missing: ${manifest.pkgConfigPath}`);
if (!existsSync(manifest.staticLibrary)) throw new Error(`Static libcurl missing: ${manifest.staticLibrary}`);
const protocols = new Set(manifest.protocols || []);
const features = new Set(manifest.features || []);
const profile = manifest.featureProfile || 'maximum-stable';
const requiredProtocols = profile === 'minimal' ? ['http', 'https'] : ['http', 'https', 'ftp', 'ftps'];
for (const protocol of requiredProtocols) {
  if (!protocols.has(protocol)) throw new Error(`Built libcurl is missing required protocol: ${protocol}`);
}
for (const feature of ['SSL', 'IPv6', 'Largefile']) {
  if (!features.has(feature)) throw new Error(`Built libcurl is missing required feature: ${feature}`);
}
if (profile !== 'minimal') {
  for (const feature of ['HTTP2']) {
    if (!features.has(feature)) {
      throw new Error(`Built libcurl is missing ${feature}. Install nghttp2/vcpkg dependencies or set NOVA_LIBCURL_FEATURE_PROFILE=minimal for development only.`);
    }
  }
  for (const compressionFeature of ['libz', 'brotli', 'zstd']) {
    if (!features.has(compressionFeature)) {
      throw new Error(`Built libcurl is missing ${compressionFeature}. Production profile requires compression support.`);
    }
  }
}
console.log(`[verify-native-curl] OK: libcurl ${manifest.version} (${manifest.tag}) protocols=${manifest.protocols.join(',')} features=${manifest.features.join(',')}`);
