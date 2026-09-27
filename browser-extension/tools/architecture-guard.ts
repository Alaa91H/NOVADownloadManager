import { readFile } from 'node:fs/promises';
import { assert, rel, walkFiles } from './checks-common.js';

const files = await walkFiles('src', (path) => /\.(ts|tsx|js)$/.test(path));
const violations: string[] = [];

function allowedNetworkBoundary(name: string): boolean {
  return name.startsWith('src/transport/') || name.startsWith('src/tests/') || name === 'src/background/tab-scanner.ts' || name === 'src/platforms/manifest-resolver.ts';
}

function allowedLoopbackLiteral(name: string): boolean {
  return allowedNetworkBoundary(name)
    || name === 'src/background/message-router.ts'
    || name === 'src/rules/permission-policy.ts'
    || name === 'src/security/permission-request-policy.ts'
    || name === 'src/manifest.json';
}

function allowedBridgeConsumer(name: string): boolean {
  return name.startsWith('src/background/') || name.startsWith('src/bridge/') || name.startsWith('src/outbox/') || name.startsWith('src/tests/');
}

for (const file of files) {
  const name = rel(file);
  const text = await readFile(file, 'utf8');

  if (!allowedNetworkBoundary(name)) {
    if (/\bfetch\s*\(/.test(text)) violations.push(`${name}: direct fetch is only allowed in src/transport.`);
    if (/new\s+WebSocket\s*\(/.test(text)) violations.push(`${name}: direct WebSocket construction is only allowed in src/transport.`);
    if (/new\s+EventSource\s*\(/.test(text)) violations.push(`${name}: direct EventSource construction is only allowed in src/transport.`);
  }

  if (!allowedLoopbackLiteral(name) && /http:\/\/127\.0\.0\.1|ws:\/\/127\.0\.0\.1/.test(text)) {
    violations.push(`${name}: loopback literals must stay behind TransportManager or explicit Open NOVA/permission boundaries.`);
  }

  if (!allowedBridgeConsumer(name) && /bridgeManager|new\s+BridgeManager\s*\(/.test(text)) {
    violations.push(`${name}: UI/content/capture code must not depend on BridgeManager directly.`);
  }

  if (!name.startsWith('src/transport/') && !name.startsWith('src/tests/') && /Authorization\s*[:=]|Bearer\s+\$\{/.test(text)) {
    violations.push(`${name}: authorization header construction must stay in transport adapters.`);
  }
}

assert(violations.length === 0, `Architecture guard failed:\n${violations.join('\n')}`);
console.log('Architecture guard passed: NOVA access remains behind BridgeManager/TransportManager boundaries.');
