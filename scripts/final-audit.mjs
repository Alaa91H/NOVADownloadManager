import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));
const isTracked = (relativePath) => {
  try {
    const out = execSync(`git ls-files -- "${relativePath}"`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.toString().trim().length > 0;
  } catch {
    // Outside a git checkout we cannot prove tracking; fall back to presence.
    return exists(relativePath);
  }
};
const fail = [];
const warn = [];

function requireContains(file, needle, description = needle) {
  const body = read(file);
  if (!body.includes(needle)) fail.push(`${file}: missing ${description}`);
}

function requireNotExists(relativePath, reason) {
  if (exists(relativePath)) fail.push(`${relativePath}: should not be committed (${reason})`);
}

// For generated outputs that legitimately exist on disk after install/build,
// enforce that they are not committed to git rather than merely absent.
function requireNotTracked(relativePath, reason) {
  if (isTracked(relativePath)) fail.push(`${relativePath}: should not be committed (${reason})`);
}

function requireExists(relativePath, reason) {
  if (!exists(relativePath)) fail.push(`${relativePath}: required file is missing (${reason})`);
}

function requireJson(file) {
  try {
    JSON.parse(read(file));
  } catch (error) {
    fail.push(`${file}: invalid JSON: ${error.message}`);
  }
}

requireJson('package.json');
requireJson('browser-extension/package.json');
requireJson('src-tauri/tauri.conf.json');
requireNotExists('package-lock.json', 'pnpm is the canonical package manager');
requireNotExists('browser-extension/ts-errors.txt', 'generated diagnostic output');
requireNotExists('browser-extension/native-messaging/com.nova.browserextension.json', 'legacy native messaging host alias replaced by app identity');
requireNotTracked('node_modules', 'dependency install output');
requireNotTracked('dist', 'frontend build output');
requireNotTracked('browser-extension/dist', 'extension build output');
requireNotTracked('src-tauri/target/release/bundle', 'Tauri bundle output');

requireContains('package.json', '"packageManager": "pnpm@', 'pnpm packageManager pin');
requireContains('.github/dependabot.yml', 'package-ecosystem: "npm"', 'root Dependabot npm coverage');
requireContains('.github/dependabot.yml', 'directory: "/browser-extension"', 'Dependabot browser extension coverage');
requireContains('.github/dependabot.yml', 'package-ecosystem: "cargo"', 'Dependabot Cargo coverage');
requireContains('.github/dependabot.yml', 'package-ecosystem: "github-actions"', 'Dependabot GitHub Actions coverage');
requireContains('src/App.tsx', '<EngineCapabilityProvider>', 'desktop capability provider mount');
requireContains('src/capabilities/EngineCapabilityContext.tsx', 'sanitizeDirectOptions', 'desktop direct option sanitizer');
requireContains('src/capabilities/EngineCapabilityContext.tsx', 'sanitizeMediaOptions', 'desktop media option sanitizer');
requireNotExists('browser-extension/.github', 'executable CI lives only under root .github/');
requireNotExists('browser-extension/.devcontainer', 'devcontainer templates are centralized under docs/extension/ci-templates/');
requireNotExists('browser-extension/Dockerfile.ci', 'extension CI container template is centralized under docs/extension/ci-templates/');
requireNotExists('browser-extension/.gitignore', 'repository ignore policy is centralized at root .gitignore');
requireNotExists('browser-extension/.npmrc', 'package-manager policy is centralized at root .npmrc');
requireNotExists('browser-extension/.nvmrc', 'Node version policy is centralized at root .node-version');
requireNotExists('browser-extension/.prettierrc', 'formatting policy is centralized at root .prettierrc');
requireNotExists('browser-extension/.editorconfig', 'editor policy is centralized at root .editorconfig');
requireNotExists('browser-extension/.gitattributes', 'Git attributes are centralized at root .gitattributes');
requireNotExists('browser-extension/.env.example', 'environment examples are centralized at root .env.example');
requireNotExists('browser-extension/pnpm-workspace.yaml', 'workspace policy is centralized at root pnpm-workspace.yaml');
requireNotExists('browser-extension/pnpm-lock.yaml', 'dependency lockfile is centralized at root pnpm-lock.yaml');
requireNotExists('ENGINE_COMPATIBILITY.md', 'all documentation except root README lives under docs/');
requireNotExists('PRODUCT_FINALIZATION_REPORT.md', 'all documentation except root README lives under docs/');
requireNotExists('browser-extension/README.md', 'extension documentation is centralized under docs/extension/');
requireNotExists('browser-extension/docs', 'extension documentation is centralized under root docs/');
requireNotExists('browser-extension/store/chrome/listing.md', 'store listings are centralized under docs/release/store-listings/');
requireNotExists('browser-extension/store/edge/listing.md', 'store listings are centralized under docs/release/store-listings/');
requireNotExists('browser-extension/store/firefox/listing.md', 'store listings are centralized under docs/release/store-listings/');
requireExists('LICENSE', 'MIT license text required for redistribution');
requireExists('THIRD_PARTY_NOTICES.md', 'bundled curl/yt-dlp/FFmpeg license notices');
requireExists('SECURITY.md', 'security reporting policy');
requireExists('CONTRIBUTING.md', 'contributor guide');
requireExists('CHANGELOG.md', 'release changelog');
requireExists('CODE_OF_CONDUCT.md', 'community code of conduct');
requireContains('THIRD_PARTY_NOTICES.md', 'FFmpeg', 'FFmpeg license notice');
requireContains('README.md', '[LICENSE](LICENSE)', 'README links to the MIT license file');
requireContains('README.md', 'THIRD_PARTY_NOTICES.md', 'README links to third-party notices');
requireContains('scripts/build-tauri-assets.mjs', 'copyLegalNotices', 'installer stages legal notices into resources');
requireContains('README.md', 'https://ko-fi.com/alaa91h', 'Ko-fi support link');
requireContains('README.md', 'https://t.me/NOVADownloadManager', 'Telegram community link');
requireContains('README.md', 'The browser extension is a product submodule in source layout only', 'README repository centralization policy');
requireContains('pnpm-workspace.yaml', '  - browser-extension', 'browser extension is part of the unified pnpm workspace');
requireContains('.gitignore', 'browser-extension/.wxt/', 'root gitignore covers extension generated outputs');
requireContains('.gitignore', 'src-tauri/target/', 'root gitignore covers Tauri build output');
requireContains('docs/README.md', 'docs/architecture/ENGINE_COMPATIBILITY.md', 'centralized engine compatibility docs link');
requireContains('docs/README.md', 'docs/extension/README.md', 'centralized browser extension docs link');
requireContains('docs/extension/ci-templates/legacy-extension-ci.yml', 'NOVA Browser Extension Unified Pipeline', 'extension CI template archived under docs/extension/ci-templates');
requireContains('docs/extension/ci-templates/Dockerfile.ci', 'FROM node:24', 'extension reference CI container template remains pinned');
requireContains('docs/architecture/PROJECT_STRUCTURE.md', 'single CI and Dependabot control plane', 'unified project structure docs');
requireContains('docs/architecture/CAPABILITY_GATING.md', 'EngineCapabilityContext', 'capability gating docs');
requireContains('docs/maintenance/DEPENDABOT_AND_MAINTENANCE.md', '.github/dependabot.yml', 'dependabot maintenance docs');
requireContains('pnpm-workspace.yaml', 'engineStrict: true', 'strict Node/package-manager settings');
requireContains('.github/workflows/build.yml', 'pnpm install --frozen-lockfile', 'pnpm CI install');
requireContains('.github/workflows/build.yml', 'cargo check --manifest-path src-tauri/Cargo.toml', 'Rust compile gate');
requireContains('.github/workflows/build.yml', 'pnpm run extension:package', 'extension package gate in CI');
requireContains('.github/workflows/build.yml', 'pnpm --filter nova-browser-extension verify:offline', 'extension release gate in CI');
requireContains('.github/workflows/build.yml', 'pnpm --filter nova-browser-extension typecheck', 'extension TypeScript gate in CI');
requireContains('src-tauri/Cargo.toml', 'curl = { version = "0.4"', 'Rust libcurl binding');
requireContains('src-tauri/src/daemon/engine_capabilities.rs', 'validate_linked_libcurl_integrity', 'runtime libcurl integrity check');
requireContains('src-tauri/src/daemon/engine_capabilities.rs', 'directProtocols', 'linked libcurl protocol export');
requireContains('src-tauri/src/daemon/curl.rs', 'run_segmented_libcurl', 'libcurl multi segmented engine');
requireContains('src-tauri/src/daemon/curl.rs', 'run_generation', 'pause/resume generation guard');
requireContains('src-tauri/src/native_host.rs', 'run_native_messaging_host', 'native messaging host proxy');
requireContains('src-tauri/src/main.rs', 'is_native_messaging_launch', 'native messaging launch gate');
requireContains('src-tauri/src/daemon/mod.rs', '/v1/stream/add', 'browser stream add route');
requireContains('src-tauri/src/daemon/routes.rs', 'streamResolverReady', 'stream capability export');
requireContains('browser-extension/src/contracts/capabilities.schema.ts', 'directProtocols', 'extension direct protocol gating');
requireContains('browser-extension/src/contracts/messages.schema.ts', 'selectedQuality: StreamQualitySchema.optional()', 'quality object bridge message');
requireContains('browser-extension/src/background/message-router.ts', 'selectedQualityFromUi', 'quality object handoff');
requireContains('browser-extension/src/bridge/bridge-manager.ts', 'protocolForCandidate', 'extension protocol validation');
requireContains('browser-extension/src/security/handoff-policy.ts', "'ftp:'", 'FTP/FTPS policy allowance controlled by daemon capabilities');

requireContains('browser-extension/src/ui/styles/theme.css', 'Desktop design-system parity', 'extension desktop visual parity');
requireContains('browser-extension/tools/nova-extension-feature-parity-check.mjs', 'NOVA-Extension feature parity check', 'upstream feature parity checker');
requireContains('browser-extension/package.json', 'verify:nova-sync', 'extension feature parity script');
requireContains('browser-extension/src/transport/native-transport.ts', "host = 'com.nova.downloadmanager'", 'unified native messaging host');
requireContains('browser-extension/native-messaging/com.nova.downloadmanager.json', 'com.nova.downloadmanager', 'native messaging host manifest');
requireContains('src-tauri/tauri.conf.json', 'installer-header.bmp', 'NSIS branded header image');
requireContains('src-tauri/tauri.conf.json', 'installer-sidebar.bmp', 'NSIS branded sidebar image');
requireContains('src-tauri/windows/hooks.nsi', 'ModifyPath', 'NSIS repair/modify registry path');
requireContains('src-tauri/windows/hooks.nsi', 'NovaCacheMaintenanceInstaller', 'NSIS cached repair installer');
requireContains('scripts/build-tauri-assets.mjs', 'generateNativeMessagingManifest', 'native messaging manifest generator');

const workflow = read('.github/workflows/build.yml');
if (/\bnpm (ci|test|run)\b/.test(workflow)) fail.push('.github/workflows/build.yml: still contains npm workflow commands');
const lock = exists('src-tauri/Cargo.lock') ? read('src-tauri/Cargo.lock') : '';
if (lock && !/name = "curl"\n/.test(lock)) warn.push('src-tauri/Cargo.lock does not yet include curl/curl-sys; run cargo check in CI/local Rust environment to regenerate it.');

for (const message of fail) console.error(`FAIL ${message}`);
for (const message of warn) console.warn(`WARN ${message}`);
if (fail.length > 0) process.exit(1);
console.log(`Final source audit passed with ${warn.length} warning(s).`);
