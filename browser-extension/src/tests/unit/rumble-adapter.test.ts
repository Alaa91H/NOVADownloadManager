import { describe, expect, it } from 'vitest';
import { RumbleAdapter } from '../../platforms/rumble-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('RumbleAdapter', () => {
  const adapter = new RumbleAdapter();

  describe('extractFromScan', () => {
    it('extracts mp4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://sp.rmbl.ws/rumble.com/video.mp4?params\\u0026other">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com/video',
        url: 'https://rumble.com/video',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.url.includes('video.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts webm URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.rumble.com/stream/clip.webm?token\\u0026sig">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com',
        url: 'https://rumble.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.webm') && r.type === 'video')).toBe(true);
    });

    it('extracts m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.rumble.com/live/playlist.m3u8?token\\u0026expiry">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com',
        url: 'https://rumble.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.type === 'video')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://thumb.rumble.com/thumb/image.jpg?w\\u0026h">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com',
        url: 'https://rumble.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'image')).toBe(true);
    });

    it('extracts from player config JSON with "mp4" key', () => {
      const content: ContentScanResponse = {
        html: '"ua":{"default":true}"mp4":"https:\\/\\/cdn.rumble.com\\/video.mp4"',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com',
        url: 'https://rumble.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'rumble-mp4-config')).toBe(true);
    });

    it('extracts from player config JSON with "url" key in "ua" block', () => {
      const content: ContentScanResponse = {
        html: '"ua":{"url":"https:\\/\\/cdn.rumble.com\\/stream.m3u8"}',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com',
        url: 'https://rumble.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('stream.m3u8') && r.metadata?.source === 'rumble-player-config')).toBe(true);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://cdn.rumble.com/stream/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://rumble.com',
        url: 'https://rumble.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-rumble links', () => {
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
    it('boosts mp4/webm URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.rumble.com/stream/video.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts m3u8 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.rumble.com/live/stream.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts rumble URLs to 35 minimum', () => {
      const result = adapter.adjustConfidence({ url: 'https://rumble.com/thumb/image.jpg', confidence: 10 } as Candidate);
      expect(result).toBe(35);
    });

    it('adds 5 for non-rumble URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches rumble CDN hostnames', () => {
      expect(adapter.matchesCDN('https://cdn.rumble.com/stream/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cf-xx.rumbleservice.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.rumble.com/stream/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
