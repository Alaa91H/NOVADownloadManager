import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

function requireFile(relativePath) {
  if (!exists(relativePath)) fail.push(`${relativePath}: missing`);
}
function requireContains(relativePath, needle, label = needle) {
  requireFile(relativePath);
  if (exists(relativePath) && !read(relativePath).includes(needle)) fail.push(`${relativePath}: missing ${label}`);
}
function requireNotContains(relativePath, needle, label = needle) {
  requireFile(relativePath);
  if (exists(relativePath) && read(relativePath).includes(needle)) fail.push(`${relativePath}: contains forbidden ${label}`);
}

requireContains('src/App.tsx', '<EngineCapabilityProvider>', 'capability provider mount');
requireContains('src/capabilities/EngineCapabilityContext.tsx', 'sanitizeDirectOptions', 'direct option sanitizer');
requireContains('src/capabilities/EngineCapabilityContext.tsx', 'sanitizeMediaOptions', 'media option sanitizer');
requireContains('src/capabilities/EngineCapabilityContext.tsx', 'supportsDirectProtocol', 'direct protocol gate');
requireContains('src/capabilities/EngineCapabilityContext.tsx', 'supportsStreamCandidate', 'stream candidate gate');

const desktopScreens = [
  ['src/dialogs/download/AddDownloadDialog.tsx', ['useEngineCapabilities', 'sanitizeDirectOptions', 'directBlockedReason']],
  ['src/dialogs/download/BatchImportDialog.tsx', ['useEngineCapabilities', 'supportsDirectProtocol', 'sanitizeDirectOptions']],
  ['src/dialogs/download/YoutubeDownloadDialog.tsx', ['useEngineCapabilities', 'sanitizeMediaOptions', 'mediaBlockedReason']],
  ['src/dialogs/tasks/TaskPropertiesDialog.tsx', ['useEngineCapabilities', 'supportsDirectOption']],
];
for (const [file, needles] of desktopScreens) {
  for (const needle of needles) requireContains(file, needle);
}

requireNotContains('src/dialogs/download/YoutubeDownloadDialog.tsx', 'extraArgs:', 'raw yt-dlp extraArgs in outbound payload');
requireContains('browser-extension/src/bridge/bridge-manager.ts', 'protocolForCandidate', 'extension direct protocol gate');
requireContains('browser-extension/src/background/message-router.ts', 'selectedQualityFromUi', 'full quality object handoff');
requireContains('browser-extension/src/contracts/capabilities.schema.ts', 'directProtocols', 'daemon protocol contract');
requireFile('.github/dependabot.yml');
requireNotContains('.github/workflows/build.yml', 'browser-extension/.github', 'root workflow must not depend on nested extension workflow files');

if (exists('browser-extension/.github')) fail.push('browser-extension/.github: nested GitHub configuration is not allowed; use root .github/ or docs/extension/ci-templates/');
if (exists('browser-extension/.devcontainer')) fail.push('browser-extension/.devcontainer: devcontainer templates are centralized under docs/extension/ci-templates/');
if (exists('browser-extension/Dockerfile.ci')) fail.push('browser-extension/Dockerfile.ci: extension CI container template is centralized under docs/extension/ci-templates/');
requireContains('docs/extension/ci-templates/Dockerfile.ci', 'FROM node:24', 'extension reference CI container template');

for (const message of fail) console.error(`FAIL ${message}`);
if (fail.length > 0) process.exit(1);
console.log('Capability gating and repository unification audit passed.');
