#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const checks = [];
const strict = process.argv.includes('--strict');
const writeReport = process.argv.includes('--write-report');

function runCommand(command, args, options = {}) {
  if (process.platform === 'win32') {
    const executable = String(command).includes(' ') ? `"${String(command).replaceAll('"', '\\"')}"` : String(command);
    const commandLine = [executable, ...args.map((part) => String(part))].join(' ');
    return spawnSync(commandLine, {
      encoding: 'utf8',
      stdio: 'pipe',
      shell: true,
      ...options,
    });
  }

  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });
}

function runRaw(name, command, args, options = {}) {
  const started = Date.now();
  const result = runCommand(command, args, options);
  const durationMs = Date.now() - started;
  return {
    name,
    command: [command, ...args].join(' '),
    exitCode: result.status,
    durationMs,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function pushCheck(check) {
  checks.push(check);
  return check.status === 'passed';
}

function run(name, command, args, options = {}) {
  const result = runRaw(name, command, args, options);
  return pushCheck({
    ...result,
    status: result.exitCode === 0 ? 'passed' : 'failed',
  });
}

function recordBlocked(name, command, reason) {
  return pushCheck({
    name,
    command,
    status: strict ? 'failed' : 'blocked',
    exitCode: strict ? 1 : null,
    durationMs: 0,
    stdout: '',
    stderr: reason,
  });
}

function hasFile(path) {
  return fs.existsSync(path);
}

function parseMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version).trim());
  return match ? Number(match[1]) : Number.NaN;
}

function commandAvailable(command, args = ['--version']) {
  const result = runCommand(command, args);
  return result.status === 0;
}

function runPreflight() {
  const result = runRaw('production preflight', process.execPath, ['tools/preflight.mjs']);
  if (result.exitCode === 0) {
    return pushCheck({ ...result, status: 'passed' });
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (/Node v?\d+\.\d+\.\d+ is unsupported|Use Node >=24 <27/.test(output)) {
    return pushCheck({
      ...result,
      status: strict ? 'failed' : 'blocked',
      stderr: result.stderr || 'Current Node runtime does not satisfy package.json engines. Use Node >=24 <27.',
    });
  }

  return pushCheck({ ...result, status: 'failed' });
}

function runDependencyHeavyGates() {
  const nodeMajor = parseMajor(process.version);
  const hasSupportedNode = Number.isFinite(nodeMajor) && nodeMajor >= 24 && nodeMajor < 27;
  const hasNodeModules = hasFile('node_modules/.modules.yaml') || hasFile('node_modules/typescript');
  const hasPnpm = commandAvailable('pnpm');

  const heavyCommand = 'pnpm typecheck && pnpm lint && pnpm test && pnpm build:store && pnpm test:e2e';
  const blockers = [];
  if (!hasSupportedNode) blockers.push(`current Node is ${process.version}; required Node >=24 <27`);
  if (!hasPnpm) blockers.push('pnpm is unavailable; run corepack prepare pnpm@11.6.0 --activate');
  if (!hasNodeModules) blockers.push('node_modules is absent; run pnpm install --frozen-lockfile');

  if (blockers.length > 0) {
    recordBlocked('dependency-heavy production gates', heavyCommand, blockers.join('; '));
    return;
  }

  run('typecheck', 'pnpm', ['typecheck']);
  run('lint', 'pnpm', ['lint']);
  run('vitest', 'pnpm', ['test']);
  run('store build', 'pnpm', ['build:store']);
  run('playwright e2e', 'pnpm', ['test:e2e'], { env: { ...process.env, EXTENSION_UNPACKED_DIR: '.output/chrome-mv3' } });
}

runPreflight();
run('offline production audit', process.execPath, ['tools/offline-production-audit.mjs']);
run('release submission audit', process.execPath, ['tools/release-submission-audit.mjs']);

if (hasFile('tests')) {
  run('python regression tests', 'python', ['-m', 'pytest', 'tests/', '-q', '--tb=short']);
}

runDependencyHeavyGates();

const passed = checks.filter((check) => check.status === 'passed').length;
const blocked = checks.filter((check) => check.status === 'blocked').length;
const failed = checks.filter((check) => check.status === 'failed').length;
const executableChecks = checks.filter((check) => check.status !== 'blocked').length;
const executedScore = executableChecks === 0 ? 0 : Math.round((passed / executableChecks) * 100);
const totalScore = Math.round((passed / checks.length) * 100);

const markdown = [
  '# Final Production Signoff Report',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Node: ${process.version}`,
  `Strict mode: ${strict ? 'yes' : 'no'}`,
  '',
  '| Check | Status | Command |',
  '| --- | --- | --- |',
  ...checks.map((check) => `| ${check.name} | ${check.status} | \`${check.command}\` |`),
  '',
  `Passed: ${passed}`,
  `Blocked: ${blocked}`,
  `Failed: ${failed}`,
  `Executed-check score: ${executedScore}%`,
  `Total-gate score: ${totalScore}%`,
  '',
  blocked > 0
    ? 'Blocked gates are environmental, not hidden passes. Strict mode converts them to failures.'
    : 'No blocked gates.',
  '',
].join('\n');

console.log(markdown);

if (writeReport) {
  fs.mkdirSync('release-signoff', { recursive: true });
  fs.writeFileSync('release-signoff/final-production-signoff.md', markdown, 'utf8');
  fs.writeFileSync(
    'release-signoff/final-production-signoff.json',
    `${JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, strict, passed, blocked, failed, executedScore, totalScore, checks }, null, 2)}\n`,
    'utf8',
  );
}

if (failed > 0 || (strict && blocked > 0)) process.exit(1);
