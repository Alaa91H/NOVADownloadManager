import { describe, expect, it } from 'vitest';
import { BilibiliAdapter } from '../../platforms/bilibili-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('BilibiliAdapter', () => {
  const adapter = new BilibiliAdapter();

  describe('extractFromScan', () => {
    it('extracts MP4/FLV URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://up.hdslb.com/videos/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.metadata?.source).toBe('bili-video');
    });

    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://up.bilivideo.com/hls/video.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.m3u8'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.mimeType).toBe('application/vnd.apple.mpegurl');
    });

    it('extracts DASH URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://up.hdslb.com/dash/video.mpd">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.mpd'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.mimeType).toBe('application/dash+xml');
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://i0.hdslb.com/bfs/archive/cover.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.jpg'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts acgvideo.com FLV URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://v.acgvideo.com/videos/video.flv">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.flv'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts from __INITIAL_STATE__ JSON', () => {
      const content: ContentScanResponse = {
        html: '<script>window.__INITIAL_STATE__={"videoData":{"pages":[{"part":{"video":{"1080p":"https://up.hdslb.com/videos/1080.mp4"}}}]}};</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'bili-initial-state');
      expect(match).toBeDefined();
      expect(match!.url).toContain('up.hdslb.com');
      expect(match!.type).toBe('video');
      expect(match!.quality).toBe('1080p');
    });

    it('extracts dash URL from __INITIAL_STATE__', () => {
      const content: ContentScanResponse = {
        html: '<script>window.__INITIAL_STATE__={"videoData":{"dash":{"video":"https://up.hdslb.com/dash/video.mpd"},"pages":[]}};</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'bili-dash-url');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mpd');
      expect(match!.type).toBe('video');
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://up.hdslb.com/videos/video.flv', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.bilibili.com',
        url: 'https://www.bilibili.com/video/BV123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.flv') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-Bilibili links', () => {
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
    it('boosts hdslb.com .mp4/.flv URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://up.hdslb.com/videos/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts bilivideo.com .m3u8/.mpd URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://up.bilivideo.com/video.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts bilivideo.cn .mpd URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://up.bilivideo.cn/video.mpd', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts acgvideo.com .flv URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://v.acgvideo.com/video.flv', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts hdslb.com other URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://i0.hdslb.com/bfs/cover.jpg', confidence: 30 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-bilibili URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches Bilibili CDN hostnames', () => {
      expect(adapter.matchesCDN('https://www.bilibili.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://www.hdslb.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://up.bilivideo.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://up.bilivideo.cn/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://sub.b23.tv/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://v.acgvideo.com/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
