#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] ?? fallback) : fallback;
}
function env(name, fallback = '') {
  return (process.env[name] ?? fallback).trim();
}
function runGit(gitArgs) {
  const result = spawnSync('git', gitArgs, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function write(file, content) {
  fs.writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
}
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => fs.statSync(path.join(dir, file)).isFile()).sort();
}
function encodeAsset(file) {
  return file.split('/').map(encodeURIComponent).join('/');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}
function browserDownloadLabel(file) {
  const lower = file.toLowerCase();
  const ext = lower.endsWith('.xpi') ? 'XPI' : lower.endsWith('.crx') ? 'CRX' : 'ZIP';
  if (lower.includes('chrome')) return `Chrome ${ext}`;
  if (lower.includes('edge')) return `Edge ${ext}`;
  if (lower.includes('firefox')) return `Firefox ${ext}`;
  return `${file} ${ext}`;
}
function formatTelegramChangeLine(line) {
  const clean = String(line ?? '').replace(/^[-*]\s*/, '').trim();
  if (!clean) return '';
  const match = clean.match(/^(.*) \(([0-9a-f]{7,40})\)$/i);
  if (match) return `â€¢ ${escapeHtml(match[1].trim())} <code>${escapeHtml(match[2])}</code>`;
  return `â€¢ ${escapeHtml(clean)}`;
}
function previousTag(currentTag) {
  if (currentTag) {
    const prev = runGit(['describe', '--tags', '--abbrev=0', `${currentTag}^`]);
    if (prev) return prev;
  }
  return runGit(['describe', '--tags', '--abbrev=0', '--exclude', currentTag || '']) || '';
}
function changelogLines(currentTag) {
  const prev = previousTag(currentTag);
  const range = prev ? `${prev}..HEAD` : 'HEAD';
  const log = runGit(['log', '--no-merges', '--pretty=format:- %s (%h)', range]);
  return {
    previousTag: prev,
    range,
    lines: log ? log.split('\n').slice(0, 80) : ['- No commit log available in this checkout.'],
  };
}

const assetsDir = arg('--assets', env('RELEASE_ASSETS_DIR', 'release-assets'));
const outputDir = arg('--output', env('RELEASE_NOTES_OUTPUT_DIR', '.'));
const tag = env('RELEASE_TAG', env('GITHUB_REF_NAME', ''));
const version = env('EXT_VERSION', env('RELEASE_VERSION', 'unknown'));
const repository = env('GITHUB_REPOSITORY', env('RELEASE_REPOSITORY', 'unknown'));
const actor = env('GITHUB_ACTOR', env('RELEASE_ACTOR', 'unknown'));
const runUrl = env('GITHUB_RUN_URL', env('RELEASE_RUN_URL', ''));
const releaseUrl = env('RELEASE_URL', tag && repository !== 'unknown' ? `https://github.com/${repository}/releases/tag/${tag}` : runUrl);
const downloadBase = env('RELEASE_DOWNLOAD_BASE', tag && repository !== 'unknown' ? `https://github.com/${repository}/releases/download/${tag}` : '');

const manifest = readJson(path.join(assetsDir, 'release-manifest.json'), {});
const artifactNames = Array.isArray(manifest?.artifacts)
  ? manifest.artifacts.map((item) => item.file).filter(Boolean)
  : listFiles(assetsDir).filter((file) => /\.(zip|xpi|crx)$/.test(file));
const metadataNames = listFiles(assetsDir).filter((file) => ['release-manifest.json', 'CHANGELOG.md'].includes(file));
const { previousTag: prev, range, lines } = changelogLines(tag);

const artifactRows = artifactNames.map((file) => {
  const url = downloadBase ? `${downloadBase}/${encodeAsset(file)}` : releaseUrl || runUrl;
  return { file, url };
});
const metadataRows = metadataNames.map((file) => {
  const url = downloadBase ? `${downloadBase}/${encodeAsset(file)}` : releaseUrl || runUrl;
  return { file, url };
});

fs.mkdirSync(outputDir, { recursive: true });
const changelog = [
  '# Changelog',
  '',
  `Range: ${range}`,
  prev ? `Previous tag: ${prev}` : 'Previous tag: none detected',
  '',
  ...lines,
  '',
].join('\n');

const downloads = [
  '## Downloads',
  '',
  ...artifactRows.map(({ file, url }) => `- [${file}](${url})`),
  ...(metadataRows.length ? ['', '## Verification files', '', ...metadataRows.map(({ file, url }) => `- [${file}](${url})`)] : []),
  '',
].join('\n');

const body = [
  `# NOVA Download Manager Extension ${tag || version}`,
  '',
  `Extension manifest version: ${version}.`,
  `Repository: ${repository}.`,
  `Published by: ${actor}.`,
  '',
  downloads,
  '## Change log',
  '',
  ...lines,
  '',
  '## Integrity',
  '',
  'Use `release-manifest.json` from the release assets to verify downloaded package hashes.',
  '',
].join('\n');

const telegramChangeLines = lines.map(formatTelegramChangeLine).filter(Boolean).slice(0, 8);
const manifestAsset = metadataRows.find(({ file }) => file === 'release-manifest.json');
const notification = [
  'âœ… <b>NOVA Download Manager Extension</b>',
  '',
  'ðŸš€ <b>tag release published</b>',
  tag ? `ðŸ· <b>Tag:</b> <code>${escapeHtml(tag)}</code>` : `ðŸ· <b>Version:</b> <code>${escapeHtml(version)}</code>`,
  `ðŸ“¦ <b>Repository:</b> <code>${escapeHtml(repository)}</code>`,
  `ðŸ‘¤ <b>Actor:</b> ${escapeHtml(actor)}`,
  releaseUrl ? `ðŸ”— <a href="${escapeHtml(releaseUrl)}">Open GitHub Release</a>` : runUrl ? `ðŸ”— <a href="${escapeHtml(runUrl)}">Open workflow run</a>` : '',
  '',
  'â¬‡ï¸ <b>Downloads:</b>',
  ...artifactRows.map(({ file, url }) => `â€¢ <a href="${escapeHtml(url)}">${escapeHtml(browserDownloadLabel(file))}</a>`),
  manifestAsset ? `â€¢ <a href="${escapeHtml(manifestAsset.url)}">Release manifest</a>` : '',
  '',
  'ðŸ“ <b>Change log:</b>',
  ...(telegramChangeLines.length ? telegramChangeLines : ['â€¢ No changelog entries available.']),
].join('\n').replace(/\n{3,}/g, '\n\n').trim();

const bodyPath = path.join(outputDir, 'RELEASE_NOTES.md');
const changelogPath = path.join(outputDir, 'CHANGELOG.md');
const downloadsPath = path.join(outputDir, 'DOWNLOADS.md');
const notificationPath = path.join(outputDir, 'RELEASE_NOTIFICATION.txt');
const summaryPath = path.join(outputDir, 'release-notification.json');
write(bodyPath, body);
write(changelogPath, changelog);
write(downloadsPath, downloads);
write(notificationPath, notification);
write(summaryPath, JSON.stringify({ tag, version, repository, releaseUrl, runUrl, artifacts: artifactRows, metadata: metadataRows, changelogRange: range }, null, 2));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `body_path=${bodyPath}\nchangelog_path=${changelogPath}\ndownloads_path=${downloadsPath}\nnotification_path=${notificationPath}\nsummary_path=${summaryPath}\n`);
}

console.log(`Prepared release notes for ${artifactRows.length} browser artifact(s).`);
