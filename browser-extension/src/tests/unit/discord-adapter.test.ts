import { describe, expect, it } from 'vitest';
import { DiscordAdapter } from '../../platforms/discord-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('DiscordAdapter', () => {
  const adapter = new DiscordAdapter();

  describe('extractFromScan', () => {
    it('extracts CDN attachment URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://cdn.discordapp.com/attachments/123/456/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://discord.com/channels/123',
        url: 'https://discord.com/channels/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.url === 'https://cdn.discordapp.com/attachments/123/456/video.mp4');
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts video URLs from HTML patterns', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://cdn.discord.com/attachments/789/012/clip.webm">clip</a>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://discord.com',
        url: 'https://discord.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.webm') && r.type === 'video')).toBe(true);
    });

    it('extracts audio URLs from HTML patterns', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://media.discordapp.net/audio/record.mp3">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://discord.com',
        url: 'https://discord.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp3') && r.type === 'audio')).toBe(true);
    });

    it('extracts image URLs from HTML patterns', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://cdn.discordapp.com/attachments/111/222/image.png">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://discord.com',
        url: 'https://discord.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'image')).toBe(true);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://cdn.discordapp.com/attachments/333/444/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://discord.com',
        url: 'https://discord.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-discord links', () => {
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
    it('boosts attachment URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.discordapp.com/attachments/123/video.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts video URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn.discord.com/video.webm', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts audio URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://media.discordapp.net/audio.flac', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('adds 5 for non-discord URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches discord CDN hostnames', () => {
      expect(adapter.matchesCDN('https://cdn.discordapp.com/attachments/1/2/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://media.discordapp.net/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.discord.com/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
