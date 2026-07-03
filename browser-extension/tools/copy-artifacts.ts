import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyDir, ensureEmptyDir, findFiles, pathExists, readJson } from './fs-utils.js';
import { createCrx, resolveCrxPrivateKey } from './crx.js';

type BrowserPackageTarget = 'chrome' | 'edge' | 'firefox';

type Manifest = {
  manifest_version?: number;
  name?: string;
  browser_specific_settings?: unknown;
};

const allowNoPackages = process.argv.includes('--allow-no-packages');

// WXT emits "Apex-Browser-Extension-<browser>-<version>.zip" under .output.
function browserZipTarget(file: string): BrowserPackageTarget | null {
  const lower = file.toLowerCase();
  if (lower.includes('source')) return null;
  if (!lower.endsWith('.zip')) return null;
  if (lower.includes('-chrome-')) return 'chrome';
  if (lower.includes('-edge-')) return 'edge';
  if (lower.includes('-firefox-')) return 'firefox';
  return null;
}

// Final release archives carry the official per-store suffix.
function isBrowserArchive(file: string): boolean {
  const lower = file.toLowerCase();
  if (lower.includes('source')) return false;
  return /-(chrome|edge|firefox)-[\d.]+\.(zip|crx|xpi)$/.test(lower);
}

function isReleaseMetadata(file: string): boolean {
  return ['release-manifest.json', 'SHA256SUMS.txt', 'CHANGELOG.md', 'RELEASE_NOTES.md'].includes(file);
}

async function findBuildDir(kind: 'chromium' | 'firefox'): Promise<string | null> {
  if (!(await pathExists('.output'))) return null;
  const candidates = await findFiles('.output', (path) => path.endsWith('/manifest.json') || path.endsWith('\\manifest.json'));
  for (const manifestPath of candidates) {
    const manifest = await readJson<Manifest>(manifestPath);
    const normalized = manifestPath.replaceAll('\\', '/');
    const isFirefox = Boolean(manifest.browser_specific_settings) || normalized.includes('firefox');
    const isChromium = !isFirefox && (normalized.includes('chrome') || normalized.includes('chromium') || normalized.includes('edge'));
    if (kind === 'firefox' && isFirefox) return manifestPath.replace(/[\\/]manifest\.json$/, '');
    if (kind === 'chromium' && isChromium) return manifestPath.replace(/[\\/]manifest\.json$/, '');
  }
  return null;
}

async function createEdgeUnpackedFromChromium(): Promise<void> {
  if (!(await pathExists('dist/chromium/manifest.json'))) return;
  await copyDir('dist/chromium', 'dist/edge');
  const manifestPath = 'dist/edge/manifest.json';
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  manifest.name = 'NOVA Download Manager Extension for Edge';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('Prepared Edge unpacked build: dist/chromium -> dist/edge');
}

// Convert each browser zip to its official store format, writing into dist/packages.
//  - Firefox -> .xpi (a Firefox xpi is a plain zip, so the bytes are unchanged).
//  - Edge    -> .zip for Microsoft Edge Add-ons submission.
//  - Chrome  -> signed .crx when a signing key is available, otherwise plain .zip.
async function finalizePackages(): Promise<{ count: number; formats: string[] }> {
  await mkdir('dist/packages', { recursive: true });
  if (!(await pathExists('.output'))) return { count: 0, formats: [] };
  const privateKey = resolveCrxPrivateKey();
  const formats: string[] = [];
  const done = new Set<BrowserPackageTarget>();
  for (const file of await readdir('.output')) {
    const target = browserZipTarget(file);
    if (!target || done.has(target)) continue;
    const zipBytes = await readFile(join('.output', file));
    let outName = file;
    let outBytes: Buffer = zipBytes;
    if (target === 'firefox') {
      outName = file.replace(/\.zip$/i, '.xpi');
    } else if (target === 'chrome' && privateKey) {
      outName = file.replace(/\.zip$/i, '.crx');
      outBytes = createCrx(zipBytes, privateKey);
    }
    await writeFile(join('dist/packages', outName), outBytes);
    formats.push(outName);
    done.add(target);
  }
  return { count: done.size, formats };
}

await ensureEmptyDir('dist');
await mkdir('dist/packages', { recursive: true });

const chromiumDir = await findBuildDir('chromium');
const firefoxDir = await findBuildDir('firefox');

if (chromiumDir) {
  await copyDir(chromiumDir, 'dist/chromium');
  console.log(`Copied Chromium build: ${chromiumDir} -> dist/chromium`);
} else {
  console.warn('No Chromium manifest build directory found under .output. Run pnpm package:chrome or pnpm build:chrome first.');
}

if (firefoxDir) {
  await copyDir(firefoxDir, 'dist/firefox');
  console.log(`Copied Firefox build: ${firefoxDir} -> dist/firefox`);
} else {
  console.warn('No Firefox manifest build directory found under .output. Run pnpm package:firefox or pnpm build:firefox first.');
}

await createEdgeUnpackedFromChromium();

const { count: packageCount, formats } = await finalizePackages();
if (packageCount === 0 && !allowNoPackages) {
  throw new Error('No browser package archives found under .output. Run pnpm package:all first.');
}
if (packageCount > 0 && packageCount !== 3) {
  throw new Error(`Expected exactly 3 browser package archives, got ${packageCount}.`);
}

await ensureEmptyDir('dist/release-assets');
for (const file of await readdir('dist/packages')) {
  if (!isBrowserArchive(file) && !isReleaseMetadata(file)) continue;
  await copyFile(join('dist/packages', file), join('dist/release-assets', file));
}

console.log(`Prepared ${packageCount} package archive(s) in dist/packages and dist/release-assets${formats.length ? ` (${formats.join(', ')})` : ''}.`);
