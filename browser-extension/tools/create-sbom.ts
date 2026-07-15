import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists, sha256 } from './checks-common.js';

type PackageJson = {
  name?: string;
  version?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type Manifest = { name?: string; version?: string; manifest_version?: number; permissions?: string[]; optional_permissions?: string[]; host_permissions?: string[]; optional_host_permissions?: string[] };

function deps(packageJson: PackageJson, kind: 'runtime' | 'development'): Array<{ name: string; versionRange: string; scope: string }> {
  const source = kind === 'runtime' ? packageJson.dependencies ?? {} : packageJson.devDependencies ?? {};
  return Object.entries(source).sort(([a], [b]) => a.localeCompare(b)).map(([name, versionRange]) => ({ name, versionRange, scope: kind }));
}

async function artifactHashes(dir: string): Promise<Array<{ file: string; sha256: string }>> {
  if (!(await pathExists(dir))) return [];
  const files = (await readdir(dir)).filter((file) => /\.(zip|xpi|crx)$/.test(file)).sort();
  return Promise.all(files.map(async (file) => ({ file, sha256: await sha256(join(dir, file)) })));
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as PackageJson;
const manifestPath = await pathExists('dist/chromium/manifest.json') ? 'dist/chromium/manifest.json' : 'src/manifest.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
const sbom = {
  schema: 'nova-extension.sbom.v1',
  generatedAt: new Date().toISOString(),
  project: {
    name: packageJson.name,
    developmentVersion: packageJson.version,
    packageManager: packageJson.packageManager,
  },
  extension: {
    name: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifest_version,
    permissions: manifest.permissions ?? [],
    optionalPermissions: manifest.optional_permissions ?? [],
    hostPermissions: manifest.host_permissions ?? [],
    optionalHostPermissions: manifest.optional_host_permissions ?? [],
  },
  dependencies: [...deps(packageJson, 'runtime'), ...deps(packageJson, 'development')],
  artifacts: await artifactHashes('dist/packages'),
};

for (const dir of ['dist/packages', 'dist/release-assets']) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SBOM.json'), `${JSON.stringify(sbom, null, 2)}\n`);
}
console.log(`SBOM generated with ${sbom.dependencies.length} dependency record(s).`);
