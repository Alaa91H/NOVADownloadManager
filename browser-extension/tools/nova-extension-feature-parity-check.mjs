import { readFileSync, existsSync } from 'node:fs';

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
requireIncludes('src/content/overlay-types.ts', 'NOISE_DOMAIN_PATTERNS', 'noise filtering');
requireIncludes('src/content/overlay-install.ts', 'durationchange', 'video metadata change monitoring');
requireIncludes('src/content/overlay-install.ts', 'ratechange', 'video rate change monitoring');
requireIncludes('src/content/overlay-detect.ts', 'data-m3u8-url', 'adaptive data-* attribute scanning');
requireIncludes('src/content/overlay-ui.ts', 'nova-video-download-popover', 'smart overlay UI');
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
