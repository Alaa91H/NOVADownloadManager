import { describe, expect, it } from 'vitest';
import { TwitchAdapter } from '../../platforms/twitch-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('TwitchAdapter', () => {
  const adapter = new TwitchAdapter();

  describe('extractFromScan', () => {
    it('extracts HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><video src="https://video.twitchcdn.net/vod/123.m3u8?token=abc"></video></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'twitch-hls');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.m3u8');
      expect(match!.mimeType).toBe('application/vnd.apple.mpegurl');
      expect(match!.type).toBe('video');
    });

    it('extracts MP4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<html><source src="https://video.ttvnw.net/vod/clip.mp4?token=xyz"></html>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'twitch-mp4');
      expect(match).toBeDefined();
      expect(match!.url).toContain('.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts clip URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://clips.twitch.tv/GloriousClips123">clip</a>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'twitch-clip');
      expect(match).toBeDefined();
      expect(match!.url).toContain('clips.twitch.tv');
      expect(match!.metadata!.clipId).toBe('GloriousClips123');
    });

    it('extracts clip embed URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<iframe src="https://clips.twitch.tv/embed?clip=EmbedClip456"></iframe>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'twitch-clip');
      expect(match).toBeDefined();
      expect(match!.metadata!.clipId).toBe('EmbedClip456');
    });

    it('extracts VOD URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://www.twitch.tv/videos/987654321">vod</a>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'twitch-vod');
      expect(match).toBeDefined();
      expect(match!.metadata!.vodId).toBe('987654321');
    });

    it('extracts from DOM links on twitch CDN', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://video.twitchcdn.net/vod/clip.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'dom-link');
      expect(match).toBeDefined();
      expect(match!.url).toContain('clip.mp4');
      expect(match!.type).toBe('video');
    });

    it('extracts from openGraph video entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://www.twitch.tv/videos/123', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://www.twitch.tv/videos/123');
      expect(match!.type).toBe('video');
    });

    it('extracts from openGraph twitter:player entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://clips.twitch.tv/Clip123', tag: 'meta', attr: 'twitter:player' }],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
      expect(match!.url).toBe('https://clips.twitch.tv/Clip123');
    });

    it('extracts from openGraph image entries', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://static.twitchcdn.net/preview.jpg', tag: 'meta', attr: 'og:image' }],
        jsonLd: [],
        baseUrl: 'https://www.twitch.tv',
        url: 'https://www.twitch.tv/test',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.metadata?.source === 'og');
      expect(match).toBeDefined();
    });

    it('ignores non-twitch links', () => {
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
    it('boosts m3u8 URLs on twitch CDN to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.twitchcdn.net/vod/123.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts non-m3u8 CDN URLs to 45', () => {
      const result = adapter.adjustConfidence({ url: 'https://video.ttvnw.net/vod/clip.mp4', confidence: 20 } as Candidate);
      expect(result).toBe(45);
    });

    it('boosts clips.twitch.tv URLs to 70', () => {
      const result = adapter.adjustConfidence({ url: 'https://clips.twitch.tv/AmazingClip', confidence: 30 } as Candidate);
      expect(result).toBe(70);
    });

    it('boosts twitch.tv/videos URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://www.twitch.tv/videos/123456789', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('adds 5 for non-twitch URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles empty URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches twitch CDN hostnames', () => {
      expect(adapter.matchesCDN('https://video.twitchcdn.net/vod/123.m3u8')).toBe(true);
      expect(adapter.matchesCDN('https://video.ttvnw.net/vod/clip.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://video.jtvnw.net/vod/clip.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://www.twitch.tv/videos/123')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
