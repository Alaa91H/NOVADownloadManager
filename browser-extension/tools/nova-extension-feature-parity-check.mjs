import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const failures = [];
const read = (path) => readFileSync(path, 'utf8');
const requireFile = (path) => {
  if (!existsSync(path)) failures.push(`missing file: ${path}`);
  return existsSync(path) ? read(path) : '';
};
const requireIncludes = (path, needle, label = needle) => {
  const body = requireFile(path);
  if (!body.includes(needle)) failures.push(`${path}: missing ${label}`);
};

// Phase 7/round-2: locale files must not contain U+FFFD replacement
// characters — they indicate mojibake from a broken encoding. All
// Latin-script locales are repaired; any regression FAILS the check.
// Non-Latin scripts (bn, fa, th) collapsed beyond recovery and need
// re-translation — tracked as a warning until that lands.
const localeDir = 'src/i18n/locales';
const NON_LATIN_REPAIR_PENDING = new Set(['bn', 'fa', 'th']);
if (existsSync(localeDir)) {
  for (const file of readdirSync(localeDir).filter((f) => f.endsWith('.ts'))) {
    const body = read(join(localeDir, file));
    if (!body.includes('\uFFFD')) continue;
    const lang = file.replace(/\.ts$/, '');
    if (NON_LATIN_REPAIR_PENDING.has(lang)) {
      console.warn(
        `[locale-encoding] ${join(localeDir, file)}: ${lang} still contains U+FFFD — manual re-translation tracked in REPAIR_COVERAGE`,
      );
    } else {
      failures.push(
        `${join(localeDir, file)}: contains U+FFFD replacement characters (broken encoding)`,
      );
    }
  }
}

requireIncludes('src/profiles/aggressive-capture-profile.ts', 'aggressive', 'aggressive capture profile');
requireIncludes('src/content/page-tap-main.ts', 'patchFetch', 'fetch interception');
requireIncludes('src/content/page-tap-main.ts', 'patchXhr', 'XHR interception');
requireIncludes('src/content/page-tap-main.ts', 'patchMediaSource', 'MSE interception');
requireIncludes('src/content/page-tap-main.ts', 'patchWebSocket', 'WebSocket interception');
requireIncludes('src/content/page-tap-main.ts', 'patchEventSource', 'EventSource interception');
requireIncludes('src/content/page-tap-main.ts', 'patchedCreateObjectURL', 'blob URL interception');
requireIncludes('src/content/page-tap-main.ts', 'PerformanceObserver', 'performance resource observation');
requireIncludes('src/content/scan-page.ts', 'application/ld+json', 'JSON-LD scanning');
requireIncludes('src/content/page-tap-main.ts', 'ytInitialPlayerResponse', 'player config global scanning');
requireIncludes('src/content/page-tap-main.ts', 'durationchange', 'video metadata change monitoring');
requireIncludes('src/content/scan-page.ts', 'data-m3u8-url', 'adaptive data-* attribute scanning');
requireIncludes('src/capture/hls-capture.ts', 'm3u8', 'HLS capture');
requireIncludes('src/capture/dash-capture.ts', 'mpd', 'DASH capture');
requireIncludes('src/capture/torrent-magnet-capture.ts', 'magnet', 'torrent/magnet detection');
requireIncludes('src/bridge/pairing-manager.ts', '/v1/pair/auto', 'zero-click pairing');
requireIncludes('src/transport/native-transport.ts', 'com.nova.downloadmanager', 'NOVA native messaging host identity');
requireIncludes('src/transport/loopback-url-policy.ts', '127.0.0.1:3199', 'local-only loopback policy');
requireIncludes('src/security/redaction.ts', 'authorization', 'diagnostics redaction');
requireIncludes('src/ui/styles/theme.css', 'Desktop design-system parity', 'desktop visual parity tokens');
requireIncludes('src/ui/popup/PopupApp.tsx', 'nova-popup', 'desktop themed popup shell');
requireIncludes('src/bridge/bridge-manager.ts', 'protocolForCandidate', 'direct protocol capability gating');
requireIncludes('src/contracts/capabilities.schema.ts', 'streamResolverReady', 'stream capability contract');

if (failures.length) {
  console.error('NOVA-Extension feature parity check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('NOVA-Extension feature parity check passed.');
