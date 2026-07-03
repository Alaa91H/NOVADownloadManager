import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  run('daemon'),
  run('dev')
];

let shuttingDown = false;

function stopAll(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

for (const child of children) {
  child.on('exit', code => {
    if (!shuttingDown && code && code !== 0) {
      stopAll(code);
    }
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

function run(script) {
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : npm;
  const args = process.platform === 'win32'
    ? ['/d', '/c', `${npm} run ${script}`]
    : ['run', script];

  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', chunk => process.stdout.write(`[${script}] ${chunk}`));
  child.stderr.on('data', chunk => process.stderr.write(`[${script}] ${chunk}`));
  return child;
}
