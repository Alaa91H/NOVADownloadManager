import { describe, expect, it } from 'vitest';
import { OdyseeAdapter } from '../../platforms/odysee-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('OdyseeAdapter', () => {
  const adapter = new OdyseeAdapter();

  describe('extractFromScan', () => {
    it('extracts mp4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://cdn.odycdn.com/stream/video.mp4?token\\u0026key">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com/watch/abc',
        url: 'https://odysee.com/watch/abc',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.url.includes('video.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts webm URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.lbryplayer.xyz/stream/clip.webm?hash\\u0026sig">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com',
        url: 'https://odysee.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.webm') && r.type === 'video')).toBe(true);
    });

    it('extracts m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.odycdn.com/live/playlist.m3u8?token\\u0026expiry">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com',
        url: 'https://odysee.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.type === 'video')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://thumb.odysee.com/thumb/image.jpg?w\\u0026h">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com',
        url: 'https://odysee.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'image')).toBe(true);
    });

    it('extracts from __INITIAL_STATE__ JSON with streamingUrl', () => {
      const content: ContentScanResponse = {
        html: '__INITIAL_STATE__={"streamingUrl":"https:\\/\\/cdn.odycdn.com\\/stream\\/video.mp4?token\\u0026key"}',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com',
        url: 'https://odysee.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'odysee-stream-url')).toBe(true);
    });

    it('extracts from __INITIAL_STATE__ JSON with src/source key', () => {
      const content: ContentScanResponse = {
        html: '__INITIAL_STATE__={source:"https:\\/\\/cdn.odycdn.com\\/stream\\/clip.mp4"}',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com',
        url: 'https://odysee.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('clip.mp4') && r.metadata?.source === 'odysee-source')).toBe(true);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://cdn.odycdn.com/stream/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://odysee.com',
        url: 'https://odysee.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-odysee links', () => {
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
      const result = adapter.adjustConfidence({ url: 'https://cdn.odycdn.com/stream/video.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts m3u8 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.lbryplayer.xyz/stream/playlist.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts odysee URLs to 40 minimum', () => {
      const result = adapter.adjustConfidence({ url: 'https://thumb.odysee.com/thumb/image.jpg', confidence: 10 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-odysee URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches odysee CDN hostnames', () => {
      expect(adapter.matchesCDN('https://cdn.odycdn.com/stream/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.lbryplayer.xyz/stream/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://thumb.odysee.com/thumb/file.jpg')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.lbry.tv/stream/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
