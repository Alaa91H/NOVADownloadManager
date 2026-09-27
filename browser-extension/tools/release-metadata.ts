import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathExists, readJsonFile, sha256, writeText } from './checks-common.js';

type PackageJson = { name?: string; version?: string };
type Manifest = { version?: string; name?: string };

if (!(await pathExists('dist/packages'))) {
  throw new Error('dist/packages is missing. Run npm run build:zip first.');
}

await mkdir('dist/release-assets', { recursive: true });

const packageJson = await readJsonFile<PackageJson>('package.json');
const manifest = await readJsonFile<Manifest>('dist/chromium/manifest.json');
const packageFiles = (await readdir('dist/packages')).filter((file) => /\.(zip|xpi|crx)$/.test(file)).sort();
const artifacts = await Promise.all(packageFiles.map(async (file) => ({ file, sha256: await sha256(join('dist/packages', file)) })));
const metadata = {
  name: packageJson.name,
  version: manifest.version ?? packageJson.version,
  generatedAt: new Date().toISOString(),
  supportedBrowsers: ['chrome', 'edge', 'firefox'],
  artifacts,
  outputLayout: ['dist/chromium', 'dist/edge', 'dist/firefox', 'dist/packages', 'dist/release-assets'],
};

const releaseManifest = `${JSON.stringify(metadata, null, 2)}\n`;
const changelog = [
  '# Changelog',
  '',
  `Generated: ${new Date().toISOString()}`,
  `Extension version: ${metadata.version ?? 'unknown'}`,
  '',
  '## Browser packages',
  '',
  ...artifacts.map((item) => `- ${item.file}`),
  '',
].join('\n');

for (const dir of ['dist/packages', 'dist/release-assets']) {
  await writeText(join(dir, 'release-manifest.json'), releaseManifest);
  await writeText(join(dir, 'CHANGELOG.md'), changelog);
}

console.log(`Release metadata generated for ${artifacts.length} artifact(s).`);
