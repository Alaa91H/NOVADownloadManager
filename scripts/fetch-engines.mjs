import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = resolve(ROOT, 'bin');
const MANIFEST_PATH = join(BIN_DIR, '.bin-manifest.json');
const TMP_DIR = join(BIN_DIR, '.tmp');

const ENGINE_SOURCES = {
  curl: {
    repo: 'curl/curl',
    binary: process.platform === 'win32' ? 'curl.exe' : 'curl',
    env: 'NOVA_CURL',
    source: 'https://github.com/curl/curl',
  },
  'yt-dlp': {
    repo: 'yt-dlp/yt-dlp',
    binary: process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
    env: 'NOVA_YTDLP',
    source: 'https://github.com/yt-dlp/yt-dlp',
  },
  ffmpeg: {
    binary: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    env: 'NOVA_FFMPEG',
    source: 'https://ffmpeg.org/',
  },
};

function githubApiHeaders() {
  const headers = {
    'User-Agent': 'NOVA-Builder/2.0',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
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
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
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
    const req = get(url, { headers: githubApiHeaders() }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        rmSync(destPath, { force: true });
        downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (err) => { file.close(); reject(err); });
    req.setTimeout(180000, () => { req.destroy(); file.close(); reject(new Error('Download timed out')); });
  });
}

function run(command, args, label, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error.message);
    throw new Error(`${label} failed`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}


function commandPath(command) {
  const probeCommand = process.platform === 'win32' ? 'where' : 'command';
  const probeArgs = process.platform === 'win32' ? [command] : ['-v', command];
  const probe = spawnSync(probeCommand, probeArgs, { encoding: 'utf8', windowsHide: true, shell: process.platform !== 'win32' });
  if (probe.status !== 0) return '';
  return probe.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function commandExists(command) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  return probe.status === 0;
}

function findFileRecursive(dir, filename) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(full, filename);
      if (found) return found;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
}

function findCurlSourceDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(full, 'CMakeLists.txt')) && existsSync(join(full, 'src', 'tool_main.c'))) {
        return full;
      }
      const found = findCurlSourceDir(full);
      if (found) return found;
    }
  }
  return null;
}

function extractZip(zipPath, outputDir) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path '${zipPath.replaceAll("'", "''")}' -DestinationPath '${outputDir.replaceAll("'", "''")}' -Force`], 'Extract zip');
    return;
  }
  run('unzip', ['-q', zipPath, '-d', outputDir], 'Extract zip');
}

function normalizeCurlTag(tag) {
  return tag.replace(/^curl-/, '').replaceAll('_', '.');
}

async function getLatestRelease(repo) {
  return await httpsGetJson(`https://api.github.com/repos/${repo}/releases/latest`);
}

function copyEnvBinary(engineName, source, manifestVersion) {
  const envPath = process.env[source.env];
  if (!envPath) return null;
  if (!existsSync(envPath)) {
    throw new Error(`${source.env} points to a missing file: ${envPath}`);
  }
  const dest = join(BIN_DIR, source.binary);
  copyFileSync(envPath, dest);
  console.log(`[fetch] ${engineName}: copied ${envPath}`);
  return { engine: engineName, version: manifestVersion || 'external', path: dest, source: envPath };
}

