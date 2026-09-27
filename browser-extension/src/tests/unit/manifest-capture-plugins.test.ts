import { describe, expect, it } from 'vitest';
import { HlsManifestCapturePlugin } from '../../capture/hls-capture';
import { DashManifestCapturePlugin } from '../../capture/dash-capture';

// The parser functions are covered in manifest-parsers.test.ts; this exercises the
// capture plugins that turn page HTML/links into streaming-manifest candidates.

describe('HlsManifestCapturePlugin.capture', () => {
  it('extracts .m3u8 URLs from raw HTML as manifest candidates', async () => {
    const html = `<video><source src="https://cdn.example.com/stream/master.m3u8?token=abc"></video>`;
    const candidates = await new HlsManifestCapturePlugin().capture({ html, pageUrl: 'https://example.com/watch' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.mediaType).toBe('manifest');
    expect(candidates[0]!.source).toBe('hls-manifest');
    expect(candidates[0]!.extension).toBe('m3u8');
    expect(candidates[0]!.url).toContain('master.m3u8');
  });

  it('captures manifests advertised via a typed content link and de-duplicates', async () => {
    const url = 'https://cdn.example.com/a.m3u8';
    const content = {
      url: 'https://example.com/watch',
      links: [
        { url, type: 'application/vnd.apple.mpegurl' },
        { url, type: 'application/vnd.apple.mpegurl' },
      ],
    } as never;
    const candidates = await new HlsManifestCapturePlugin().capture({ content, pageUrl: 'https://example.com/watch' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.url).toBe(url);
  });

  it('is disabled when there is no html or links to scan', async () => {
    expect(await new HlsManifestCapturePlugin().isEnabled({})).toBe(false);
    expect(await new HlsManifestCapturePlugin().isEnabled({ html: '<a href="x.m3u8">' })).toBe(true);
  });
});

describe('DashManifestCapturePlugin.capture', () => {
  it('extracts .mpd URLs from raw HTML as manifest candidates', async () => {
    const html = `<a href="https://cdn.example.com/dash/manifest.mpd">play</a>`;
    const candidates = await new DashManifestCapturePlugin().capture({ html, pageUrl: 'https://example.com/watch' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.mediaType).toBe('manifest');
    expect(candidates[0]!.source).toBe('dash-manifest');
    expect(candidates[0]!.extension).toBe('mpd');
    expect(candidates[0]!.mimeType).toBe('application/dash+xml');
  });

  it('does not capture HLS manifests as DASH', async () => {
    const html = `<source src="https://cdn.example.com/only.m3u8">`;
    const candidates = await new DashManifestCapturePlugin().capture({ html, pageUrl: 'https://example.com/watch' });
    expect(candidates).toHaveLength(0);
  });
});
