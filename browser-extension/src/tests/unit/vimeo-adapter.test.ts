import { describe, expect, it } from 'vitest';
import { VimeoAdapter } from '../../platforms/vimeo-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('VimeoAdapter', () => {
  const adapter = new VimeoAdapter();

  describe('extractFromScan', () => {
    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><source src="https://fpdl.vimeocdn.net/vimeo/123/456.m3u8?token=abc"></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/12345678',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'vimeo-hls');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.m3u8');
      expect(match!.mimeType).toBe('application/vnd.apple.mpegurl');
      expect(match!.type).toBe('video');
    });

    it('extracts MP4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://fpdl.vimeocdn.net/vimeo/789/012.mp4?token=xyz"></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/12345678',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'vimeo-mp4');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts video ID from HTML URLs', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://vimeo.com/87654321">video</a>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/87654321',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'vimeo-id');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://vimeo.com/87654321');
      expect(match!.metadata!.videoId).toBe('87654321');
    });

    it('extracts video ID from player.vimeo.com URLs', () => {
      const content: ContentScanResponse = {
        html: '<iframe src="https://player.vimeo.com/video/11223344"></iframe>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/11223344',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'vimeo-player');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://vimeo.com/11223344');
      expect(match!.metadata!.videoId).toBe('11223344');
    });

    it('deduplicates video IDs from multiple HTML patterns', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://vimeo.com/12345">link</a><iframe src="https://player.vimeo.com/video/12345"></iframe>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/12345',
      };
      const results = adapter.extractFromScan(content);
      const idMatches = results.filter((r) => r.metadata?.source === 'vimeo-id' || r.metadata?.source === 'vimeo-player');
      expect(idMatches.length).toBeGreaterThanOrEqual(1);
    });

    it('extracts from DOM links on vimeocdn.net', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://fpdl.vimeocdn.net/vimeo/123/456.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/12345678',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts from openGraph og:video entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://vimeo.com/99887766', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/99887766',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://vimeo.com/99887766');
      expect(match!.metadata!.videoId).toBe('99887766');
    });

    it('extracts from openGraph twitter:player entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://vimeo.com/55667788', tag: 'meta', attr: 'twitter:player' }],
        jsonLd: [],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/55667788',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.metadata!.videoId).toBe('55667788');
    });

    it('extracts from jsonLd VideoObject entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [{ '@type': 'VideoObject', contentUrl: 'https://vimeo.com/12345678', name: 'Test Video' }],
        baseUrl: 'https://vimeo.com',
        url: 'https://vimeo.com/12345678',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'jsonld');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://vimeo.com/12345678');
      expect(match!.metadata!.videoId).toBe('12345678');
      expect(match!.type).toBe('video');
    });

    it('ignores non-vimeo jsonLd entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [{ '@type': 'VideoObject', contentUrl: 'https://example.com/video.mp4', name: 'Other' }],
        baseUrl: 'https://example.com',
        url: 'https://example.com',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'jsonld');
      expect(match).toBeUndefined();
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });

    it('ignores non-vimeo links', () => {
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
  });

  describe('adjustConfidence', () => {
    it('boosts vimeocdn.net mp4 URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://fpdl.vimeocdn.net/vimeo/123/456.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts vimeocdn.net m3u8 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://fpdl.vimeocdn.net/vimeo/123/456.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts vimeocdn.net other URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://i.vimeocdn.net/video/cover.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('boosts vimeo.com/videoId URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://vimeo.com/12345678', confidence: 20 } as Candidate);
      expect(result).toBe(55);
    });

    it('adds 5 for non-vimeo URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles empty URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches vimeo CDN hostnames', () => {
      expect(adapter.matchesCDN('https://fpdl.vimeocdn.com/vimeo/123/456.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://i.vimeocdn.com/video/cover.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
