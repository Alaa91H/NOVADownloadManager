import { readFile } from 'node:fs/promises';
import { assert, rel, walkFiles } from './checks-common.js';

const files = await walkFiles('.', (path) => /\.(ts|tsx|js|mjs|cjs|json|html)$/.test(path));
const violations: string[] = [];

function shouldScan(name: string): boolean {
  if (name.startsWith('docs/') || name.startsWith('tests/') || name.startsWith('src/tests/')) return false;
  if (name.includes('__tests__')) return false;
  if (name.startsWith('contracts/')) return false;
  if (name.startsWith('tools/') || name.startsWith('scripts/')) return false;
  if (name.startsWith('README')) return false;
  return true;
}

for (const file of files) {
  const text = await readFile(file, 'utf8');
  const name = rel(file);
  if (!shouldScan(name)) continue;
  if (/\beval\s*\(/.test(text)) violations.push(`${name}: dynamic code execution is not allowed.`);
  if (/new\s+Function\s*\(/.test(text)) violations.push(`${name}: Function constructor is not allowed.`);
  if (/unsafe-(?:eval|inline)/i.test(text)) violations.push(`${name}: unsafe CSP token found.`);
  if (/https?:\/\/(?!127\.0\.0\.1|localhost|i\.ytimg\.com)/i.test(text)) violations.push(`${name}: remote HTTP(S) literal found outside documentation/tooling.`);
}

assert(violations.length === 0, `Production guard failed:\n${violations.join('\n')}`);
console.log('Production guard passed: extension runtime source has no remote-code, unsafe CSP, or eval patterns.');
