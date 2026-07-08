import { readdir } from 'node:fs/promises';
import { assert, pathExists, readJsonFile } from './checks-common.js';

type Manifest = {
  manifest_version?: number;
  name?: string;
  version?: string;
  permissions?: string[];
  content_security_policy?: { extension_pages?: string } | string;
};

async function validateManifest(path: string): Promise<void> {
  assert(await pathExists(path), `${path} is missing. Run npm run build:zip or pnpm build:zip first.`);
  const manifest = await readJsonFile<Manifest>(path);
  assert(manifest.manifest_version === 3, `${path}: expected MV3 manifest.`);
  assert(typeof manifest.name === 'string' && manifest.name.length > 0, `${path}: missing extension name.`);
  assert(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version), `${path}: invalid extension version.`);
  const csp = typeof manifest.content_security_policy === 'string'
    ? manifest.content_security_policy
    : manifest.content_security_policy?.extension_pages ?? '';
  assert(!/unsafe-eval|unsafe-inline/i.test(csp), `${path}: CSP must not allow unsafe-eval or unsafe-inline.`);
}

await validateManifest('dist/chromium/manifest.json');
await validateManifest('dist/edge/manifest.json');
await validateManifest('dist/firefox/manifest.json');

assert(await pathExists('dist/packages'), 'dist/packages is missing.');
const packages = (await readdir('dist/packages')).filter((file) => /\.(zip|xpi|crx)$/.test(file) && !/sources?/i.test(file));
assert(packages.length === 3, `Expected exactly Chrome, Edge, and Firefox package archives under dist/packages, got ${packages.length}.`);
// Naming: Apex-Browser-Extension-<browser>-<version>.<ext>. Chrome ships .crx when
// signed, otherwise .zip; Edge ships .zip; Firefox ships .xpi (or .zip if conversion is skipped).
assert(packages.some((file) => /-chrome-[\d.]+\.(zip|crx)$/i.test(file)), 'Chrome package archive is missing.');
assert(packages.some((file) => /-edge-[\d.]+\.zip$/i.test(file)), 'Edge package archive is missing.');
assert(packages.some((file) => /-firefox-[\d.]+\.(zip|xpi)$/i.test(file)), 'Firefox package archive is missing.');
assert(packages.every((file) => !/sources?/i.test(file)), 'Release packages must not include source archives.');
if (await pathExists('dist/release-assets')) {
  const releaseAssets = (await readdir('dist/release-assets')).filter((file) => /\.(zip|xpi|crx)$/.test(file) && !/sources?/i.test(file));
  assert(releaseAssets.length === 3, `Expected exactly 3 browser archives under dist/release-assets, got ${releaseAssets.length}.`);
  assert(releaseAssets.some((file) => /-edge-[\d.]+\.zip$/i.test(file)), 'Release assets must contain an Edge browser package.');
  assert(releaseAssets.every((file) => !/sources?/i.test(file)), 'Release assets must not contain source archives.');
}
assert(await pathExists('dist/packages/release-manifest.json'), 'dist/packages/release-manifest.json is missing. Run pnpm release:metadata first.');
assert(await pathExists('dist/packages/SBOM.json'), 'dist/packages/SBOM.json is missing. Run pnpm release:metadata first.');
console.log(`Package validation passed with ${packages.length} archive(s).`);
