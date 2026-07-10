import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'bin');
const TMP_DIR = join(BIN_DIR, `.tmp-native-curl-${process.pid}-${Date.now()}`);
const NATIVE_ROOT = join(ROOT, 'vendor', 'native', 'curl');
const PLATFORM_ID = `${process.platform}-${process.arch}`;
const PREFIX_DIR = join(NATIVE_ROOT, PLATFORM_ID);
const MANIFEST_PATH = join(BIN_DIR, 'native-curl-manifest.json');
const BIN_MANIFEST_PATH = join(BIN_DIR, '.bin-manifest.json');
const CURL_BINARY = process.platform === 'win32' ? 'curl.exe' : 'curl';
const CURL_REPO = 'curl/curl';

function githubHeaders() {
  const headers = {
    'User-Agent': 'NOVA-NativeCurlBuilder/1.0',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: githubHeaders() }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (error) { reject(new Error(`Could not parse JSON from ${url}: ${error.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
  });
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com', 'codeload.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com',
]);

function download(url, destination, redirectDepth = 0) {
  if (redirectDepth > 5) {
    return Promise.reject(new Error(`Too many redirects for ${url}`));
  }
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destination);
    const req = get(url, { headers: githubHeaders() }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        rmSync(destination, { force: true });
        try {
          const redirectUrl = new URL(res.headers.location, url);
          if (!ALLOWED_DOWNLOAD_HOSTS.has(redirectUrl.hostname)) {
            reject(new Error(`Redirect to non-allowed host: ${redirectUrl.hostname}`));
            return;
          }
        } catch {
          reject(new Error(`Invalid redirect URL: ${res.headers.location}`));
          return;
        }
        download(res.headers.location, destination, redirectDepth + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        rmSync(destination, { force: true });
        reject(new Error(`HTTP ${res.statusCode} while downloading ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (error) => { file.close(); rmSync(destination, { force: true }); reject(error); });
    req.setTimeout(300000, () => { req.destroy(); file.close(); reject(new Error(`Timed out: ${url}`)); });
  });
}

const executableCache = new Map();

// On Windows we must never route these tools through cmd.exe. Some CMake
// arguments (e.g. the -DCMAKE_MSVC_RUNTIME_LIBRARY generator expression
// `MultiThreaded$<$<CONFIG:Debug>:Debug>`) contain `<`/`>`, which cmd.exe treats
// as stream redirection and Node does not escape when `shell: true`. Instead we
// resolve the real executable path and spawn it directly (shell: false), so the
// arguments reach CreateProcess verbatim.
function resolveExecutable(command) {
  if (process.platform !== 'win32') return command;
  if (command.includes('/') || command.includes('\\') || command.toLowerCase().endsWith('.exe')) {
    return command;
  }
  if (executableCache.has(command)) return executableCache.get(command);
  let resolved = command;
  const lookup = spawnSync('where.exe', [command], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
  if (lookup.status === 0 && lookup.stdout) {
    const first = lookup.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    if (first) resolved = first;
  }
  executableCache.set(command, resolved);
  return resolved;
}

function run(command, args, label, cwd = ROOT, extraEnv = {}) {
  const result = spawnSync(resolveExecutable(command), args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
    shell: false,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    throw new Error(`${label} failed`);
  }
  return result;
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(resolveExecutable(command), args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true, shell: false });
  return result.status === 0;
}

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function removeTree(path, { required = true } = {}) {
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 12 : 3,
      retryDelay: process.platform === 'win32' ? 500 : 100,
    });
  } catch (error) {
    if (required) throw error;
    console.warn(`[native-curl] Warning: could not remove temporary directory ${path}: ${error.message}`);
  }
}

function normalizeCurlTag(tag) {
  return tag.replace(/^curl-/, '').replaceAll('_', '.');
}

function splitAfterLabel(text, label) {
  const line = text.split(/\r?\n/).find((item) => item.trim().startsWith(label));
  if (!line) return [];
  return line.replace(label, '').trim().split(/\s+/).filter(Boolean);
}

