import { readFile } from 'node:fs/promises';
import { assert, readJsonFile } from './checks-common.js';

type StaticManifest = {
  manifest_version?: number;
  permissions?: string[];
  host_permissions?: string[];
  content_security_policy?: { extension_pages?: string } | string;
};

const wxt = await readFile('wxt.config.ts', 'utf8');
const manifest = await readJsonFile<StaticManifest>('src/manifest.json');

const requiredCore = ['storage', 'contextMenus', 'nativeMessaging', 'alarms', 'notifications', 'activeTab'];
const optionalSensitive = ['downloads', 'webRequest', 'scripting', 'tabs'];

for (const permission of requiredCore) {
  assert(wxt.includes(`'${permission}'`) || wxt.includes(`"${permission}"`), `wxt.config.ts must list core permission ${permission}.`);
}

for (const permission of optionalSensitive) {
  assert(wxt.includes(`'${permission}'`) || wxt.includes(`"${permission}"`), `wxt.config.ts must list integration permission ${permission}.`);
}

assert(/permissions:\s*store\s*\?\s*corePermissions\s*:\s*\[\.\.\.corePermissions,\s*\.\.\.integrationPermissions\]/s.test(wxt), 'Store builds must keep sensitive integration permissions out of required permissions.');
assert(/optional_permissions:\s*store\s*\?\s*integrationPermissions\s*:\s*undefined/s.test(wxt), 'Store builds must expose integration permissions as optional.');
assert(/host_permissions:\s*store\s*\?\s*\['http:\/\/127\.0\.0\.1\/\*'\]\s*:\s*\['<all_urls>',\s*'http:\/\/127\.0\.0\.1\/\*'\]/s.test(wxt), 'Store builds must keep broad host access optional and require only loopback.');
assert(/optional_host_permissions:\s*store\s*\?\s*\['<all_urls>'\]/s.test(wxt), 'Store builds must declare <all_urls> as optional host access.');

assert(manifest.manifest_version === 3, 'src/manifest.json must remain MV3-compatible for NOVA-extension layout compatibility.');
const csp = typeof manifest.content_security_policy === 'string' ? manifest.content_security_policy : manifest.content_security_policy?.extension_pages ?? '';
assert(!/unsafe-inline|unsafe-eval/i.test(csp), 'src/manifest.json CSP must not contain unsafe-inline or unsafe-eval.');
assert(!/127\.0\.0\.1:\*/.test(csp) && !/localhost:\*/.test(csp), 'Loopback CSP must pin NOVA port 3199 and must not use wildcard ports.');
assert(csp.includes('http://127.0.0.1:3199') && csp.includes('ws://127.0.0.1:3199'), 'CSP must allow only the official NOVA loopback port for HTTP and WebSocket.');
assert((manifest.permissions ?? []).includes('activeTab'), 'src/manifest.json must keep activeTab for user-activated scans.');
assert((manifest.host_permissions ?? []).includes('http://127.0.0.1/*'), 'src/manifest.json must declare loopback bridge host permission.');

console.log('Manifest source policy passed: store permissions stay minimal and CSP remains strict.');
