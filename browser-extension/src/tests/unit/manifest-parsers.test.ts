import { describe, expect, it } from 'vitest';
import { parseDashMpdText } from '../../capture/dash-capture';
import { parseHlsManifestText } from '../../capture/hls-capture';

describe('manifest parsers', () => {
  it('extracts HLS variants and subtitles', () => {
    const result = parseHlsManifestText(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",URI="sub/en.vtt"`, 'https://example.com/master.m3u8');
    expect(result.variants?.[0]?.height).toBe(1080);
    expect(result.subtitles?.[0]?.language).toBe('en');
  });

  it('extracts DASH representations', () => {
    const result = parseDashMpdText(`<MPD mediaPresentationDuration="PT1M30S"><Period><AdaptationSet><Representation bandwidth="2500000" width="1280" height="720" codecs="avc1"><BaseURL>video-720.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`, 'https://example.com/manifest.mpd');
    expect(result.durationSec).toBe(90);
    expect(result.variants?.[0]?.label).toBe('720p');
  });
});