function runText(command, args, label, cwd = ROOT, extraEnv = {}) {
  const result = run(command, args, label, cwd, extraEnv);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function extractZip(zipPath, outputDir) {
  removeTree(outputDir);
  mkdirSync(outputDir, { recursive: true });
  if (process.platform === 'win32') {
    run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Path '${zipPath.replaceAll("'", "''")}' -DestinationPath '${outputDir.replaceAll("'", "''")}' -Force`,
    ], 'Extract curl source');
  } else {
    run('unzip', ['-q', zipPath, '-d', outputDir], 'Extract curl source');
  }
}

function findCurlSourceDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(full, 'CMakeLists.txt')) && existsSync(join(full, 'lib', 'curl_setup.h'))) {
        return full;
      }
      const nested = findCurlSourceDir(full);
      if (nested) return nested;
    }
  }
  return null;
}

function findFileRecursive(dir, predicate) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileRecursive(full, predicate);
      if (nested) return nested;
    } else if (predicate(full, entry.name)) {
      return full;
    }
  }
  return null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function writeMergedBinManifest(nativeManifest) {
  const existing = readJson(BIN_MANIFEST_PATH);
  existing.curl = {
    engine: 'curl',
    role: 'diagnostic-cli-and-yt-dlp-external-downloader',
    version: nativeManifest.version,
    tag: nativeManifest.tag,
    path: join(BIN_DIR, CURL_BINARY),
    source: nativeManifest.source,
    sourceSha256: nativeManifest.sourceSha256,
    linkedLibcurlPrefix: nativeManifest.prefix,
    fetchedAt: nativeManifest.builtAt,
  };
  writeFileSync(BIN_MANIFEST_PATH, JSON.stringify(existing, null, 2));
}

function writeEnvFiles(manifest) {
  const envLines = [
    `NOVA_LIBCURL_PREFIX=${manifest.prefix}`,
    `NOVA_EXPECT_LIBCURL_VERSION=${manifest.version}`,
    `NOVA_EXPECT_LIBCURL_TAG=${manifest.tag}`,
    `NOVA_EXPECT_LIBCURL_SHA256=${manifest.sourceSha256}`,
    `NOVA_EXPECT_LIBCURL_PROTOCOLS=${(manifest.protocols || []).join(',')}`,
    `NOVA_EXPECT_LIBCURL_FEATURES=${(manifest.features || []).join(',')}`,
    `NOVA_LIBCURL_FEATURE_PROFILE=${manifest.featureProfile || 'maximum-stable'}`,
    `NOVA_LIBCURL_LINK_MODE=static-ci-built-from-curl-curl`,
    `PKG_CONFIG_PATH=${manifest.pkgConfigPath}`,
    'PKG_CONFIG_ALL_STATIC=1',
    'PKG_CONFIG_ALLOW_CROSS=1',
  ];
  writeFileSync(join(BIN_DIR, 'native-curl.env'), `${envLines.join('\n')}\n`);
  const psLines = envLines.map((line) => {
    const [key, ...rest] = line.split('=');
    return `$env:${key} = '${rest.join('=').replaceAll("'", "''")}'`;
  });
  writeFileSync(join(BIN_DIR, 'native-curl.ps1'), `${psLines.join('\n')}\n`);
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });
  if (!commandExists('cmake')) {
    throw new Error('CMake is required to build production libcurl. Install CMake or use NOVA_NATIVE_CURL_OPTIONAL=1 for development only.');
  }
  if (process.platform !== 'win32' && !commandExists('unzip', ['-v'])) {
    throw new Error('unzip is required to extract curl source archives.');
  }

  const release = await httpsGetJson(`https://api.github.com/repos/${CURL_REPO}/releases/latest`);
  const tag = release.tag_name || release.name;
  if (!tag) throw new Error('curl/curl latest release did not include a tag');
  const version = normalizeCurlTag(tag);
  const requestedFeatureProfile = process.env.NOVA_LIBCURL_FEATURE_PROFILE || 'maximum-stable';
  const previous = readJson(MANIFEST_PATH);
  const force = process.env.NOVA_FORCE_NATIVE_CURL === '1' || process.env.NOVA_FORCE_FETCH === '1';
  if (!force && previous.version === version && previous.featureProfile === requestedFeatureProfile && previous.prefix && existsSync(previous.prefix) && Array.isArray(previous.protocols) && Array.isArray(previous.features)) {
    console.log(`[native-curl] Already built curl ${version} at ${previous.prefix}`);
    writeEnvFiles(previous);
    writeMergedBinManifest(previous);
    return;
  }

  removeTree(TMP_DIR);
  removeTree(PREFIX_DIR);
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(PREFIX_DIR, { recursive: true });

  const archivePath = join(TMP_DIR, `${tag}.zip`);
  const sourceRoot = join(TMP_DIR, 'src');
  const buildDir = join(TMP_DIR, 'build');
  const archiveUrl = release.zipball_url || `https://github.com/curl/curl/archive/refs/tags/${tag}.zip`;
  console.log(`[native-curl] Downloading ${tag} from ${CURL_REPO}...`);
  await download(archiveUrl, archivePath);
  const sourceSha = sha256(archivePath);
  const expectedSourceSha = process.env.NOVA_EXPECT_CURL_SOURCE_SHA256 || '';
  if (expectedSourceSha && expectedSourceSha.toLowerCase() !== sourceSha.toLowerCase()) {
    throw new Error(`curl source SHA-256 mismatch for ${tag}: expected ${expectedSourceSha}, got ${sourceSha}`);
  }
  extractZip(archivePath, sourceRoot);
  const sourceDir = findCurlSourceDir(sourceRoot);
  if (!sourceDir) throw new Error('Could not locate curl source tree after extraction');

  const featureProfile = requestedFeatureProfile;
  const enableCompression = featureProfile !== 'minimal' && process.env.NOVA_CURL_ENABLE_COMPRESSION !== '0';
  const enableHttp2 = featureProfile !== 'minimal' && process.env.NOVA_CURL_ENABLE_HTTP2 !== '0';
  const enableHttp3 = process.env.NOVA_CURL_ENABLE_HTTP3 === '1' || featureProfile === 'maximum-experimental';
  const enableSsh = featureProfile !== 'minimal' && process.env.NOVA_CURL_ENABLE_SSH !== '0';

  const cmakeOptions = [
    '-S', sourceDir,
    '-B', buildDir,
    `-DCMAKE_INSTALL_PREFIX=${PREFIX_DIR}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_CURL_EXE=ON',
    '-DBUILD_LIBCURL_DOCS=OFF',
    '-DBUILD_MISC_DOCS=OFF',
    '-DBUILD_EXAMPLES=OFF',
    '-DBUILD_TESTING=OFF',
    '-DCURL_DISABLE_LDAP=ON',
    '-DCURL_DISABLE_LDAPS=ON',
    '-DCURL_DISABLE_DICT=ON',
    '-DCURL_DISABLE_GOPHER=ON',
    '-DCURL_DISABLE_IMAP=ON',
    '-DCURL_DISABLE_POP3=ON',
    '-DCURL_DISABLE_RTSP=ON',
    '-DCURL_DISABLE_SMTP=ON',
    '-DCURL_DISABLE_TELNET=ON',
    '-DCURL_DISABLE_TFTP=ON',
    '-DCURL_DISABLE_MQTT=ON',
    '-DCURL_USE_LIBPSL=OFF',
  ];

  if (process.platform === 'win32') {
    cmakeOptions.push(
      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
      '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>',
      '-DCURL_USE_SCHANNEL=ON',
      '-DCURL_USE_OPENSSL=OFF',
      '-DCURL_CA_FALLBACK=ON'
    );
  } else if (process.platform === 'darwin') {
    cmakeOptions.push('-DCURL_USE_SECTRANSP=ON', '-DCURL_USE_OPENSSL=OFF');
  } else {
    cmakeOptions.push('-DCURL_USE_OPENSSL=ON');
  }

  cmakeOptions.push(enableCompression ? '-DCURL_ZLIB=ON' : '-DCURL_ZLIB=OFF');
  cmakeOptions.push(enableCompression ? '-DCURL_BROTLI=ON' : '-DCURL_BROTLI=OFF');
  cmakeOptions.push(enableCompression ? '-DCURL_ZSTD=ON' : '-DCURL_ZSTD=OFF');
  cmakeOptions.push(enableHttp2 ? '-DUSE_NGHTTP2=ON' : '-DUSE_NGHTTP2=OFF');
  if (enableHttp3) {
    cmakeOptions.push('-DUSE_NGTCP2=ON', '-DUSE_NGHTTP3=ON');
  } else {
    cmakeOptions.push('-DUSE_NGTCP2=OFF', '-DUSE_NGHTTP3=OFF');
  }
  cmakeOptions.push(enableSsh ? '-DCURL_USE_LIBSSH2=ON' : '-DCURL_USE_LIBSSH2=OFF');
  if (process.env.CMAKE_TOOLCHAIN_FILE) {
    cmakeOptions.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.CMAKE_TOOLCHAIN_FILE}`);
  }
  if (process.env.VCPKG_TARGET_TRIPLET) {
    cmakeOptions.push(`-DVCPKG_TARGET_TRIPLET=${process.env.VCPKG_TARGET_TRIPLET}`);
  }

  console.log('[native-curl] Configuring static libcurl...');
  run('cmake', cmakeOptions, 'Configure curl');
  console.log('[native-curl] Building libcurl and curl tool...');
  run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel'], 'Build curl');
  console.log('[native-curl] Installing libcurl prefix...');
  run('cmake', ['--install', buildDir, '--config', 'Release'], 'Install curl');

  const builtCurl = findFileRecursive(PREFIX_DIR, (_full, name) => name.toLowerCase() === CURL_BINARY.toLowerCase())
    || findFileRecursive(buildDir, (_full, name) => name.toLowerCase() === CURL_BINARY.toLowerCase());
  let builtCurlVersionOutput = '';
  let protocols = [];
  let features = [];
  if (builtCurl) {
    const packagedCurl = join(BIN_DIR, CURL_BINARY);
    copyFileSync(builtCurl, packagedCurl);
    if (process.platform !== 'win32') run('chmod', ['+x', packagedCurl], 'chmod curl');
    builtCurlVersionOutput = runText(packagedCurl, ['--version'], 'Inspect built curl');
    protocols = splitAfterLabel(builtCurlVersionOutput, 'Protocols:');
    features = splitAfterLabel(builtCurlVersionOutput, 'Features:');
  }

  const pcPath = findFileRecursive(PREFIX_DIR, (_full, name) => name === 'libcurl.pc');
  if (!pcPath) throw new Error(`libcurl.pc was not installed under ${PREFIX_DIR}; Cargo cannot be pinned through pkg-config.`);
  const libcurlLib = findFileRecursive(PREFIX_DIR, (_full, name) => /^libcurl\.(a|lib)$/i.test(name) || /^libcurl_a\.(lib)$/i.test(name));
  if (!libcurlLib) throw new Error(`Static libcurl library was not installed under ${PREFIX_DIR}.`);

  const manifest = {
    engine: 'libcurl',
    role: 'production-direct-download-core',
    source: 'https://github.com/curl/curl',
    repo: CURL_REPO,
    tag,
    version,
    archiveUrl,
    sourceSha256: sourceSha,
    featureProfile,
    protocols,
    features,
    curlVersionOutput: builtCurlVersionOutput,
    prefix: PREFIX_DIR,
    pkgConfigPath: dirname(pcPath),
    staticLibrary: libcurlLib,
    curlTool: builtCurl ? join(BIN_DIR, CURL_BINARY) : '',
    platform: process.platform,
    arch: process.arch,
    cmakeOptions,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  writeEnvFiles(manifest);
  writeMergedBinManifest(manifest);
  removeTree(TMP_DIR, { required: false });
  console.log(`[native-curl] Ready: libcurl ${version}`);
  console.log(`[native-curl] Export Cargo env from ${join(BIN_DIR, process.platform === 'win32' ? 'native-curl.ps1' : 'native-curl.env')}`);
}

main().catch((error) => {
  console.error(`[native-curl] ${error.stack || error.message}`);
  process.exit(1);
});
