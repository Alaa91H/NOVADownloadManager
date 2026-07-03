import { assert, readJsonFile, walkFiles } from './checks-common.js';

type Manifest = {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{ matches?: string[] }>;
};

async function findStoreManifest(): Promise<string> {
  const manifests = await walkFiles('.output', (path) => path.endsWith('manifest.json'));
  const chromium = manifests.find((path) => !path.includes('firefox')) ?? manifests[0];
  assert(chromium, 'No Chromium store manifest found under .output. Run pnpm build:store first.');
  return chromium;
}

const manifestPath = await findStoreManifest();
const manifest = await readJsonFile<Manifest>(manifestPath);
const permissions = new Set(manifest.permissions ?? []);
const optional = new Set(manifest.optional_permissions ?? []);
const hosts = new Set(manifest.host_permissions ?? []);
const optionalHosts = new Set(manifest.optional_host_permissions ?? []);

for (const sensitive of ['downloads', 'webRequest', 'tabs', 'scripting']) {
  assert(!permissions.has(sensitive), `Chromium store profile must keep ${sensitive} optional.`);
  assert(optional.has(sensitive), `Chromium store profile should expose ${sensitive} as optional when used.`);
}

assert(hosts.has('http://127.0.0.1/*'), 'Loopback host permission is required for NOVA bridge.');
assert(optionalHosts.has('<all_urls>') || optionalHosts.has('*://*/*'), 'Broad site access must be optional in store profile.');
console.log(`Store readiness check passed: ${manifestPath}`);
