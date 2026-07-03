import { describe, expect, it } from 'vitest';
import { YoutubeAdapter } from '../../platforms/youtube-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('YoutubeAdapter', () => {
  const adapter = new YoutubeAdapter();

  describe('extractFromScan', () => {
    it('extracts formats from ytInitialPlayerResponse in HTML', () => {
      const content: ContentScanResponse = {
        html: `<html><script>var ytInitialPlayerResponse = {"streamingData":{"formats":[{"itag":18,"mimeType":"video/mp4; codecs=\\"avc1.42001E, mp4a.40.2\\"","qualityLabel":"360p","contentLength":"12345678","bitrate":500000,"url":"https://example.com/videoplayback?itag=18&foo=bar"}]},"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"Rick Astley - Never Gonna Give You Up"}};</script></html>`,
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.metadata?.itag === '18');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.quality).toBe('360p');
      expect(match!.mimeType).toBe('video/mp4');
      expect(match!.metadata!.videoId).toBe('dQw4w9WgXcQ');
      expect(match!.metadata!.source).toBe('ytInitialPlayerResponse');
    });

    it('extracts audio formats from adaptiveFormats via itag', () => {
      const content: ContentScanResponse = {
        html: `<script>ytInitialPlayerResponse = {"streamingData":{"adaptiveFormats":[{"itag":140,"mimeType":"audio/mp4; codecs=\\"mp4a.40.2\\"","contentLength":"987654","bitrate":128000,"url":"https://example.com/videoplayback?itag=140"}]},"videoDetails":{"videoId":"abc123def45"}};</script>`,
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=abc123def45',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.itag === '140');
      expect(match).toBeDefined();
      expect(match!.type).toBe('audio');
      expect(match!.quality).toBe('128kbps');
    });

    it('extracts formats from player_response string pattern', () => {
      const content: ContentScanResponse = {
        html: `<script>player_response='{"streamingData":{"formats":[{"itag":22,"mimeType":"video/mp4","qualityLabel":"720p","url":"https://example.com/videoplayback?itag=22"}]}}';</script>`,
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=xYZ123abc99',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.itag === '22');
      expect(match).toBeDefined();
      expect(match!.quality).toBe('720p');
      expect(match!.type).toBe('video');
    });

    it('extracts videoplayback URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><body>https://r2---sn-ab5l6n7k.googlevideo.com/videoplayback?itag=137&source=youtube&mime=video%2Fmp4</body></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'videoplayback');
      expect(match).toBeDefined();
      expect(match!.url).toContain('videoplayback');
      expect(match!.quality).toBe('1080p');
      expect(match!.type).toBe('video');
    });

    it('extracts videoplayback audio URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: 'https://r2---sn-ab5l6n7k.googlevideo.com/videoplayback?itag=251&source=youtube&mime=audio%2Fopus',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.itag === '251');
      expect(match).toBeDefined();
      expect(match!.type).toBe('audio');
      expect(match!.quality).toBe('160kbps');
    });

    it('extracts video info URL and title from HTML', () => {
      const content: ContentScanResponse = {
        html: '<title>Amazing Video - YouTube</title><meta property="og:url" content="https://www.youtube.com/watch?v=abc123def01">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=abc123def01',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'video-info');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://www.youtube.com/watch?v=abc123def01');
      expect(match!.type).toBe('video');
    });

    it('extracts from DOM links with videoplayback URLs', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://r2.googlevideo.com/videoplayback?itag=18&mime=video/mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link-videoplayback');
      expect(match).toBeDefined();
      expect(match!.quality).toBe('360p');
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://r2---sn123.googlevideo.com/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link-cdn');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });

    it('handles non-matching HTML gracefully', () => {
      const content: ContentScanResponse = {
        html: '<html><p>no media here</p></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });

    it('extracts formats with signatureCipher', () => {
      const content: ContentScanResponse = {
        html: `<script>ytInitialPlayerResponse = {"streamingData":{"formats":[{"itag":18,"mimeType":"video/mp4","qualityLabel":"360p","signatureCipher":"url=https%3A%2F%2Fexample.com%2Fvideoplayback%3Fitag%3D18&sp=sig"}]},"videoDetails":{"videoId":"test12345abc"}};</script>`,
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.youtube.com',
        url: 'https://www.youtube.com/watch?v=test12345abc',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.itag === '18');
      expect(match).toBeDefined();
      expect(match!.url).toContain('videoplayback?itag=18');
    });
  });

  describe('adjustConfidence', () => {
    it('boosts videoplayback URLs to 75', () => {
      const result = adapter.adjustConfidence({ url: 'https://r2.googlevideo.com/videoplayback?itag=18', confidence: 30 } as Candidate);
      expect(result).toBe(75);
    });

    it('boosts googlevideo.com URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://r2---sn123.googlevideo.com/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts youtube.com/watch URLs to 50', () => {
      const result = adapter.adjustConfidence({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', confidence: 20 } as Candidate);
      expect(result).toBe(50);
    });

    it('adds 10 for non-YouTube URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(60);
    });

    it('handles empty URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(10);
    });
  });

  describe('matchesCDN', () => {
    it('matches YouTube CDN hostnames', () => {
      expect(adapter.matchesCDN('https://r2---sn123.googlevideo.com/video.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://i.ytimg.com/vi/test/maxresdefault.jpg')).toBe(true);
      expect(adapter.matchesCDN('https://www.youtube.com/watch?v=test')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
