import { describe, expect, it } from 'vitest';
import { TumblrAdapter } from '../../platforms/tumblr-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('TumblrAdapter', () => {
  const adapter = new TumblrAdapter();

  describe('extractFromScan', () => {
    it('extracts MP4 video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://v.media.tumblr.com/tumblr_abc123/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tumblr.com/blog/123',
        url: 'https://www.tumblr.com/blog/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp4') && r.type === 'video')).toBe(true);
    });

    it('extracts HLS m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://v.vtt.tumblr.com/tumblr_abc123/hls.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tumblr.com/blog/123',
        url: 'https://www.tumblr.com/blog/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.mimeType === 'application/vnd.apple.mpegurl')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://64.media.tumblr.com/abc123/image.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tumblr.com/blog/123',
        url: 'https://www.tumblr.com/blog/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.jpg') && r.type === 'image')).toBe(true);
    });

    it('extracts static.tumblr.com image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://static.tumblr.com/abc123/photo.webp">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tumblr.com/blog/123',
        url: 'https://www.tumblr.com/blog/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('static.tumblr.com') && r.type === 'image')).toBe(true);
    });

    it('extracts audio URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<audio src="https://a.media.tumblr.com/tumblr_abc123/audio.mp3">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tumblr.com/blog/123',
        url: 'https://www.tumblr.com/blog/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp3') && r.type === 'audio')).toBe(true);
    });

    it('extracts from DOM links matching CDN', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://v.media.tumblr.com/tumblr_abc123/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.tumblr.com',
        url: 'https://www.tumblr.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-tumblr links', () => {
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
    it('boosts media.tumblr.com video URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://v.media.tumblr.com/tumblr_abc/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts media.tumblr.com audio URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://a.media.tumblr.com/tumblr_abc/audio.mp3', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts media.tumblr.com image URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://64.media.tumblr.com/abc123/image.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('boosts vtt.tumblr.com m3u8 URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://v.vtt.tumblr.com/tumblr_abc/hls.m3u8', confidence: 20 } as Candidate);
      expect(result).toBe(55);
    });

    it('adds 5 for non-tumblr URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches tumblr CDN hostnames', () => {
      expect(adapter.matchesCDN('https://v.media.tumblr.com/tumblr_abc/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://64.media.tumblr.com/abc123/image.jpg')).toBe(true);
      expect(adapter.matchesCDN('https://static.tumblr.com/abc123/file.gif')).toBe(true);
      expect(adapter.matchesCDN('https://v.vtt.tumblr.com/tumblr_abc/hls.m3u8')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
