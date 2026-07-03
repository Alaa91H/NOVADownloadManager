import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { join, resolve } from 'node:path';

const BIN_DIR = resolve(process.cwd(), 'bin');
const MANIFEST_PATH = join(BIN_DIR, '.bin-manifest.json');

const ENGINE_SOURCES = {
  aria2: {
    repo: 'aria2/aria2',
    // aria2 releases: aria2-1.37.0-win-64bit-build1.zip (or .7z)
    assetPattern: /aria2-.*-win-64bit/i,
    extractBin: 'aria2c.exe',
  },
  'yt-dlp': {
    repo: 'yt-dlp/yt-dlp',
    assetPattern: /yt-dlp\.exe$/i,
    extractBin: 'yt-dlp.exe',
  },
};

function githubApiHeaders() {
  const headers = { 'User-Agent': 'NOVA-Builder/1.0' };
  // Authenticated requests avoid the low per-IP rate limit on shared CI runners.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: githubApiHeaders() }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Failed to parse JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const req = get(url, { headers: { 'User-Agent': 'NOVA-Builder/1.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close(); reject(new Error(`HTTP ${response.statusCode}`)); return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (err) => { file.close(); reject(err); });
    req.setTimeout(60000, () => { req.destroy(); file.close(); reject(new Error('Download timed out')); });
  });
}

async function findFileRecursive(dir, filename) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const found = await findFileRecursive(fullPath, filename);
        if (found) return found;
      } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
        return fullPath;
      }
    } catch {
      // Unreadable entry — keep scanning the rest.
    }
  }
  return null;
}

async function extractArchive(archivePath, outputDir, binaryName) {
  // Try 7-Zip first (common on GitHub Actions and many systems)
  const sevenZipPaths = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs\\7-Zip\\7z.exe'),
    '7z.exe',
  ];

  // 7z exits 0 even when a name filter matches nothing ("No files to process"),
  // so success is only what findFileRecursive can actually locate afterwards.
  const extracted = async () => (await findFileRecursive(outputDir, binaryName)) !== null;

  for (const sz of sevenZipPaths) {
    try {
      const result = spawnSync(sz, ['x', archivePath, `-o${outputDir}`, '-y', '-r', binaryName], {
        windowsHide: true, stdio: 'pipe', timeout: 30000,
      });
      if (result.status === 0 && await extracted()) return;
      // Try full extract
      const result2 = spawnSync(sz, ['x', archivePath, `-o${outputDir}`, '-y'], {
        windowsHide: true, stdio: 'pipe', timeout: 30000,
      });
      if (result2.status === 0 && await extracted()) return;
    } catch {
      // This 7-Zip candidate failed — try the next path or fallback.
    }
  }

  // Fallback: try PowerShell Expand-Archive (works for .zip)
  if (archivePath.endsWith('.zip')) {
    const psResult = spawnSync('powershell', [
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${outputDir}' -Force`,
    ], { windowsHide: true, stdio: 'pipe', timeout: 30000 });
    if (psResult.status === 0 && await extracted()) return;
  }

  throw new Error(`Failed to extract ${binaryName} from ${archivePath}: no suitable extractor found`);
}

async function fetchLatestRelease(engineName) {
  const source = ENGINE_SOURCES[engineName];
  if (!source) throw new Error(`Unknown engine: ${engineName}`);

  // Special case: yt-dlp has a direct download link
  if (engineName === 'yt-dlp') {
    const destPath = join(BIN_DIR, 'yt-dlp.exe');
    if (existsSync(destPath)) {
      const ver = spawnSync(destPath, ['--version'], { windowsHide: true, encoding: 'utf-8' }).stdout?.trim();
      console.log(`[fetch] yt-dlp already in bin/ (${ver || 'unknown version'})`);
      return { engine: engineName, version: ver || 'latest', path: destPath };
    }
    const directUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    console.log(`[fetch] Downloading yt-dlp.exe...`);
    await downloadFile(directUrl, destPath);
    const ver = spawnSync(destPath, ['--version'], { windowsHide: true, encoding: 'utf-8' }).stdout?.trim();
    return { engine: engineName, version: ver || 'latest', path: destPath };
  }

  const releasesUrl = `https://api.github.com/repos/${source.repo}/releases`;
  console.log(`[fetch] Checking latest release for ${engineName}...`);

  const releases = await httpsGetJson(releasesUrl);
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error(`No releases found for ${source.repo}`);
  }

  let release = releases.find((r) => !r.prerelease) || releases[0];
  const tagName = release.tag_name;
  const assets = release.assets || [];

  // Try to find a win-64bit asset (zip or 7z)
  let asset = assets.find((a) => source.assetPattern.test(a.name) && (a.name.endsWith('.zip') || a.name.endsWith('.7z')));
  if (!asset) {
    console.warn(`[fetch] No matching archive for ${engineName} in ${tagName}. Trying any Windows asset...`);
    asset = assets.find((a) => /win/i.test(a.name) && (a.name.endsWith('.zip') || a.name.endsWith('.7z')));
  }
  if (!asset) {
    console.warn(`[fetch] Assets available: ${assets.map(a => a.name).join(', ')}`);
    throw new Error(`Could not find a Windows x64 archive for ${engineName}`);
  }

  const destPath = join(BIN_DIR, source.extractBin);
  if (existsSync(destPath)) {
    console.log(`[fetch] ${source.extractBin} already exists in bin/`);
    return { engine: engineName, version: tagName, path: destPath };
  }

  console.log(`[fetch] Downloading ${asset.name} (${tagName})...`);
  const tempDir = join(BIN_DIR, '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const archivePath = join(tempDir, asset.name);
  await downloadFile(asset.browser_download_url, archivePath);

  const extractDir = join(tempDir, `${engineName}-extracted`);
  mkdirSync(extractDir, { recursive: true });

  await extractArchive(archivePath, extractDir, source.extractBin);

  const binPath = await findFileRecursive(extractDir, source.extractBin);
  if (!binPath) {
    throw new Error(`Could not find ${source.extractBin} in extracted archive`);
  }

  spawnSync('copy', ['/y', binPath, destPath], { shell: true, windowsHide: true });
  spawnSync('rmdir', ['/s', '/q', tempDir], { shell: true, windowsHide: true });

  return { engine: engineName, version: tagName, path: destPath };
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  const manifest = {};
  const missing = [];

  for (const engineName of Object.keys(ENGINE_SOURCES)) {
    try {
      const result = await fetchLatestRelease(engineName);
      manifest[engineName] = { version: result.version, path: result.path, fetchedAt: new Date().toISOString() };
      console.log(`[fetch] ✓ ${engineName} ${result.version}`);
    } catch (err) {
      console.error(`[fetch] ✗ ${engineName}: ${err.message}`);
      // Only fatal when the binary is absent entirely; a stale copy in bin/ still ships.
      if (!existsSync(join(BIN_DIR, ENGINE_SOURCES[engineName].extractBin))) {
        missing.push(engineName);
      }
    }
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[fetch] Manifest written to ${MANIFEST_PATH}`);

  if (missing.length > 0) {
    console.error(`[fetch] Missing engines after fetch: ${missing.join(', ')}. The installer would ship without them.`);
    process.exit(1);
  }
  console.log('[fetch] Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
