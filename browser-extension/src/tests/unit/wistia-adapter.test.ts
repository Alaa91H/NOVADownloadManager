import { describe, expect, it } from 'vitest';
import { WistiaAdapter } from '../../platforms/wistia-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('WistiaAdapter', () => {
  const adapter = new WistiaAdapter();

  describe('extractFromScan', () => {
    it('extracts MP4 video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://fast.wistia.net/medias/abc123/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.wistia.com/projects/123',
        url: 'https://www.wistia.com/projects/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp4') && r.type === 'video')).toBe(true);
    });

    it('extracts HLS m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://fast.wistia.com/medias/abc123/hls.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.wistia.com/projects/123',
        url: 'https://www.wistia.com/projects/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.mimeType === 'application/vnd.apple.mpegurl')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://embed.wistia.com/deliveries/abc123/image.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.wistia.com/projects/123',
        url: 'https://www.wistia.com/projects/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.jpg') && r.type === 'image')).toBe(true);
    });

    it('extracts from wistia embed pattern and generates media URLs', () => {
      const content: ContentScanResponse = {
        html: '<iframe src="https://wistia.com/embed/abc1234"></iframe>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.wistia.com/projects/123',
        url: 'https://www.wistia.com/projects/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('abc1234.m3u8') && r.metadata?.source === 'wistia-embed')).toBe(true);
      expect(results.some((r) => r.url.includes('abc1234/download') && r.metadata?.source === 'wistia-download')).toBe(true);
    });

    it('extracts from DOM links matching CDN', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://fast.wistia.net/medias/abc123/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.wistia.com',
        url: 'https://www.wistia.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('extracts .wistia.io URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://dist.wistia.io/medias/abc123/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.wistia.com/projects/123',
        url: 'https://www.wistia.com/projects/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('wistia.io') && r.type === 'video')).toBe(true);
    });

    it('ignores non-wistia links', () => {
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
    it('boosts wistia MP4 URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://fast.wistia.net/medias/abc/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts wistia m3u8 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://fast.wistia.com/embed/medias/abc.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts wistia embed URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://fast.wistia.com/embed/medias/abc123', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('adds 10 for non-wistia URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(60);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(10);
    });
  });

  describe('matchesCDN', () => {
    it('matches wistia CDN hostnames', () => {
      expect(adapter.matchesCDN('https://fast.wistia.com/medias/abc/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://fast.wistia.net/medias/abc/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://dist.wistia.io/medias/abc/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://embed.wistia.com/deliveries/abc/image.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
