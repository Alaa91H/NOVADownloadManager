import type { Candidate } from '../contracts/candidate.schema';
import { DrmIndicatorsSchema, DrmInfoSchema, type DrmDetectionSource, type DrmIndicators, type DrmInfo, type DrmSystem } from '../contracts/drm.schema';
import type { ContentScanResponse } from '../contracts/messages.schema';

export const DRM_GUARD_ENABLED_BY_DEFAULT = false;

const WIDEVINE_UUID = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const PLAYREADY_UUID = '9a04f079-9840-4286-ab92-e65be0885f95';
const FAIRPLAY_KEYFORMAT_RE = /com\.apple\.streamingkeydelivery|skd:\/\//i;
const CLEARKEY_RE = /org\.w3\.clearkey|clearkey/i;
const WIDEVINE_RE = /com\.widevine\.alpha|widevine|edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i;
const PLAYREADY_RE = /com\.microsoft\.playready|playready|9a04f079-9840-4286-ab92-e65be0885f95/i;
const EME_RE = /requestMediaKeySystemAccess|MediaKeys|MediaKeySession|encryptedmedia|encrypted-media|encrypted\s+event/i;
const DASH_PROTECTION_RE = /<ContentProtection\b|cenc:pssh|\bpssh\b|urn:mpeg:dash:mp4protection:2011/i;
const HLS_KEY_RE = /#EXT-X-(?:SESSION-)?KEY\b[^\n]*(?:SAMPLE-AES|KEYFORMAT=|URI=skd:)/i;
const SCHEME_RE = /\b(cenc|cbcs|cens|cbc1)\b/i;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function drmSystemFromKeySystem(value?: string): DrmSystem | undefined {
  const keySystem = value?.toLowerCase() ?? '';
  if (!keySystem) return undefined;
  if (keySystem.includes('widevine')) return 'widevine';
  if (keySystem.includes('playready')) return 'playready';
  if (keySystem.includes('apple') || keySystem.includes('fairplay')) return 'fairplay';
  if (keySystem.includes('clearkey')) return 'clearkey';
  return 'unknown';
}

function collectSystems(text: string): DrmSystem[] {
  const systems: DrmSystem[] = [];
  if (WIDEVINE_RE.test(text)) systems.push('widevine');
  if (PLAYREADY_RE.test(text)) systems.push('playready');
  if (FAIRPLAY_KEYFORMAT_RE.test(text)) systems.push('fairplay');
  if (CLEARKEY_RE.test(text)) systems.push('clearkey');
  return unique(systems);
}

function collectKeySystems(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/(?:com\.(?:widevine\.alpha|microsoft\.playready|apple\.fps(?:\.1_0)?))|org\.w3\.clearkey/gi)) {
    const value = match[0]?.trim();
    if (value) out.push(value);
  }
  return unique(out).slice(0, 8);
}

function psshCountOf(text: string): number {
  return (text.match(/\bpssh\b|cenc:pssh/gi) ?? []).length;
}

function schemeOf(text: string): DrmInfo['scheme'] {
  const value = SCHEME_RE.exec(text)?.[1]?.toLowerCase();
  return value === 'cenc' || value === 'cbcs' || value === 'cens' || value === 'cbc1' ? value : undefined;
}

function sourceForIndicators(input: {
  eme: boolean;
  dash: boolean;
  hls: boolean;
  pssh: number;
}): DrmDetectionSource {
  if (input.eme) return 'html-keyword';
  if (input.dash || input.pssh > 0) return 'dash-manifest';
  if (input.hls) return 'hls-manifest';
  return 'unknown';
}

export function detectDrmIndicatorsFromHtml(html: string): DrmIndicators {
  if (!html) return DrmIndicatorsSchema.parse({});
  const text = html.slice(0, 1_500_000);
  const systems = collectSystems(text);
  const keySystems = collectKeySystems(text);
  const psshCount = psshCountOf(text);
  const eme = EME_RE.test(text) || keySystems.length > 0;
  const dash = DASH_PROTECTION_RE.test(text) || text.includes(WIDEVINE_UUID) || text.includes(PLAYREADY_UUID);
  const hls = HLS_KEY_RE.test(text);
  const likelyProtected = eme || dash || hls || psshCount > 0 || systems.length > 0;
  const source = sourceForIndicators({ eme, dash, hls, pssh: psshCount });
  return DrmIndicatorsSchema.parse({
    likelyProtected,
    systems,
    keySystems,
    emeKeywords: eme ? ['encrypted-media'] : [],
    mediaKeysDetected: eme,
    encryptedMediaEventHint: /\bencrypted\b/i.test(text) && eme,
    contentProtectionDetected: dash,
    hlsKeyDetected: hls,
    psshCount,
    scheme: schemeOf(text),
    sources: likelyProtected ? [source] : [],
    reason: likelyProtected ? 'Encrypted media indicators were found in page or manifest text.' : undefined,
  });
}

