import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

function fail(message) {
  failures.push(message);
}

function rootPath(path) {
  return join(ROOT, path);
}

function readText(path) {
  return readFileSync(rootPath(path), 'utf8');
}

function requireFile(path) {
  if (!existsSync(rootPath(path))) fail(`${path}: missing`);
}

function requireContains(path, needle, label = needle) {
  const body = readText(path);
  if (!body.includes(needle)) fail(`${path}: missing ${label}`);
}

function pngSize(path) {
  const data = readFileSync(rootPath(path));
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${path}: not a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function bmpSize(path) {
  const data = readFileSync(rootPath(path));
  if (data.length < 26 || data.toString('ascii', 0, 2) !== 'BM') throw new Error(`${path}: not a BMP`);
  return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
}

function icoSummary(path) {
  const data = readFileSync(rootPath(path));
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1)
    throw new Error(`${path}: not an ICO`);
  const count = data.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const offset = 6 + i * 16;
    sizes.push({
      width: data[offset] === 0 ? 256 : data[offset],
      height: data[offset + 1] === 0 ? 256 : data[offset + 1],
    });
  }
  return sizes;
}

function requirePng(path, width, height) {
  requireFile(path);
  if (!existsSync(rootPath(path))) return;
  const size = pngSize(path);
  if (size.width !== width || size.height !== height)
    fail(`${path}: expected ${width}x${height}, got ${size.width}x${size.height}`);
}

function requireBmp(path, width, height) {
  requireFile(path);
  if (!existsSync(rootPath(path))) return;
  const size = bmpSize(path);
  if (size.width !== width || size.height !== height)
    fail(`${path}: expected ${width}x${height}, got ${size.width}x${size.height}`);
}

function requireIco(path, expectedSizes) {
  requireFile(path);
  if (!existsSync(rootPath(path))) return;
  const sizes = icoSummary(path)
    .map((item) => item.width)
    .sort((a, b) => a - b);
  const expected = [...expectedSizes].sort((a, b) => a - b);
  if (sizes.join(',') !== expected.join(','))
    fail(`${path}: expected ICO frames ${expected.join(',')}, got ${sizes.join(',')}`);
}

