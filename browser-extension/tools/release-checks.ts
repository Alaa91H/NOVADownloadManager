import { spawn } from 'node:child_process';

function run(command: string, args: string[], env: typeof process.env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'unknown'}`));
    });
    child.on('error', reject);
  });
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function resolveGithubTag(): string | undefined {
  const refName = process.env.GITHUB_REF_NAME ?? '';
  const refType = process.env.GITHUB_REF_TYPE ?? '';
  const ref = process.env.GITHUB_REF ?? '';
  if (refType === 'tag' && refName.startsWith('v')) return refName;
  if (ref.startsWith('refs/tags/v')) return ref.split('/').at(-1);
  return undefined;
}

function validateManifestVersion(raw: string): string {
  const [version = '', build = ''] = raw.trim().replace(/^v/, '').split('+', 2);
  if (!version) {
    throw new Error(
      `Invalid extension version: ${raw}. Use a Git tag like v1.2.3, v1.2.3.4, v1.2.3-beta.4, or v1.2.3+45.`,
    );
  }
  if (/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    const buildNumber = /^\d+\.\d+\.\d+$/.test(version)
      ? build
          .split('.')
          .filter((part) => /^\d+$/.test(part))
          .at(-1)
      : undefined;
    return buildNumber ? `${version}.${buildNumber}` : version;
  }

  const prerelease = /^(\d+)\.(\d+)\.(\d+)-([0-9A-Za-z][0-9A-Za-z.-]*)$/.exec(version);
  if (prerelease) {
    const major = prerelease[1]!;
    const minor = prerelease[2]!;
    const patch = prerelease[3]!;
    const prereleaseLabel = prerelease[4]!;
    const prereleaseNumber =
      prereleaseLabel
        .split('.')
        .filter((part) => /^\d+$/.test(part))
        .at(-1) ?? '0';
    return `${major}.${minor}.${patch}.${prereleaseNumber}`;
  }

  throw new Error(
    `Invalid extension version: ${raw}. Use a Git tag like v1.2.3, v1.2.3.4, v1.2.3-beta.4, or v1.2.3+45.`,
  );
}

const packageOnly = process.argv.includes('--package-only');
const versionArg = getArg('--version') ?? resolveGithubTag();
const env = { ...process.env };

if (versionArg) {
  const version = validateManifestVersion(versionArg);
  env.WXT_VERSION = version;
  console.log(`Using extension version from Git tag/override: ${version}`);
} else {
  console.log('No release tag supplied; using development manifest version from package.json.');
}

await run('pnpm', ['clean'], env);

if (!packageOnly) {
  await run('pnpm', ['ci:quick'], env);
}

await run('pnpm', ['package:all'], env);
await run('pnpm', ['release:artifacts'], env);
await run('pnpm', ['release:metadata'], env);
await run('pnpm', ['validate:manifests'], env);
await run('pnpm', ['package:hygiene'], env);
