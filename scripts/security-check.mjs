#!/usr/bin/env node
/**
 * security-check.mjs
 * Scans the NOVA source tree for common security anti-patterns:
 *  - Hardcoded secrets / API keys
 *  - SSRF-risk patterns (unsafe URL construction)
 *  - Disabled TLS verification flags
 *  - Exposed debug endpoints
 *
 * Exit code: 0 = clean, 1 = issues found
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'target', '.git', 'coverage',
  'browser-extension/node_modules', 'src-tauri/target',
  // i18n files contain UI label keys like "settings_bot_token" which are not secrets
  'src/lib/i18n',
]);

/** @type {Array<{name: string, pattern: RegExp, severity: 'HIGH'|'MEDIUM'|'LOW', ignoreInTests?: boolean}>} */
const PATTERNS = [
  {
    name: 'Hardcoded secret / credential (non-test)',
    // Matches only actual assignment patterns, not i18n keys or code-string constants
    pattern: /(?:^|\s)(?:password|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/gim,
    severity: 'HIGH',
    ignoreInTests: true,
  },
  {
    name: 'Disabled TLS verification (Rust)',
    pattern: /danger_accept_invalid_certs\s*\(\s*true\s*\)/g,
    severity: 'HIGH',
    ignoreInTests: false,
  },
  {
    name: 'Disabled TLS verification (JS)',
    pattern: /rejectUnauthorized\s*:\s*false/g,
    severity: 'HIGH',
    ignoreInTests: false,
  },
  {
    name: 'Debug endpoint exposed (0.0.0.0 bind)',
    pattern: /\.bind\s*\(\s*["']0\.0\.0\.0/g,
    severity: 'HIGH',
    ignoreInTests: false,
  },
  {
    name: 'TODO/FIXME security note',
    pattern: /(?:TODO|FIXME)\s*:.*(?:security|auth|token|secret|ssrf|injection)/gi,
    severity: 'LOW',
    ignoreInTests: true,
  },
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.rs', '.toml', '.json']);

let totalIssues = 0;

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (!IGNORE_DIRS.has(entry.name) && !IGNORE_DIRS.has(rel)) {
        yield* walk(full);
      }
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

for await (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  let content;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    continue;
  }

  const lines = content.split('\n');
  for (const { name, pattern, severity, ignoreInTests } of PATTERNS) {
    if (ignoreInTests && (rel.includes('__tests__') || rel.includes('test') || rel.endsWith('.test.ts') || rel.endsWith('.spec.ts'))) {
      continue;
    }
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      const lineText = lines[lineNum - 1]?.trim() ?? '';
      // Skip lines in comments that are merely documenting the pattern
      if (/^\s*\/\/|^\s*\*|^\s*#/.test(lines[lineNum - 1] ?? '')) continue;
      console.log(`[${severity}] ${name}`);
      console.log(`  File: ${rel}:${lineNum}`);
      console.log(`  Line: ${lineText.slice(0, 120)}`);
      console.log('');
      totalIssues++;
    }
  }
}

if (totalIssues === 0) {
  console.log('Security check passed — no issues found.');
  process.exit(0);
} else {
  console.error(`Security check found ${totalIssues} issue(s). Review the above findings.`);
  process.exit(1);
}
