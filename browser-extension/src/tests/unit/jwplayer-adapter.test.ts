import { describe, expect, it } from 'vitest';
import { JwPlayerAdapter } from '../../platforms/jwplayer-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('JwPlayerAdapter', () => {
  const adapter = new JwPlayerAdapter();

  describe('extractFromScan', () => {
    it('extracts MP4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://content.jwplatform.com/videos/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.metadata?.source).toBe('jwplatform-mp4');
    });

    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://content.jwplatform.com/hls/video.m3u8">',
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

    it('extracts manifest URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.jwplayer.com/manifests/abc123.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'jwplayer-manifest');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts feed URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.jwplayer.com/v2/media/abc123">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'jwplayer-feed');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts from jwplayer setup JS', () => {
      const html = '<div>jwplayer("player").setup({file:"https://content.jwplatform.com/videos/video.mp4"})</div>';
      const setupRe = /jwplayer\([^)]+\)\.setup\(\s*\{([^}]+)\}/gi;
      const matches = [...html.matchAll(setupRe)];
      expect(matches.length).toBe(1);
      expect(matches[0]![1]).toContain('file:');
      const content: ContentScanResponse = {
        html,
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url === 'https://content.jwplatform.com/videos/video.mp4');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(['jwplayer-setup', 'jwplatform-mp4']).toContain(match!.metadata?.source);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://sub.content.jwplatform.com/videos/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-JW links', () => {
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
    it('boosts content.jwplatform.com URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://content.jwplatform.com/videos/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts cdn.jwplayer.com URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.jwplayer.com/manifests/abc.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts cloud.jwplayer.com URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://cloud.jwplayer.com/videos/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(55);
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
    it('matches JW Player CDN hostnames', () => {
      expect(adapter.matchesCDN('https://sub.jwplayer.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://sub.content.jwplatform.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.jwplayer.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cloud.jwplayer.com/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
