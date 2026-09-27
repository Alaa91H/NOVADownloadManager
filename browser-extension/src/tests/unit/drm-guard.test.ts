import { describe, expect, it } from 'vitest';
import {
  annotateCandidateWithDrmGuard,
  createDrmInfoCandidates,
  detectDrmIndicatorsFromHtml,
  detectDrmIndicatorsFromManifestText,
  drmInfoFromIndicators,
  drmInfoFromPageTapEvent,
  drmSystemFromKeySystem,
  isDrmProtectedCandidate,
} from '../../security/drm-guard';

describe('drmSystemFromKeySystem', () => {
  it('identifies widevine', () => expect(drmSystemFromKeySystem('com.widevine.alpha')).toBe('widevine'));
  it('identifies playready', () => expect(drmSystemFromKeySystem('com.microsoft.playready')).toBe('playready'));
  it('identifies fairplay', () => expect(drmSystemFromKeySystem('com.apple.fps.1_0')).toBe('fairplay'));
  it('identifies clearkey', () => expect(drmSystemFromKeySystem('org.w3.clearkey')).toBe('clearkey'));
  it('returns undefined for empty input', () => expect(drmSystemFromKeySystem('')).toBeUndefined());
  it('returns unknown for unmapped values', () => expect(drmSystemFromKeySystem('some.unknown.system')).toBe('unknown'));
});

describe('detectDrmIndicatorsFromHtml', () => {
  it('detects widevine from page HTML', () => {
    const result = detectDrmIndicatorsFromHtml('<html><body>widevine encrypted-media</body></html>');
    expect(result.likelyProtected).toBe(true);
    expect(result.systems).toContain('widevine');
    expect(result.emeKeywords).toHaveLength(1);
  });

  it('detects playready from page HTML', () => {
    const result = detectDrmIndicatorsFromHtml('<html>playready contentprotection</html>');
    expect(result.likelyProtected).toBe(true);
    expect(result.systems).toContain('playready');
  });

  it('detects fairplay from page HTML', () => {
    const result = detectDrmIndicatorsFromHtml('<html>com.apple.streamingkeydelivery encrypted-media</html>');
    expect(result.likelyProtected).toBe(true);
    expect(result.systems).toContain('fairplay');
  });

  it('detects clearkey from page HTML', () => {
    const result = detectDrmIndicatorsFromHtml('<html>org.w3.clearkey</html>');
    expect(result.likelyProtected).toBe(true);
    expect(result.systems).toContain('clearkey');
  });

  it('returns not protected for clean HTML', () => {
    const result = detectDrmIndicatorsFromHtml('<html><p>hello world</p></html>');
    expect(result.likelyProtected).toBe(false);
    expect(result.systems).toHaveLength(0);
  });

  it('handles empty HTML', () => {
    const result = detectDrmIndicatorsFromHtml('');
    expect(result.likelyProtected).toBe(false);
  });

  it('detects DRM from multiple indicators simultaneously', () => {
    const result = detectDrmIndicatorsFromHtml('<html>widevine playready pssh encrypted-media</html>');
    expect(result.systems).toContain('widevine');
    expect(result.systems).toContain('playready');
    expect(result.psshCount).toBeGreaterThan(0);
  });

  it('truncates very large HTML to 1.5M chars', () => {
    const large = 'x'.repeat(2_000_000) + 'widevine';
    const result = detectDrmIndicatorsFromHtml(large);
    expect(result.likelyProtected).toBe(false);
  });
});

describe('detectDrmIndicatorsFromManifestText', () => {
  it('detects DASH ContentProtection', () => {
    const result = detectDrmIndicatorsFromManifestText(
      '<MPD><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/></MPD>',
      'dash',
    );
    expect(result.likelyProtected).toBe(true);
    expect(result.contentProtectionDetected).toBe(true);
  });

  it('detects HLS encryption keys', () => {
    const result = detectDrmIndicatorsFromManifestText(
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://example"',
      'hls',
    );
    expect(result.likelyProtected).toBe(true);
    expect(result.hlsKeyDetected).toBe(true);
  });

  it('returns not protected for clean manifest', () => {
    const result = detectDrmIndicatorsFromManifestText(
      '#EXTM3U\n#EXTINF:10,\nsegment.ts',
      'hls',
    );
    expect(result.likelyProtected).toBe(false);
  });

  it('auto-detects manifest type from content if not specified', () => {
    const result = detectDrmIndicatorsFromManifestText('<ContentProtection value="cenc"/>');
    expect(result.likelyProtected).toBe(true);
  });
});

