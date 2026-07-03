import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearManifestCache,
  isDashUrl,
  isHlsUrl,
  isManifestUrl,
  resolveDashManifest,
  resolveHlsManifest,
} from '../../platforms/manifest-resolver';

function mockFetchOnce(status: number, body: string, finalUrl?: string) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    url: finalUrl ?? 'http://example.com/manifest',
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as Response);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  clearManifestCache();
});

describe('isHlsUrl', () => {
  it('matches .m3u8 URLs', () => {
    expect(isHlsUrl('http://example.com/stream.m3u8')).toBe(true);
    expect(isHlsUrl('http://example.com/stream.M3U8')).toBe(true);
    expect(isHlsUrl('http://example.com/stream.m3u8?token=abc')).toBe(true);
  });

  it('rejects non-HLS URLs', () => {
    expect(isHlsUrl('http://example.com/stream.mpd')).toBe(false);
    expect(isHlsUrl('http://example.com/video.mp4')).toBe(false);
    expect(isHlsUrl('')).toBe(false);
  });
});

describe('isDashUrl', () => {
  it('matches .mpd URLs', () => {
    expect(isDashUrl('http://example.com/manifest.mpd')).toBe(true);
    expect(isDashUrl('http://example.com/manifest.MPD')).toBe(true);
    expect(isDashUrl('http://example.com/manifest.mpd?token=abc')).toBe(true);
  });

  it('rejects non-DASH URLs', () => {
    expect(isDashUrl('http://example.com/stream.m3u8')).toBe(false);
    expect(isDashUrl('http://example.com/video.mp4')).toBe(false);
  });
});

describe('isManifestUrl', () => {
  it('matches both HLS and DASH URLs', () => {
    expect(isManifestUrl('http://example.com/stream.m3u8')).toBe(true);
    expect(isManifestUrl('http://example.com/manifest.mpd')).toBe(true);
    expect(isManifestUrl('http://example.com/video.mp4')).toBe(false);
  });
});

describe('resolveHlsManifest', () => {
  const SAMPLE_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=60
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=30
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360p.m3u8
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",URI="subs/en.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="ar",NAME="Arabic",URI="subs/ar.vtt"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="Main",URI="720p60.m3u8"
`;

  it('extracts variant streams from a master playlist', async () => {
    mockFetchOnce(200, SAMPLE_MASTER, 'http://example.com/master.m3u8');
    const result = await resolveHlsManifest('http://example.com/master.m3u8');
    const streamVariants = result.variants.filter((v) => v.mimeType === 'application/vnd.apple.mpegurl');
    expect(streamVariants).toHaveLength(3);
    expect(streamVariants[0]).toMatchObject({ width: 1920, height: 1080, bandwidth: 4500000 });
    expect(streamVariants[0]?.label).toBe('1080p60');
    expect(streamVariants[1]).toMatchObject({ width: 1280, height: 720, bandwidth: 2500000 });
    expect(streamVariants[1]?.label).toBe('720p');
    expect(streamVariants[2]).toMatchObject({ width: 640, height: 360, bandwidth: 800000 });
    expect(streamVariants[2]?.label).toBe('360p');
  });

  it('resolves relative variant URLs against the manifest URL', async () => {
    mockFetchOnce(200, SAMPLE_MASTER);
    const result = await resolveHlsManifest('http://example.com/master.m3u8');
    for (const v of result.variants) {
      expect(v.url).toMatch(/^http:\/\/example\.com\//);
    }
  });

  it('extracts subtitles', async () => {
    mockFetchOnce(200, SAMPLE_MASTER);
    const result = await resolveHlsManifest('http://example.com/master.m3u8');
    expect(result.subtitles).toHaveLength(2);
    expect(result.subtitles![0]).toMatchObject({ language: 'en' });
    expect(result.subtitles![1]).toMatchObject({ language: 'ar' });
    expect(result.subtitles![0]?.url).toMatch(/subs\/en\.vtt$/);
  });

  it('returns a single fallback variant when the manifest has no variants', async () => {
    mockFetchOnce(200, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n`);
    const result = await resolveHlsManifest('http://example.com/stream.m3u8');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.label).toBe('original');
  });

  it('returns a single fallback variant on HTTP error', async () => {
    mockFetchOnce(404, 'Not Found');
    const result = await resolveHlsManifest('http://example.com/missing.m3u8');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.label).toBe('original');
  });

  it('includes the VIDEO media group as a variant', async () => {
    mockFetchOnce(200, SAMPLE_MASTER);
    const result = await resolveHlsManifest('http://example.com/master.m3u8');
    const videoMedia = result.variants.find((v) => v.url.includes('720p60'));
    expect(videoMedia).toBeDefined();
  });
});

describe('resolveDashManifest', () => {
  const SAMPLE_MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD mediaPresentationDuration="PT2M30S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="1080p" bandwidth="6000000" width="1920" height="1080" codecs="avc1.640028" frameRate="60/1">
        <BaseURL>1080p.mp4</BaseURL>
      </Representation>
      <Representation id="720p" bandwidth="3000000" width="1280" height="720" codecs="avc1.4d401f" frameRate="30/1">
        <BaseURL>720p.mp4</BaseURL>
      </Representation>
      <Representation id="360p" bandwidth="1000000" width="640" height="360" codecs="avc1.42c01e">
        <BaseURL>360p.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio">
      <Representation id="audio" bandwidth="128000">
        <BaseURL>audio.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

  it('extracts video representations from an MPD', async () => {
    mockFetchOnce(200, SAMPLE_MPD, 'http://example.com/manifest.mpd');
    const result = await resolveDashManifest('http://example.com/manifest.mpd');
    expect(result.variants.length).toBeGreaterThanOrEqual(3);
    const videoVariants = result.variants.filter((v) => v.mimeType?.startsWith('video'));
    expect(videoVariants.length).toBeGreaterThanOrEqual(3);
    expect(videoVariants[0]).toMatchObject({ width: 1920, height: 1080, bandwidth: 6000000, label: '1080p' });
    expect(videoVariants[1]).toMatchObject({ width: 1280, height: 720, bandwidth: 3000000, label: '720p' });
    expect(videoVariants[2]).toMatchObject({ width: 640, height: 360, bandwidth: 1000000, label: '360p' });
  });

  it('does not duplicate variants with the same URL', async () => {
    mockFetchOnce(200, SAMPLE_MPD);
    const result = await resolveDashManifest('http://example.com/manifest.mpd');
    const urls = result.variants.map((v) => v.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('handles MPD with only BaseURL and no Representation', async () => {
    const simpleMpd = `<?xml version="1.0"?><MPD><Period><AdaptationSet><BaseURL>video.mp4</BaseURL></AdaptationSet></Period></MPD>`;
    mockFetchOnce(200, simpleMpd);
    const result = await resolveDashManifest('http://example.com/manifest.mpd');
    expect(result.variants.length).toBeGreaterThanOrEqual(1);
  });

  it('returns a single fallback variant on HTTP error', async () => {
    mockFetchOnce(500, 'Server Error');
    const result = await resolveDashManifest('http://example.com/manifest.mpd');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.label).toBe('original');
  });

  it('handles empty MPD gracefully', async () => {
    mockFetchOnce(200, '');
    const result = await resolveDashManifest('http://example.com/manifest.mpd');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.label).toBe('original');
  });

  it('resolves relative BaseURLs', async () => {
    mockFetchOnce(200, SAMPLE_MPD);
    const result = await resolveDashManifest('http://example.com/manifest.mpd');
    for (const v of result.variants) {
      expect(v.url).toMatch(/^http:\/\/example\.com\//);
    }
  });
});