export function detectDrmIndicatorsFromManifestText(text: string, manifestType: 'hls' | 'dash' | 'unknown' = 'unknown'): DrmIndicators {
  const scanned = text.slice(0, 1_500_000);
  const systems = collectSystems(scanned);
  const psshCount = psshCountOf(scanned);
  const dash = manifestType === 'dash' || DASH_PROTECTION_RE.test(scanned);
  const hls = manifestType === 'hls' || HLS_KEY_RE.test(scanned);
  const likelyProtected = Boolean((dash && (DASH_PROTECTION_RE.test(scanned) || psshCount > 0 || systems.length > 0)) || (hls && HLS_KEY_RE.test(scanned)));
  return DrmIndicatorsSchema.parse({
    likelyProtected,
    systems,
    keySystems: collectKeySystems(scanned),
    contentProtectionDetected: dash && likelyProtected,
    hlsKeyDetected: hls && likelyProtected,
    psshCount,
    scheme: schemeOf(scanned),
    sources: likelyProtected ? [hls ? 'hls-manifest' : 'dash-manifest'] : [],
    reason: likelyProtected ? 'Manifest declares encrypted media protection.' : undefined,
  });
}

export function drmInfoFromIndicators(indicators: DrmIndicators, sourceFallback: DrmDetectionSource = 'unknown'): DrmInfo | undefined {
  if (!indicators.likelyProtected) return undefined;
  const system = indicators.systems[0] ?? drmSystemFromKeySystem(indicators.keySystems[0]) ?? 'unknown';
  const source = indicators.sources[0] ?? sourceFallback;
  return DrmInfoSchema.parse({
    protected: true,
    system,
    keySystem: indicators.keySystems[0],
    scheme: indicators.scheme,
    source,
    psshCount: indicators.psshCount,
    initDataType: indicators.initDataTypes[0],
    licenseRequestObserved: indicators.sources.includes('eme'),
    downloadable: true,
    reason: indicators.reason ?? 'Encrypted media was detected.',
  });
}

export function drmInfoFromPageTapEvent(raw: DrmInfo): DrmInfo {
  return DrmInfoSchema.parse({
    ...raw,
    protected: true,
    downloadable: true,
    reason: raw.reason || 'Encrypted media playback was requested by the page.',
  });
}

export function isDrmProtectedCandidate(candidate: Candidate): boolean {
  return Boolean(candidate.drm?.protected || candidate.metadata?.drmProtected === true);
}

export function annotateCandidateWithDrmGuard(candidate: Candidate, content?: ContentScanResponse): Candidate {
  const info = content?.drmIndicators ? drmInfoFromIndicators(content.drmIndicators) : undefined;
  if (!info) return candidate;
  if (!['video', 'audio', 'manifest'].includes(candidate.mediaType)) return candidate;
  return {
    ...candidate,
    drm: info,
    metadata: {
      ...candidate.metadata,
      drmProtected: true,
      drmSystem: info.system,
      drmSource: info.source,
      drmReason: info.reason,
    },
    evidence: [
      ...(candidate.evidence ?? []),
      {
        source: 'drm-detection',
        reason: `DRM protected media detected${info.system ? ` (${info.system})` : ''}`,
        weight: 0,
        observedAt: Date.now(),
        details: { source: info.source, system: info.system, scheme: info.scheme },
      },
    ],
  };
}

export function createDrmInfoCandidates(content?: ContentScanResponse, now = new Date().toISOString()): Candidate[] {
  const info = content?.drmIndicators ? drmInfoFromIndicators(content.drmIndicators) : undefined;
  const pageUrl = content?.url;
  if (!info || !pageUrl) return [];
  return [{
    id: `drm-${stableHash(`${pageUrl}:${info.system ?? 'unknown'}:${info.source}`)}`,
    url: pageUrl,
    pageUrl,
    source: 'drm-detection',
    mediaType: 'video',
    mimeType: 'application/encrypted-media',
    extension: 'drm',
    filename: `${content?.title?.trim() || 'Encrypted video'} - DRM protected`,
    drm: info,
    confidence: 90,
    createdAt: now,
    metadata: {
      drmProtected: true,
      drmSystem: info.system,
      drmSource: info.source,
      drmReason: info.reason,
    },
    evidence: [{
      source: 'drm-detection',
      reason: `Encrypted video detected${info.system ? ` (${info.system})` : ''}`,
      weight: 0,
      observedAt: Date.now(),
      details: { source: info.source, system: info.system, scheme: info.scheme, psshCount: info.psshCount },
    }],
  }];
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
