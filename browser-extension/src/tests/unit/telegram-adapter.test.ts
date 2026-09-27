import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../platforms/telegram-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('TelegramAdapter', () => {
  const adapter = new TelegramAdapter();

  describe('extractFromScan', () => {
    it('extracts video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://cdn-telegram.org/file/abc123/video.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://t.me/c/123',
        url: 'https://t.me/c/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp4') && r.type === 'video')).toBe(true);
    });

    it('extracts webm video URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cdn-telegram.org/file/abc123/video.webm">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://t.me/c/123',
        url: 'https://t.me/c/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.webm') && r.type === 'video')).toBe(true);
    });

    it('extracts image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://cdn-telegram.org/file/abc123/photo.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://t.me/c/123',
        url: 'https://t.me/c/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.jpg') && r.type === 'image')).toBe(true);
    });

    it('extracts audio URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<audio src="https://cdn-telegram.org/file/abc123/audio.mp3">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://t.me/c/123',
        url: 'https://t.me/c/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.mp3') && r.type === 'audio')).toBe(true);
    });

    it('extracts document URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<a href="https://cdn-telegram.org/file/abc123/doc.pdf">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://t.me/c/123',
        url: 'https://t.me/c/123',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.pdf') && r.metadata?.source === 'tg-document')).toBe(true);
    });

    it('extracts from DOM links matching CDN', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://cdn-telegram.org/file/abc123/video.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://t.me',
        url: 'https://t.me',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('video.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-telegram links', () => {
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
    it('boosts cdn-telegram video URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn-telegram.org/file/abc/video.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts cdn-telegram audio URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn-telegram.org/file/abc/audio.mp3', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts cdn-telegram image URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://cdn-telegram.org/file/abc/photo.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-telegram URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });

    it('handles missing URL gracefully', () => {
      const result = adapter.adjustConfidence({ url: '', confidence: 0 } as Candidate);
      expect(result).toBe(5);
    });
  });

  describe('matchesCDN', () => {
    it('matches telegram CDN hostnames', () => {
      expect(adapter.matchesCDN('https://web.telegram.org/file/abc.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
