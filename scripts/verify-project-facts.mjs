import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const failures = [];

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}
function requireExists(relativePath, label) {
  if (!existsSync(resolve(ROOT, relativePath))) failures.push(`${label}: missing ${relativePath}`);
}
function requireMissing(relativePath, label) {
  if (existsSync(resolve(ROOT, relativePath))) failures.push(`${label}: retired path still exists: ${relativePath}`);
}
function requireContains(relativePath, expected, label) {
  requireExists(relativePath, label);
  if (existsSync(resolve(ROOT, relativePath)) && !read(relativePath).includes(expected)) {
    failures.push(`${label}: ${relativePath} missing ${JSON.stringify(expected)}`);
  }
}

requireExists('desktop-native/CMakeLists.txt', 'Qt desktop project');
requireExists('desktop-native/qml/Main.qml', 'Qt desktop shell');
requireExists('src-tauri/src/bin/nova-native-backend.rs', 'Rust daemon binary');
requireExists('src-tauri/src/bin/nova-native-host.rs', 'Native Messaging host');
requireExists('browser-extension/src/manifest.json', 'browser extension');

for (const retired of [
  'src',
  'index.html',
  'vite.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'src-tauri/tauri.conf.json',
  'src-tauri/src/main.rs',
  'src-tauri/capabilities',
  'src-tauri/windows',
]) {
  requireMissing(retired, 'legacy desktop removal');
}

requireContains('desktop-native/CMakeLists.txt', 'find_package(Qt6 6.8', 'Qt 6.8 baseline');
requireContains('desktop-native/qml/Main.qml', 'Qt.FramelessWindowHint', 'approved Qt shell');
requireContains('src-tauri/Cargo.toml', 'panic = "unwind"', 'Rust release panic strategy');
requireContains('src-tauri/Cargo.toml', 'overflow-checks = true', 'Rust release overflow checks');

const cargo = read('src-tauri/Cargo.toml');
for (const retiredDependency of ['tauri =', 'tauri-build', 'tauri-plugin-']) {
  if (cargo.includes(retiredDependency)) {
    failures.push(`Rust runtime still contains retired Tauri dependency: ${retiredDependency}`);
  }
}

const packageJson = JSON.parse(read('package.json'));
if (Object.keys(packageJson.dependencies ?? {}).length !== 0) {
  failures.push('Root package must not contain desktop web runtime dependencies.');
}

if (failures.length > 0) {
  console.error('[facts:verify] Native desktop facts are inconsistent:');
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('[facts:verify] Qt/QML is the sole desktop UI; Tauri/React desktop paths are absent.');
