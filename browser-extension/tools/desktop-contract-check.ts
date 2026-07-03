import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { assert } from './checks-common.js';

const docPaths = ['docs/PROTOCOL.md', 'docs/ADM_DESKTOP_DEVELOPER_HANDOFF.md', 'docs/DESKTOP_RUNTIME_REQUIREMENTS.md'];

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

const required = [
  '/v1/ping',
  '/v1/pair/auto',
  '/v1/auth/check',
  '/v1/add',
  '/captures',
  'com.apex.downloadmanager',
  'protocolVersion',
  'single-instance',
  'Minimize to system tray',
  'Default: ON',
  'Link with NOVA',
];

const docsExist = docPaths.some((p) => existsSync(p));
if (docsExist) {
  const combined = `${await readOptional('docs/PROTOCOL.md')}\n${await readOptional('docs/ADM_DESKTOP_DEVELOPER_HANDOFF.md')}\n${await readOptional('docs/DESKTOP_RUNTIME_REQUIREMENTS.md')}`;
  for (const token of required) {
    if (!combined.includes(token)) console.warn(`[desktop-contract:docs] optional documentation is missing ${token}.`);
  }
}

const nativeManifest = await readFile('native-messaging/com.apex.downloadmanager.json', 'utf8').catch(() => '');
assert(nativeManifest.includes('com.apex.downloadmanager'), 'Native Messaging host manifest template is missing or invalid.');
assert(nativeManifest.includes('"type": "stdio"'), 'Native Messaging host manifest must use stdio.');
assert(nativeManifest.includes('allowed_origins'), 'Native Messaging host manifest must declare Chromium allowed_origins.');
assert(nativeManifest.includes('allowed_extensions'), 'Native Messaging host manifest must declare Firefox allowed_extensions.');

const nativeTransport = await readFile('src/transport/native-transport.ts', 'utf8');
assert(nativeTransport.includes("host = 'com.apex.downloadmanager'"), 'NativeTransport must target com.apex.downloadmanager.');

const protocolSchema = await readFile('contracts/adm.protocol.v4.schema.json', 'utf8');
assert(protocolSchema.includes('"protocolVersion"') && protocolSchema.includes('"const": 4'), 'NOVA protocol schema must pin protocolVersion 4.');

const protocolTs = await readFile('src/contracts/adm.protocol.v4.ts', 'utf8');
assert(protocolTs.includes('ADM_PROTOCOL_VERSION = 4'), 'TypeScript NOVA protocol contract must export version 4.');

console.log('Desktop bridge contract check passed: runtime contracts are validated; Markdown docs are advisory.');
