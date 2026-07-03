import { describe, expect, it } from 'vitest';
import { WhatsAppAdapter } from '../../platforms/whatsapp-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('WhatsAppAdapter', () => {
  const adapter = new WhatsAppAdapter();

  describe('extractFromScan', () => {
    it('extracts media URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://mmg-fna.whatsapp.net/video/123.mp4">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://web.whatsapp.com',
        url: 'https://web.whatsapp.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('whatsapp.net') && r.type === 'video')).toBe(true);
    });

    it('extracts audio from HTML', () => {
      const content: ContentScanResponse = {
        html: '<audio src="https://mmg-fna.whatsapp.net/audio/voice.ogg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://web.whatsapp.com',
        url: 'https://web.whatsapp.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'audio')).toBe(true);
    });

    it('extracts images from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://mmg-fna.whatsapp.net/image/photo.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://web.whatsapp.com',
        url: 'https://web.whatsapp.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'image')).toBe(true);
    });

    it('extracts mixed content from HTML', () => {
      const content: ContentScanResponse = {
        html: '<video src="https://mmg-fna.whatsapp.net/video/clip.mp4"></video><audio src="https://mmg-fna.whatsapp.net/audio/voice.ogg"></audio>',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://web.whatsapp.com',
        url: 'https://web.whatsapp.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.type === 'video')).toBe(true);
      expect(results.some((r) => r.type === 'audio')).toBe(true);
    });

    it('extracts from DOM links matching whatsapp.net', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://mmg-fna.whatsapp.net/video/clip.mp4', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://web.whatsapp.com',
        url: 'https://web.whatsapp.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('clip.mp4') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('ignores non-whatsapp links', () => {
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
    it('boosts video URLs to 60', () => {
      const result = adapter.adjustConfidence({ url: 'https://mmg-fna.whatsapp.net/video/123.mp4', confidence: 30 } as Candidate);
      expect(result).toBe(60);
    });

    it('boosts audio URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://mmg-fna.whatsapp.net/audio/voice.ogg', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts image URLs to 40', () => {
      const result = adapter.adjustConfidence({ url: 'https://mmg-fna.whatsapp.net/image/photo.jpg', confidence: 20 } as Candidate);
      expect(result).toBe(40);
    });

    it('adds 5 for non-whatsapp URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp4', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });
  });

  describe('matchesCDN', () => {
    it('matches whatsapp CDN hostnames', () => {
      expect(adapter.matchesCDN('https://mmg-fna.whatsapp.net/file.mp4')).toBe(true);
      expect(adapter.matchesCDN('https://media.fbcdn.net/file.mp4')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp4')).toBe(false);
    });
  });
});
