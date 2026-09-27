import { describe, expect, it } from 'vitest';
import { InstagramAdapter } from '../../platforms/instagram-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('InstagramAdapter', () => {
  const adapter = new InstagramAdapter();

  describe('extractFromScan', () => {
    it('extracts video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://scontent.cdninstagram.com/v/t50/12345.mp4?token=abc"></video></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/ABC123/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://scontent.cdninstagram.com/v/t51/photo.jpg?token=def">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/DEF456/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-image');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts xx.fbcdn.net video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://scontent.xx.fbcdn.net/v/t50/67890.mp4"></video>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/GHI789/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'html-video');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts from DOM links with mp4 URLs', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://scontent.cdninstagram.com/v/t50/12345.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/ABC123/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts from DOM links with image URLs', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://scontent.cdninstagram.com/v/t51/photo.jpg', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/DEF456/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
    });

    it('extracts video from shared data (__INITIAL_STATE__)', () => {
      const content: ContentScanResponse = {
        html: '<script>window.__INITIAL_STATE__=JSON.parse(\'{"items":[{"video_url":"https://scontent.cdninstagram.com/v/t50/12345.mp4","video_duration":15.5,"video_width":720,"video_height":1280,"id":"123456789"}],"more_available":false}\');</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/ABC123/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'shared-data');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
      expect(match!.width).toBe(720);
      expect(match!.height).toBe(1280);
      expect(match!.duration).toBe(15.5);
      expect(match!.metadata!.videoId).toBe('123456789');
    });

    it('extracts video from shared data without duration', () => {
      const content: ContentScanResponse = {
        html: '<script>window.__INITIAL_STATE__=JSON.parse(\'{"items":[{"video_url":"https://scontent.cdninstagram.com/v/t50/67890.mp4","id":"987654321"}],"more_available":false}\');</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/DEF456/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'shared-data');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
      expect(match!.duration).toBeUndefined();
    });

    it('extracts image display_url from shared data', () => {
      const content: ContentScanResponse = {
        html: '<script>window.__INITIAL_STATE__=JSON.parse(\'{"items":[{"display_url":"https://scontent.cdninstagram.com/v/t51/photo.jpg","width":1080,"height":1080}],"more_available":false}\');</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/GHI789/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'shared-data');
      expect(match).toBeDefined();
      expect(match!.type).toBe('image');
      expect(match!.width).toBe(1080);
      expect(match!.height).toBe(1080);
    });

    it('extracts from __NEXT_DATA__ script', () => {
      const content: ContentScanResponse = {
        html: '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"media":{"video_url":"https://scontent.cdninstagram.com/v/t50/11111.mp4","id":"111111"}}}}</script>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.instagram.com',
        url: 'https://www.instagram.com/p/JKL012/',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'shared-data');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts from links with matching extension regardless of hostname', () => {
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
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });
  });

  describe('adjustConfidence', () => {
    it('boosts cdninstagram.com mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://scontent.cdninstagram.com/v/t50/12345.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts fbcdn.net mp4 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://scontent.xx.fbcdn.net/v/t50/67890.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts CDN non-mp4 URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://scontent.cdninstagram.com/v/t51/photo.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-instagram URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles empty URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches instagram CDN hostnames', () => {
      expect(adapter.matchesCDN('https://scontent.cdninstagram.com/v/t50/12345.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://scontent.xx.fbcdn.net/v/t50/67890.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
