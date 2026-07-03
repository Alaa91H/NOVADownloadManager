import { describe, expect, it } from 'vitest';
import { TikTokAdapter } from '../../platforms/tiktok-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('TikTokAdapter', () => {
  const adapter = new TikTokAdapter();

  describe('extractFromScan', () => {
    it('extracts video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://v16m.tiktokcdn.com/video/12345.mp4?token=abc"></video></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><source src="https://v16m.tiktokcdn.com/video/67890.m3u8?token=def"></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/987654321',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.m3u8');
    });

    it('extracts tikcdn.net video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://v16.tikcdn.net/video/11111.mp4"></video>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/111111111',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.url).toContain('tikcdn.net');
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://p16.tiktokcdn.com/img/12345.jpg?token=ghi">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-image');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts tiktokcdn-us video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://v16.tiktokcdn-us.com/video/22222.mp4"></video>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/222222222',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.url).toContain('tiktokcdn-us.com');
    });

    it('extracts video from sigi-state (__NEXT_DATA__)', () => {
      const content: ContentScanResponse = {
        html: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"videoData":{"downloadUrls":{"downloadAddr":"https://v16m.tiktokcdn.com/video/12345.mp4"},"width":720,"height":1280,"duration":30,"cover":"https://p16.tiktokcdn.com/img/cover.jpg"}}}}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'sigi-state');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
      expect(match!.width).toBe(720);
      expect(match!.height).toBe(1280);
      expect(match!.duration).toBe(30);
    });

    it('extracts cover image from sigi-state', () => {
      const content: ContentScanResponse = {
        html: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"videoData":{"downloadUrls":{"downloadAddr":"https://v16m.tiktokcdn.com/video/12345.mp4"},"cover":"https://p16.tiktokcdn.com/img/cover.jpg"}}}}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const coverMatch = results.find((r) => r.metadata?.source === 'sigi-state-cover');
      expect(coverMatch).toBeDefined();
      expect(coverMatch!.url).toContain('cover.jpg');
      expect(coverMatch!.type).toBe('image');
    });

    it('traverses sigi-state for additional TikTok URLs', () => {
      const content: ContentScanResponse = {
        html: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"videoData":{"downloadUrls":{"downloadAddr":"https://v16m.tiktokcdn.com/video/12345.mp4"},"cover":"https://p16.tiktokcdn.com/img/cover.jpg"}},"extraVideo":{"url":"https://v16.tiktokcdn.com/video/extra.mp4"}}}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const traverseMatch = results.find((r) => r.metadata?.source === 'sigi-traverse');
      expect(traverseMatch).toBeDefined();
      expect(traverseMatch!.url).toContain('tiktokcdn.com');
      expect(traverseMatch!.type).toBe('video');
    });

    it('traverses sigi-state for image URLs', () => {
      const content: ContentScanResponse = {
        html: '<script id="__NEXT_DATA__">{"props":{"pageProps":{"videoData":{},"media":{"images":[{"url":"https://p16.tiktokcdn.com/img/extra.jpg"}]}}}}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const traverseMatch = results.find((r) => r.metadata?.source === 'sigi-traverse');
      expect(traverseMatch).toBeDefined();
      expect(traverseMatch!.url).toContain('extra.jpg');
      expect(traverseMatch!.type).toBe('image');
    });

    it('extracts from DOM links on tiktok CDN', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://v16m.tiktokcdn.com/video/12345.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tiktok.com',
        url: 'https://www.tiktok.com/@user/video/123456789',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('ignores non-tiktok links', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://example.com/file.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });
  });

  describe('adjustConfidence', () => {
    it('boosts tiktokcdn mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://v16m.tiktokcdn.com/video/12345.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts tikcdn mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://v16.tikcdn.net/video/67890.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts tiktokv.com mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://v16.tiktokv.com/video/11111.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts CDN non-mp4 URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://p16.tiktokcdn.com/img/cover.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-tiktok URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles empty URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches tiktok CDN hostnames', () => {
      expect(adapter.matchesCDN('https://v16m.tiktokcdn.com/video/12345.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://v16.tikcdn.net/video/67890.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://p16.tiktokcdn-us.com/img/cover.jpg')).toBe(true);
      expect(adapter.matchesCDN('https://v16.tiktokv.com/video/11111.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
