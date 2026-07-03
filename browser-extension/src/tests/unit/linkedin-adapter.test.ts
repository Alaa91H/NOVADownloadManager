import { describe, expect, it } from 'vitest';
import { LinkedInAdapter } from '../../platforms/linkedin-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('LinkedInAdapter', () => {
  const adapter = new LinkedInAdapter();

  describe('extractFromScan', () => {
    it('extracts mp4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://dms.licdn.com/playback/video.mp4?token\\u0026key">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com/feed/update/123',
        url: 'https://www.linkedin.com/feed/update/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.url.includes('video.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://dms.licdn.com/playback/playlist.m3u8?token\\u0026expiry">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com',
        url: 'https://www.linkedin.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.type === 'video')).toBe(true);
    });

    it('extracts mpd (DASH) URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://dms.licdn.com/playback/manifest.mpd?token\\u0026expiry">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com',
        url: 'https://www.linkedin.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mpd') && r.type === 'video')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://media.licdn.com/thumb/image.jpg?w\\u0026h">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com',
        url: 'https://www.linkedin.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'image')).toBe(true);
    });

    it('extracts from OpenGraph og:video', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://dms.licdn.com/playback/video.mp4', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com',
        url: 'https://www.linkedin.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'og')).toBe(true);
    });

    it('extracts from OpenGraph og:image', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://media.licdn.com/thumb/image.jpg', tag: 'meta', attr: 'og:image' }],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com',
        url: 'https://www.linkedin.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('image.jpg') && r.metadata?.source === 'og')).toBe(true);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://dms.licdn.com/playback/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.linkedin.com',
        url: 'https://www.linkedin.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-linkedin links', () => {
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
    it('boosts mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://dms.licdn.com/playback/video.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts m3u8/mpd URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://dms.licdn.com/playback/stream.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts licdn URLs to 35 minimum', () => {
      const result = adapter.adjustConfidence({ url: 'https://media.licdn.com/thumb/image.jpg', confidence: 10 } as Candidate);
      expect(result).toBe(35);
    });

    it('adds 5 for non-linkedin URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches linkedin CDN hostnames', () => {
      expect(adapter.matchesCDN('https://dms.licdn.com/playback/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://media.licdn.com/thumb/image.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