describe('drmInfoFromIndicators', () => {
  it('creates DRM info from Widevine indicators', () => {
    const indicators = detectDrmIndicatorsFromHtml('<html>widevine encrypted-media</html>');
    const info = drmInfoFromIndicators(indicators);
    expect(info?.protected).toBe(true);
    expect(info?.system).toBe('widevine');
    expect(info?.source).toBe('html-keyword');
  });

  it('returns undefined when not protected', () => {
    const indicators = detectDrmIndicatorsFromHtml('<html>no drm here</html>');
    expect(drmInfoFromIndicators(indicators)).toBeUndefined();
  });

  it('uses sourceFallback when indicators have no sources', () => {
    const indicators = detectDrmIndicatorsFromHtml('');
    indicators.likelyProtected = true;
    const info = drmInfoFromIndicators(indicators, 'dash-manifest');
    expect(info?.source).toBe('dash-manifest');
  });
});

describe('drmInfoFromPageTapEvent', () => {
  it('validates and normalises a raw DRM info', () => {
    const result = drmInfoFromPageTapEvent({ system: 'widevine', source: 'eme', psshCount: 2 } as never);
    expect(result.protected).toBe(true);
    expect(result.system).toBe('widevine');
    expect(result.downloadable).toBe(true);
  });
});

describe('isDrmProtectedCandidate', () => {
  it('detects DRM from drm field', () => {
    expect(isDrmProtectedCandidate({ drm: { protected: true, system: 'widevine', source: 'eme', downloadable: true } } as never)).toBe(true);
  });

  it('detects DRM from metadata flag', () => {
    expect(isDrmProtectedCandidate({ metadata: { drmProtected: true } } as never)).toBe(true);
  });

  it('returns false for unprotected candidate', () => {
    expect(isDrmProtectedCandidate({ url: 'https://example.com/video.mp4' } as never)).toBe(false);
  });
});

describe('annotateCandidateWithDrmGuard', () => {
  it('adds DRM info to a video candidate', () => {
    const content = { url: 'https://example.com', html: '<html>widevine</html>', links: [], media: [], openGraph: [], jsonLd: [], drmIndicators: detectDrmIndicatorsFromHtml('<html>widevine</html>') };
    const candidate = annotateCandidateWithDrmGuard(
      { id: 'c1', url: 'https://example.com/v.mp4', mediaType: 'video' } as never,
      content,
    );
    expect(candidate.drm?.protected).toBe(true);
    expect(candidate.metadata?.drmProtected).toBe(true);
    expect(candidate.evidence).toHaveLength(1);
  });

  it('skips non-media candidates', () => {
    const content = { url: 'https://example.com', html: '<html>widevine</html>', links: [], media: [], openGraph: [], jsonLd: [], drmIndicators: detectDrmIndicatorsFromHtml('<html>widevine</html>') };
    const candidate = annotateCandidateWithDrmGuard(
      { id: 'c1', url: 'https://example.com/file.pdf', mediaType: 'document' } as never,
      content,
    );
    expect(candidate.drm).toBeUndefined();
  });

  it('returns candidate unchanged when no DRM indicators', () => {
    const candidate = annotateCandidateWithDrmGuard(
      { id: 'c1', url: 'https://example.com/v.mp4', mediaType: 'video' } as never,
      undefined,
    );
    expect(candidate.drm).toBeUndefined();
  });
});

describe('createDrmInfoCandidates', () => {
  it('creates a DRM candidate from content scan', () => {
    const content = {
      url: 'https://example.com',
      title: 'My Video',
      html: '<html>widevine encrypted-media initData</html>',
      links: [],
      media: [],
      openGraph: [],
      jsonLd: [],
      drmIndicators: detectDrmIndicatorsFromHtml('<html>widevine encrypted-media initData</html>'),
    };
    const candidates = createDrmInfoCandidates(content);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mediaType).toBe('video');
    expect(candidates[0]?.drm?.system).toBe('widevine');
  });

  it('returns empty when no DRM detected', () => {
    const content = { url: 'https://example.com', html: '<html>clean</html>', links: [], media: [], openGraph: [], jsonLd: [], drmIndicators: detectDrmIndicatorsFromHtml('<html>clean</html>') };
    expect(createDrmInfoCandidates(content)).toHaveLength(0);
  });

  it('returns empty when no content or page URL', () => {
    expect(createDrmInfoCandidates(undefined)).toHaveLength(0);
  });
});
