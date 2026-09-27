import { describe, expect, it } from 'vitest';
import { TwitterAdapter } from '../../platforms/twitter-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('TwitterAdapter', () => {
  const adapter = new TwitterAdapter();

  describe('extractFromScan', () => {
    it('extracts video.twimg.com m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://video.twimg.com/ext_tw_video/123/pu/pl/manifest.m3u8?tag=14">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://twitter.com/user/status/123',
        url: 'https://twitter.com/user/status/123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.m3u8'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.mimeType).toBe('application/vnd.apple.mpegurl');
    });

    it('extracts video.twimg.com mp4 URLs with \\u0026 escaping', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://video.twimg.com/ext_tw_video/456/pu/vid/avc1/720.mp4\\u0026tag=12">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://twitter.com',
        url: 'https://twitter.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp4') && r.type === 'video')).toBe(true);
    });

    it('extracts from openGraph twitter:player', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://video.twimg.com/player.mp4', tag: 'meta', attr: 'twitter:player' }],
        jsonLd: [],
        baseUrl: 'https://twitter.com',
        url: 'https://twitter.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('twimg.com') && r.metadata?.source === 'twitter-card')).toBe(true);
    });

    it('extracts from openGraph og:video', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://video.twimg.com/og_video.mp4', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://twitter.com',
        url: 'https://twitter.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('twimg.com') && r.metadata?.source === 'og')).toBe(true);
    });

    it('extracts from jsonLd VideoObject', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [{ '@type': 'VideoObject', contentUrl: 'https://video.twimg.com/video.mp4' }],
        baseUrl: 'https://twitter.com',
        url: 'https://twitter.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('twimg.com') && r.metadata?.source === 'jsonld')).toBe(true);
    });

    it('extracts from pbs.twimg.com DOM links', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://pbs.twimg.com/media/abc.jpg', tag: 'img' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://twitter.com',
        url: 'https://twitter.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('pbs.twimg.com') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('extracts from __NEXT_DATA__ script', () => {
      const content: ContentScanResponse = {
        html: '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"media":{"url":"https://video.twimg.com/next_video.mp4","type":"video"}}}}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://twitter.com',
        url: 'https://twitter.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('next_video.mp4') && r.metadata?.source === 'next-data')).toBe(true);
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });
  });

  describe('adjustConfidence', () => {
    it('boosts video.twimg.com mp4 URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.twimg.com/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts video.twimg.com m3u8 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.twimg.com/manifest.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts pbs.twimg.com URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://pbs.twimg.com/media/abc.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-twitter URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });
  });

  describe('matchesCDN', () => {
    it('matches twimg.com CDN hostnames', () => {
      expect(adapter.matchesCDN('https://video.twimg.com/video.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://pbs.twimg.com/media/abc.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
