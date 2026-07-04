import { describe, expect, it } from 'vitest';
import { RedditAdapter } from '../../platforms/reddit-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('RedditAdapter', () => {
  const adapter = new RedditAdapter();

  describe('extractFromScan', () => {
    it('extracts DASH_ mp4 URLs from v.redd.it HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://v.redd.it/abc123"><source src="https://v.redd.it/abc123/DASH_720.mp4"></video>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.reddit.com/r/test/comments/123',
        url: 'https://www.reddit.com/r/test/comments/123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('DASH_720.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts .mpd and .m3u8 URLs from v.redd.it HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://v.redd.it/abc123/DASHPlaylist.mpd"><source src="https://v.redd.it/abc123/HLSPlaylist.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.reddit.com',
        url: 'https://www.reddit.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mpd') && r.type === 'video')).toBe(true);
      expect(results.some((r) => r.url.includes('.m3u8') && r.type === 'video')).toBe(true);
    });

    it('extracts image URLs from i.redd.it', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://i.redd.it/abc.png">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.reddit.com',
        url: 'https://www.reddit.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('i.redd.it') && r.type === 'image')).toBe(true);
    });

    it('extracts preview images from preview.redd.it', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://preview.redd.it/abc.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.reddit.com',
        url: 'https://www.reddit.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('preview.redd.it') && r.type === 'image')).toBe(true);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://v.redd.it/abc123', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.reddit.com',
        url: 'https://www.reddit.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('v.redd.it') && r.metadata?.source === 'dom-link-reddit-video')).toBe(true);
    });

    it('extracts i.redd.it from DOM links', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://i.redd.it/xyz.jpg', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.reddit.com',
        url: 'https://www.reddit.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('i.redd.it') && r.metadata?.source === 'dom-link-reddit-image')).toBe(true);
    });

    it('extracts from jsonLd VideoObject with contentUrl', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [{ '@type': 'VideoObject', contentUrl: 'https://v.redd.it/abc123' }],
        baseUrl: 'https://www.reddit.com',
        url: 'https://www.reddit.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('v.redd.it') && r.metadata?.source === 'jsonld')).toBe(true);
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });
  });

  describe('adjustConfidence', () => {
    it('boosts v.redd.it DASH/m3u8/mpd URLs to 70', () => {
      const result = adapter.adjustConfidence({ url: 'https://v.redd.it/abc/DASH_720.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(70);
    });

    it('boosts v.redd.it base URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://v.redd.it/abc123', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts i.redd.it URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://i.redd.it/abc.png', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts preview.redd.it URLs to 30', () => {
      const result = adapter.adjustConfidence({ url: 'https://preview.redd.it/abc.jpg', confidence: 10 } as Candidate);
      expect(result).toBe(30);
    });

    it('adds 5 for non-reddit URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });
  });

  describe('matchesCDN', () => {
    it('matches reddit CDN hostnames', () => {
      expect(adapter.matchesCDN('https://v.redd.it/abc.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://i.redd.it/abc.png')).toBe(true);
      expect(adapter.matchesCDN('https://preview.redd.it/abc.jpg')).toBe(true);
      expect(adapter.matchesCDN('https://www.redditmedia.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://www.redditstatic.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://thumbs.redditmedia.com/abc.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
      expect(adapter.matchesCDN('https://www.reddit.com/r/test')).toBe(false);
    });
  });
});
