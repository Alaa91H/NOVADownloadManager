import { describe, expect, it } from 'vitest';
import { BrightcoveAdapter } from '../../platforms/brightcove-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('BrightcoveAdapter', () => {
  const adapter = new BrightcoveAdapter();

  describe('extractFromScan', () => {
    it('extracts CDN MP4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://ams.bcovcdn.com/videos/video.mp4?token=abc">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.url.startsWith('https://ams.bcovcdn.com') && r.url.includes('.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.metadata?.source).toBe('bc-mp4');
    });

    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://ams.bcovcdn.com/hls/video.m3u8?format=url">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.m3u8'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.mimeType).toBe('application/vnd.apple.mpegurl');
    });

    it('extracts DASH URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://ams.bcovcdn.com/dash/video.mpd?foo=bar">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.mpd'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.mimeType).toBe('application/dash+xml');
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://img.brightcove.net/photos/thumbnail.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('brightcove.net') && r.url.includes('.jpg'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts from player embed URLs', () => {
      const content: ContentScanResponse = {
        html: '<iframe src="https://players.brightcove.net/12345678/abcdef_default/index.html?videoId=98765432"></iframe>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'bc-player-embed');
      expect(match).toBeDefined();
      expect(match!.url).toContain('players.brightcove.net');
      expect(match!.url).toContain('videoId=98765432');
      expect(match!.type).toBe('video');
    });

    it('extracts from config JSON with policyKey/accountId/videoId', () => {
      const content: ContentScanResponse = {
        html: '<script>{"policyKey":"pk123","accountId":"55555","videoId":"99999"}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'bc-playback-api');
      expect(match).toBeDefined();
      expect(match!.url).toContain('edge.api.brightcove.com');
      expect(match!.url).toContain('accounts/55555/videos/99999');
      expect(match!.type).toBe('video');
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://files.bcovcdn.com/videos/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-Brightcove links', () => {
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
    it('boosts bcovcdn.com URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://ams.bcovcdn.com/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts edge.api.brightcove.com URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://edge.api.brightcove.com/playback/v1/accounts/123/videos/456', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts brightcove.net media URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://img.brightcove.net/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('adds 10 for non-matching URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(60);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(10);
    });
  });

  describe('matchesCDN', () => {
    it('matches Brightcove CDN hostnames', () => {
      expect(adapter.matchesCDN('https://sub.brightcove.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://xyz.brightcove.net/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://xyz.bcovcdn.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://xyz.bcove.video/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
