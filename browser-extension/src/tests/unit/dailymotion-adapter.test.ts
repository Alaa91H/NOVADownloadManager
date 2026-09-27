import { describe, expect, it } from 'vitest';
import { DailymotionAdapter } from '../../platforms/dailymotion-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('DailymotionAdapter', () => {
  const adapter = new DailymotionAdapter();

  describe('extractFromScan', () => {
    it('extracts dmcdn.net mp4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://www.dmcdn.net/video/abc123.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.dailymotion.com/video/abc123',
        url: 'https://www.dailymotion.com/video/abc123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('dmcdn.net') && r.url.includes('.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts dmcdn.net m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://www.dmcdn.net/video/abc.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.dailymotion.com',
        url: 'https://www.dailymotion.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.type === 'video')).toBe(true);
    });

    it('extracts video ID from dailymotion.com/video/xxx', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://www.dailymotion.com/video/xyz789">video</a>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.dailymotion.com',
        url: 'https://www.dailymotion.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video/xyz789') && r.metadata?.source === 'dailymotion-id')).toBe(true);
    });

    it('extracts video ID from player.dailymotion.com', () => {
      const content: ContentScanResponse = {
        html: '<iframe src="https://player.dailymotion.com/embed/abc123"></iframe>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.dailymotion.com',
        url: 'https://www.dailymotion.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video/abc123') && r.metadata?.source === 'dailymotion-player')).toBe(true);
    });

    it('extracts from openGraph og:video', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://www.dmcdn.net/og_video.mp4', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://www.dailymotion.com',
        url: 'https://www.dailymotion.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('dmcdn.net') && r.metadata?.source === 'og')).toBe(true);
    });

    it('extracts from DOM links matching dmcdn.net', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://www.dmcdn.net/video/abc.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.dailymotion.com',
        url: 'https://www.dailymotion.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('dmcdn.net') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });
  });

  describe('adjustConfidence', () => {
    it('boosts dmcdn.net mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://www.dmcdn.net/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts dmcdn.net m3u8 URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://www.dmcdn.net/manifest.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts dailymotion.com/video URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://www.dailymotion.com/video/abc123', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('adds 5 for non-dailymotion URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });
  });

  describe('matchesCDN', () => {
    it('matches dailymotion CDN hostnames', () => {
      expect(adapter.matchesCDN('https://www.dmcdn.net/video.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://www.dailymotion.com/video/abc')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
