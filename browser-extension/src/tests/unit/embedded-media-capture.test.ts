import { describe, expect, it } from 'vitest';
import { EmbeddedMediaCapturePlugin, collectEmbeddedMediaUrls } from '../../capture/embedded-media-capture';

describe('embedded media capture', () => {
  it('extracts escaped player-config media and relative file URLs', () => {
    const html = String.raw`<script>
      window.playerConfig = {
        sources: [
          { src: "https:\/\/cdn.example.com\/video\/master.m3u8?token=a\u0026quality=1080" },
          { src: "/files/setup.exe" },
          { src: "./clips/trailer-720p.mp4" }
        ]
      };
    </script>`;

    expect(collectEmbeddedMediaUrls(html, 'https://example.com/watch/page.html')).toEqual([
      'https://cdn.example.com/video/master.m3u8?token=a&quality=1080',
      'https://example.com/files/setup.exe',
      'https://example.com/watch/clips/trailer-720p.mp4',
    ]);
  });

  it('returns normalized candidates with media classifications', async () => {
    const [manifest, app] = await new EmbeddedMediaCapturePlugin().capture({
      pageUrl: 'https://example.com/watch/page.html',
      html: String.raw`{"file":"\/streams\/master.mpd","download":"\/files\/tool.zip"}`,
      now: '2026-01-01T00:00:00.000Z',
    });

    expect(manifest?.mediaType).toBe('manifest');
    expect(manifest?.extension).toBe('mpd');
    expect(app?.mediaType).toBe('archive');
    expect(app?.extension).toBe('zip');
  });
});