async function fetchCurl() {
  const source = ENGINE_SOURCES.curl;
  const release = await getLatestRelease(source.repo);
  const tag = release.tag_name || release.name;
  if (!tag) throw new Error('curl latest release has no tag');

  const envCopied = copyEnvBinary('curl', source, normalizeCurlTag(tag));
  if (envCopied) return envCopied;

  const dest = join(BIN_DIR, source.binary);
  const manifest = safeReadManifest();
  if (existsSync(dest) && manifest?.curl?.version === normalizeCurlTag(tag) && process.env.NOVA_FORCE_FETCH !== '1') {
    console.log(`[fetch] curl already current (${manifest.curl.version})`);
    return { engine: 'curl', version: manifest.curl.version, path: dest, source: source.source };
  }

  if (!commandExists('cmake')) {
    throw new Error('CMake is required to build the latest curl/curl release from source. Install CMake or set NOVA_CURL to an existing curl binary.');
  }

  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
  const archivePath = join(TMP_DIR, `${tag}.zip`);
  const sourceDir = join(TMP_DIR, 'curl-source');
  const buildDir = join(TMP_DIR, 'curl-build');

  console.log(`[fetch] curl: downloading ${tag} from curl/curl...`);
  await downloadFile(release.zipball_url || `https://github.com/curl/curl/archive/refs/tags/${tag}.zip`, archivePath);
  extractZip(archivePath, sourceDir);
  const extractedSource = findCurlSourceDir(sourceDir);
  if (!extractedSource) throw new Error('Could not locate extracted curl source tree');

  console.log('[fetch] curl: configuring CMake build...');
  const curlCmakeOptions = [
    '-S', extractedSource,
    '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_CURL_EXE=ON',
    '-DBUILD_LIBCURL_DOCS=OFF',
    '-DBUILD_MISC_DOCS=OFF',
    '-DBUILD_EXAMPLES=OFF',
    '-DBUILD_TESTING=OFF',
    '-DCURL_USE_LIBPSL=OFF',
    '-DCURL_ZLIB=OFF',
    '-DCURL_BROTLI=OFF',
    '-DCURL_ZSTD=OFF',
    '-DCURL_DISABLE_LDAP=ON',
    '-DCURL_DISABLE_LDAPS=ON',
    '-DCURL_DISABLE_DICT=ON',
    '-DCURL_DISABLE_GOPHER=ON',
    '-DCURL_DISABLE_IMAP=ON',
    '-DCURL_DISABLE_POP3=ON',
    '-DCURL_DISABLE_RTSP=ON',
    '-DCURL_DISABLE_SMB=ON',
    '-DCURL_DISABLE_SMTP=ON',
    '-DCURL_DISABLE_TELNET=ON',
    '-DCURL_DISABLE_TFTP=ON',
  ];
  if (process.platform === 'win32') {
    curlCmakeOptions.push('-DCURL_USE_SCHANNEL=ON', '-DCURL_USE_OPENSSL=OFF');
  }
  run('cmake', curlCmakeOptions, 'curl CMake configure');

  console.log('[fetch] curl: building executable...');
  run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'curl', '--parallel'], 'curl CMake build');

  const builtCurl = findFileRecursive(buildDir, source.binary);
  if (!builtCurl) throw new Error(`curl build completed but ${source.binary} was not found`);
  copyFileSync(builtCurl, dest);
  if (process.platform !== 'win32') {
    run('chmod', ['+x', dest], 'Mark curl executable');
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  return { engine: 'curl', version: normalizeCurlTag(tag), tag, path: dest, source: source.source };
}

async function fetchYtDlp() {
  const source = ENGINE_SOURCES['yt-dlp'];
  const dest = join(BIN_DIR, source.binary);
  const envCopied = copyEnvBinary('yt-dlp', source, 'external');
  if (envCopied) return envCopied;

  console.log('[fetch] yt-dlp: downloading latest executable...');
  const directUrl = process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  await downloadFile(directUrl, dest);
  if (process.platform !== 'win32') {
    run('chmod', ['+x', dest], 'Mark yt-dlp executable');
  }
  const version = spawnSync(dest, ['--version'], { windowsHide: true, encoding: 'utf8' }).stdout?.trim() || 'latest';
  return { engine: 'yt-dlp', version, path: dest, source: source.source };
}

async function fetchFfmpegOptional() {
  const source = ENGINE_SOURCES.ffmpeg;
  const envCopied = copyEnvBinary('ffmpeg', source, 'external');
  if (envCopied) return envCopied;

  if (process.env.NOVA_BUNDLE_SYSTEM_FFMPEG === '1') {
    const systemPath = commandPath('ffmpeg');
    if (systemPath && existsSync(systemPath)) {
      const dest = join(BIN_DIR, source.binary);
      copyFileSync(systemPath, dest);
      if (process.platform !== 'win32') {
        run('chmod', ['+x', dest], 'Mark ffmpeg executable');
      }
      const versionText = spawnSync(dest, ['-version'], { windowsHide: true, encoding: 'utf8' }).stdout?.split(/\r?\n/)[0] || 'system';
      return { engine: 'ffmpeg', version: versionText.replace(/^ffmpeg version\s+/i, '').split(/\s+/)[0], path: dest, source: systemPath };
    }
  }

  if (process.env.NOVA_REQUIRE_FFMPEG === '1') {
    throw new Error('FFmpeg is required for production media post-processing. Set NOVA_FFMPEG to a vetted ffmpeg binary or set NOVA_BUNDLE_SYSTEM_FFMPEG=1 after installing ffmpeg.');
  }

  console.log('[fetch] ffmpeg: not bundled. Set NOVA_FFMPEG to a vetted ffmpeg binary, or set NOVA_BUNDLE_SYSTEM_FFMPEG=1 to copy system ffmpeg.');
  return { engine: 'ffmpeg', version: 'system-or-missing', path: '', source: source.source, optional: true };
}

function safeReadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  const manifest = {};
  const results = [];

  for (const fetcher of [fetchCurl, fetchYtDlp, fetchFfmpegOptional]) {
    const result = await fetcher();
    results.push(result);
    manifest[result.engine] = {
      version: result.version,
      tag: result.tag,
      path: result.path,
      source: result.source,
      fetchedAt: new Date().toISOString(),
    };
    console.log(`[fetch] ✓ ${result.engine} ${result.version}`);
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[fetch] Manifest written to ${MANIFEST_PATH}`);
  console.log(`[fetch] Done: ${results.map((r) => `${r.engine}@${r.version}`).join(', ')}`);
}

main().catch((err) => {
  console.error(`[fetch] ${err.stack || err.message}`);
  process.exit(1);
});
