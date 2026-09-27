import { describe, expect, it } from 'vitest';
import { KalturaAdapter } from '../../platforms/kaltura-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('KalturaAdapter', () => {
  const adapter = new KalturaAdapter();

  describe('extractFromScan', () => {
    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn.kaltura.com/hls/video.m3u8">',
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
        html: '<source src="https://cdn.kaltura.com/dash/video.mpd">',
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

    it('extracts MP4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://cdn.kaltura.com/p/123/sp/456/embed/video.mp4">download</a>',
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
    });

    it('extracts thumbnail URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://cdn.kaltura.com/p/123/thumbnail/entry_id.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('/thumbnail/'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts playManifest URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<link href="https://cdn.kaltura.com/p/123/sp/12300/playManifest/entryId/abc/format/url">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'kaltura-play-manifest');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts from kWidget embed JS', () => {
      const content: ContentScanResponse = {
        html: '<script>kWidget.embed({partnerId:12345,entryId:"abc123"});</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'kaltura-embed');
      expect(match).toBeDefined();
      expect(match!.url).toContain('/p/12345/sp/');
      expect(match!.url).toContain('/entryId/');
      expect(match!.type).toBe('video');
    });

    it('extracts from kWidget thumb JS', () => {
      const content: ContentScanResponse = {
        html: '<script>kWidget.thumb({partnerId:67890,entryId:"xyz789"});</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'kaltura-embed');
      expect(match).toBeDefined();
      expect(match!.url).toContain('/entryId/');
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://cdn.kaltura.com/p/123/sp/456/embed/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-Kaltura links', () => {
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
    it('boosts playManifest URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.kaltura.com/p/123/playManifest/entry', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts .m3u8 URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.kaltura.com/hls/video.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts .mpd URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.kaltura.com/dash/video.mpd', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts .mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.kaltura.com/p/123/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts other kaltura.com URLs to 35', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.kaltura.com/other/file.jpg', confidence: 30 } as Candidate);
      expect(result).toBe(35);
    });

    it('adds 10 for non-kaltura URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(60);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(10);
    });
  });

  describe('matchesCDN', () => {
    it('matches Kaltura CDN hostnames', () => {
      expect(adapter.matchesCDN('https://sub.kaltura.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.kaltura.com/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://deep.sub.cdn.kaltura.com/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
