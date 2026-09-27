import { describe, expect, it } from 'vitest';
import { PinterestAdapter } from '../../platforms/pinterest-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('PinterestAdapter', () => {
  const adapter = new PinterestAdapter();

  describe('extractFromScan', () => {
    it('extracts MP4 video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://v.pinimg.com/videos/123/video.mp4?\\u0026sig=abc">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.pinterest.com/pin/123',
        url: 'https://www.pinterest.com/pin/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp4') && r.type === 'video')).toBe(true);
    });

    it('extracts HLS m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://v.pinimg.com/videos/123/hls.m3u8?\\u0026sig=def">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.pinterest.com/pin/123',
        url: 'https://www.pinterest.com/pin/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.mimeType === 'application/vnd.apple.mpegurl')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://i.pinimg.com/236x/ab/cd/ef/image.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.pinterest.com/pin/123',
        url: 'https://www.pinterest.com/pin/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.jpg') && r.type === 'image')).toBe(true);
    });

    it('extracts video_url from resource data JSON', () => {
      const content: ContentScanResponse = {
        html: '"video_url":"https:\\/\\/v.pinimg.com\\/videos\\/123\\/video.mp4"',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.pinterest.com/pin/123',
        url: 'https://www.pinterest.com/pin/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('v.pinimg.com/videos/123/video.mp4') && r.metadata?.source === 'pinterest-video-url')).toBe(true);
    });

    it('extracts image_original_url from resource data JSON', () => {
      const content: ContentScanResponse = {
        html: '"image_original_url":"https:\\/\\/i.pinimg.com\\/originals\\/ab\\/cd\\/ef\\/image.jpg"',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.pinterest.com/pin/123',
        url: 'https://www.pinterest.com/pin/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('i.pinimg.com/originals/ab/cd/ef/image.jpg') && r.metadata?.source === 'pinterest-image-url')).toBe(true);
    });

    it('extracts from DOM links matching CDN', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://v.pinimg.com/videos/123/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.pinterest.com',
        url: 'https://www.pinterest.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-pinimg links', () => {
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
    it('boosts pinimg video URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://v.pinimg.com/videos/123/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts pinimg non-video URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://i.pinimg.com/236x/ab/cd/image.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-pinimg URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches pinimg CDN hostnames', () => {
      expect(adapter.matchesCDN('https://v.pinimg.com/videos/123/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://i.pinimg.com/236x/ab/cd/image.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
