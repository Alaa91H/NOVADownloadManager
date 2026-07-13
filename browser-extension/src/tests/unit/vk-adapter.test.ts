import { describe, expect, it } from 'vitest';
import { VkAdapter } from '../../platforms/vk-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('VkAdapter', () => {
  const adapter = new VkAdapter();

  describe('extractFromScan', () => {
    it('extracts mp4 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://ps.userapi.com/impf/video.mp4?token\\u0026key">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vk.com/wall-123',
        url: 'https://vk.com/wall-123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.url.includes('video.mp4'));
      expect(match).toBeDefined();
      expect(match!.type).toBe('video');
    });

    it('extracts webm URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://ps.userapi.com/impf/clip.webm?hash\\u0026sig">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.webm') && r.type === 'video')).toBe(true);
    });

    it('extracts m3u8 URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cs5-9.userapi.com/impf/playlist.m3u8?token\\u0026expiry">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.type === 'video')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://sun9-5.mycdn.me/impf/image.jpg?w\\u0026h">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'image')).toBe(true);
    });

    it('extracts audio URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<audio src="https://ps.userapi.com/impf/audio.mp3?token\\u0026key">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'audio')).toBe(true);
    });

    it('extracts from OpenGraph og:video', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://ps.userapi.com/impf/video.mp4', tag: 'meta', attr: 'og:video' }],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'og')).toBe(true);
    });

    it('extracts from OpenGraph og:image with vk.com URL', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [],
        media: [],
        openGraph: [{ url: 'https://vk.com/thumb/image.jpg', tag: 'meta', attr: 'og:image' }],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('image.jpg') && r.metadata?.source === 'og')).toBe(true);
    });

    it('extracts from DOM links matching CDN patterns', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://ps.userapi.com/impf/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://vk.com',
        url: 'https://vk.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-vk links', () => {
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
    it('boosts mp4/webm URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://ps.userapi.com/impf/video.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts m3u8 URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://cs5-9.userapi.com/impf/stream.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts audio URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://ps.userapi.com/impf/audio.mp3', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts VK URLs to 35 minimum', () => {
      const result = adapter.adjustConfidence({ url: 'https://cs5-9.vkvideo.ru/thumb/image.jpg', confidence: 10 } as Candidate);
      expect(result).toBe(35);
    });

    it('adds 5 for non-VK URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches VK CDN hostnames', () => {
      expect(adapter.matchesCDN('https://ps.userapi.com/impf/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.vk.com/impf/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cdn.vk.me/impf/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://sun9-5.mycdn.me/impf/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://cs5-9.vkvideo.ru/impf/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
