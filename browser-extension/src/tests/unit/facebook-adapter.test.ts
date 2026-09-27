import { describe, expect, it } from 'vitest';
import { FacebookAdapter } from '../../platforms/facebook-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('FacebookAdapter', () => {
  const adapter = new FacebookAdapter();

  describe('extractFromScan', () => {
    it('extracts videoplayback URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://video.fbcdn.net/v/123/videoplayback?token=abc"></video></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-playback');
      expect(match).toBeDefined();
      expect(match!.url).toContain('videoplayback');
      expect(match!.type).toBe('video');
    });

    it('extracts scontent videoplayback URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://scontent.fbcdn.net/v/456/videoplayback?token=def"></video></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=456',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-playback');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts DASH manifest URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><source src="https://video.fbsbx.net/v/789/manifest.mpd?token=ghi"></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=789',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-dash');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mpd');
      expect(match!.mimeType).toBe('application/dash+xml');
      expect(match!.type).toBe('video');
    });

    it('extracts MP4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://video.fbcdn.net/v/101112/video.mp4?token=jkl"></video></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=101112',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://scontent.fbcdn.net/v/t1/image.jpg?token=mno">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=131415',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-image');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts from DOM links on fbcdn.net', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://video.fbcdn.net/v/123/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.url).toContain('video.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts from DOM links on fbsbx.com', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://video.fbsbx.com/v/456/image.jpg', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=456',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts from openGraph og:video entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://www.facebook.com/watch?v=789', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=789',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://www.facebook.com/watch?v=789');
      expect(match!.type).toBe('video');
    });

    it('extracts from openGraph og:image entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://scontent.fbcdn.net/preview.jpg', tag: 'meta', attr: 'og:image' }],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=101112',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts from openGraph og:audio entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://audio.fbcdn.net/audio.mp3', tag: 'meta', attr: 'og:audio' }],
        jsonLd: [],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=131415',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.type).toBe('audio');
    });

    it('extracts from jsonLd VideoObject entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [{ '@type': 'VideoObject', contentUrl: 'https://video.fbcdn.net/v/123/video.mp4' }],
        baseUrl: 'https://www.facebook.com',
        url: 'https://www.facebook.com/watch?v=123',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'jsonld-video');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://video.fbcdn.net/v/123/video.mp4');
      expect(match!.type).toBe('video');
    });

    it('ignores non-facebook links', () => {
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
    it('boosts fbcdn.net videoplayback/mp4 URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.fbcdn.net/v/123/videoplayback?token=abc', confidence: 20 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts fbsbx.com mp4 URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.fbsbx.com/v/123/video.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts fbcdn.net mpd URLs to 50', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.fbcdn.net/v/123/manifest.mpd', confidence: 20 } as Candidate);
      expect(result).toBe(50);
    });

    it('boosts fbcdn.net other URLs to 35', () => {
      const result = adapter.adjustConfidence({ url: 'https://scontent.fbcdn.net/preview.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(35);
    });

    it('adds 5 for non-facebook URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles empty URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches facebook CDN hostnames', () => {
      expect(adapter.matchesCDN('https://video.fbcdn.net/v/123/video.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://video.fbsbx.com/v/456/manifest.mpd')).toBe(true);
      expect(adapter.matchesCDN('https://www.facebook.com/watch?v=789')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
