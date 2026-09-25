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

requirePng('desktop-native/resources/icons/32x32.png', 32, 32);
requirePng('desktop-native/resources/icons/64x64.png', 64, 64);
requirePng('desktop-native/resources/icons/128x128.png', 128, 128);
requirePng('desktop-native/resources/icons/128x128@2x.png', 256, 256);
requirePng('desktop-native/resources/icons/icon.png', 1024, 1024);
requireIco('desktop-native/resources/icons/icon.ico', [16, 24, 32, 48, 64, 128, 256]);
requireIcns('desktop-native/resources/icons/icon.icns');
requireContains('desktop-native/CMakeLists.txt', 'resources/nova-native.rc', 'Windows Qt icon resource');
requireContains('desktop-native/CMakeLists.txt', 'MACOSX_BUNDLE_ICON_FILE "icon.icns"', 'macOS Qt icon resource');
requireContains('desktop-native/resources/nova-native.desktop', 'Icon=nova-download-manager', 'Linux Qt icon reference');

requirePng('browser-extension/public/icons/icon-16.png', 16, 16);
requirePng('browser-extension/public/icons/icon-32.png', 32, 32);
requirePng('browser-extension/public/icons/icon-48.png', 48, 48);
requirePng('browser-extension/public/icons/icon-128.png', 128, 128);
requirePng('browser-extension/public/icons/icon.png', 512, 512);
requirePng('browser-extension/public/icons/logo.png', 512, 512);
requireIco('browser-extension/public/icons/icon.ico', [16, 32, 48, 128]);

requirePng('android/app/src/main/res/mipmap-mdpi/ic_nova_launcher.png', 48, 48);
requirePng('android/app/src/main/res/mipmap-hdpi/ic_nova_launcher.png', 72, 72);
requirePng('android/app/src/main/res/mipmap-xhdpi/ic_nova_launcher.png', 96, 96);
requirePng('android/app/src/main/res/mipmap-xxhdpi/ic_nova_launcher.png', 144, 144);
requirePng('android/app/src/main/res/mipmap-xxxhdpi/ic_nova_launcher.png', 192, 192);
requireContains('android/app/src/main/AndroidManifest.xml', '@mipmap/ic_nova_launcher', 'Android primary launcher icon');

requireContains('browser-extension/wxt.config.ts', "16: 'icons/icon-16.png'", 'extension icon-16 reference');
requireContains('browser-extension/wxt.config.ts', "128: 'icons/icon-128.png'", 'extension icon-128 reference');
requireContains(
  'browser-extension/wxt.config.ts',
  "resources: ['icons/icon-48.png', 'icons/logo.png']",
  'extension web-accessible logo reference',
);

const artExts = new Set(['.png', '.ico', '.icns', '.bmp', '.webmanifest']);
const ignoredPrefixes = [
  'node_modules/',
  'dist/',
  'coverage/',
  'browser-extension/.output/',
  'browser-extension/dist/',
  'src-tauri/target/',
  'desktop-native/build/',
  'android/app/build/',
];
const artFiles = walk(ROOT)
  .map(normalized)
  .filter((path) => artExts.has(extname(path).toLowerCase()))
  .filter((path) => !ignoredPrefixes.some((prefix) => path.startsWith(prefix)));

const allowedPrefixes = [
  'branding/source/',
  'desktop-native/resources/icons/',
  'browser-extension/public/icons/',
  'android/app/src/main/res/mipmap-',
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