function requireIcns(path) {
  requireFile(path);
  if (!existsSync(rootPath(path))) return;
  const data = readFileSync(rootPath(path));
  if (data.length < 8 || data.toString('ascii', 0, 4) !== 'icns') fail(`${path}: not an ICNS file`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function normalized(path) {
  return relative(ROOT, path).split(sep).join('/');
}

requirePng('branding/source/app-icon.png', 512, 512);
requirePng('branding/source/installer-banner.png', 2172, 724);
requirePng('branding/source/profile-logo.png', 1254, 1254);

requirePng('src/assets/logo.png', 512, 512);
requirePng('src-tauri/icons/32x32.png', 32, 32);
requirePng('src-tauri/icons/64x64.png', 64, 64);
requirePng('src-tauri/icons/128x128.png', 128, 128);
requirePng('src-tauri/icons/128x128@2x.png', 256, 256);
requirePng('src-tauri/icons/icon.png', 1024, 1024);
requireIco('src-tauri/icons/icon.ico', [16, 24, 32, 48, 64, 128, 256]);
requireIcns('src-tauri/icons/icon.icns');
requireBmp('src-tauri/windows/installer-header.bmp', 600, 228);
requireBmp('src-tauri/windows/installer-sidebar.bmp', 656, 1256);

requirePng('browser-extension/public/icons/icon-16.png', 16, 16);
requirePng('browser-extension/public/icons/icon-32.png', 32, 32);
requirePng('browser-extension/public/icons/icon-48.png', 48, 48);
requirePng('browser-extension/public/icons/icon-128.png', 128, 128);
requirePng('browser-extension/public/icons/icon.png', 512, 512);
requirePng('browser-extension/public/icons/logo.png', 512, 512);
requireIco('browser-extension/public/icons/icon.ico', [16, 32, 48, 128]);

requirePng('public/favicon-16x16.png', 16, 16);
requirePng('public/favicon-32x32.png', 32, 32);
requirePng('public/apple-touch-icon.png', 180, 180);
requirePng('public/android-chrome-192x192.png', 192, 192);
requirePng('public/android-chrome-512x512.png', 512, 512);
requireIco('public/favicon.ico', [16, 24, 32, 48, 64, 128, 256]);
requireIco('public/icon.ico', [16, 24, 32, 48, 64, 128, 256]);

const tauriConfig = JSON.parse(readText('src-tauri/tauri.conf.json'));
const bundleIcons = tauriConfig.bundle?.icon ?? [];
for (const icon of [
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.icns',
  'icons/icon.ico',
]) {
  if (!bundleIcons.includes(icon)) fail(`src-tauri/tauri.conf.json: bundle icon missing ${icon}`);
}
const nsis = tauriConfig.bundle?.windows?.nsis ?? {};
if (nsis.installerIcon !== 'icons/icon.ico') fail('src-tauri/tauri.conf.json: installerIcon must use icons/icon.ico');
if (nsis.uninstallerIcon !== 'icons/icon.ico')
  fail('src-tauri/tauri.conf.json: uninstallerIcon must use icons/icon.ico');
if (nsis.headerImage !== './windows/installer-header.bmp')
  fail('src-tauri/tauri.conf.json: headerImage must use installer-header.bmp');
if (nsis.sidebarImage !== './windows/installer-sidebar.bmp')
  fail('src-tauri/tauri.conf.json: sidebarImage must use installer-sidebar.bmp');
if (nsis.uninstallerHeaderImage !== './windows/installer-header.bmp')
  fail('src-tauri/tauri.conf.json: uninstallerHeaderImage must use installer-header.bmp');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_BGCOLOR', 'NSIS dark background theme');
requireContains('src-tauri/windows/hooks.nsi', 'MUI_TEXTCOLOR', 'NSIS dark text theme');
requireContains(
  'src-tauri/windows/hooks.nsi',
  'MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight',
  'NSIS HiDPI header scaling',
);
requireContains(
  'src-tauri/windows/hooks.nsi',
  'MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight',
  'NSIS HiDPI sidebar scaling',
);

requireContains(
  'src-tauri/src/lib.rs',
  'app.default_window_icon()',
  'default window icon lookup for tray/taskbar consistency',
);
requireContains('src-tauri/src/lib.rs', 'TrayIconBuilder::new()', 'tray icon builder');
requireContains('browser-extension/wxt.config.ts', "16: 'icons/icon-16.png'", 'extension icon-16 reference');
requireContains('browser-extension/wxt.config.ts', "128: 'icons/icon-128.png'", 'extension icon-128 reference');
requireContains(
  'browser-extension/wxt.config.ts',
  "resources: ['icons/icon-48.png', 'icons/logo.png']",
  'extension web-accessible logo reference',
);
requireContains('index.html', 'href="/favicon.ico"', 'web favicon reference');
requireContains('index.html', 'href="/site.webmanifest"', 'web manifest reference');

const artExts = new Set(['.png', '.ico', '.icns', '.bmp', '.webmanifest']);
const ignoredPrefixes = ['node_modules/', 'dist/', 'browser-extension/.output/', 'browser-extension/dist/', 'src-tauri/target/'];
const artFiles = walk(ROOT)
  .map(normalized)
  .filter((path) => artExts.has(extname(path).toLowerCase()))
  .filter((path) => !ignoredPrefixes.some((prefix) => path.startsWith(prefix)));

const allowedPrefixes = [
  'branding/source/',
  'public/',
  'src/assets/',
  'src-tauri/icons/',
  'src-tauri/windows/',
  'browser-extension/public/icons/',
];
const unexpected = artFiles.filter((path) => !allowedPrefixes.some((prefix) => path.startsWith(prefix)));
if (unexpected.length)
  fail(
    `Unexpected artwork files outside managed branding paths:\n${unexpected.map((path) => `  - ${path}`).join('\n')}`,
  );

if (failures.length) {
  for (const item of failures) console.error(`FAIL ${item}`);
  process.exit(1);
}

console.log(`Branding asset verification passed (${artFiles.length} managed artwork files).`);
