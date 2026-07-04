import { describe, expect, it } from 'vitest';
import { SoundCloudAdapter } from '../../platforms/soundcloud-adapter';
import type { Candidate } from '../../contracts/candidate.schema';
import type { ContentScanResponse } from '../../contracts/messages.schema';

describe('SoundCloudAdapter', () => {
  const adapter = new SoundCloudAdapter();

  describe('extractFromScan', () => {
    it('extracts sndcdn.com mp3 audio URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<audio src="https://cf-media.sndcdn.com/abc123.mp3">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://soundcloud.com/user/track-1',
        url: 'https://soundcloud.com/user/track-1',
      };
      const results = adapter.extractFromScan(content);
      const match = results.find((r) => r.url.includes('.mp3') && r.type === 'audio');
      expect(match).toBeDefined();
      expect(match!.type).toBe('audio');
    });

    it('extracts sndcdn.com m4a, flac, ogg audio URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cf-media.sndcdn.com/abc.m4a"><source src="https://cf-media.sndcdn.com/def.flac"><source src="https://cf-media.sndcdn.com/ghi.ogg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://soundcloud.com',
        url: 'https://soundcloud.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m4a') && r.type === 'audio')).toBe(true);
      expect(results.some((r) => r.url.includes('.flac') && r.type === 'audio')).toBe(true);
      expect(results.some((r) => r.url.includes('.ogg') && r.type === 'audio')).toBe(true);
    });

    it('extracts sndcdn.com m3u8 HLS URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<source src="https://cf-media.sndcdn.com/hls.m3u8">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://soundcloud.com',
        url: 'https://soundcloud.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.m3u8') && r.mimeType === 'application/vnd.apple.mpegurl')).toBe(true);
    });

    it('extracts sndcdn.com image URLs from HTML', () => {
      const content: ContentScanResponse = {
        html: '<img src="https://i1.sndcdn.com/artworks-abc-t500x500.jpg">',
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://soundcloud.com',
        url: 'https://soundcloud.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('.jpg') && r.type === 'image')).toBe(true);
    });

    it('extracts from DOM links matching sndcdn.com', () => {
      const content: ContentScanResponse = {
        html: '',
        links: [{ url: 'https://cf-media.sndcdn.com/track.mp3', tag: 'a' }],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://soundcloud.com',
        url: 'https://soundcloud.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('sndcdn.com') && r.metadata?.source === 'dom-link')).toBe(true);
    });

    it('extracts from __SC_HYDRATION JSON for audio tracks', () => {
      const content: ContentScanResponse = {
        html: `<script>window.__SC_HYDRATION = [{"hydratable":{"tracks":[{"title":"Test Track","mediaUrl":"https://cf-media.sndcdn.com/track.mp3","duration":180,"user":{"username":"ArtistName"},"artworkUrl":"https://i1.sndcdn.com/artwork.jpg"}]}}];</script>`,
        links: [],
        media: [],
        openGraph: [],
        jsonLd: [],
        baseUrl: 'https://soundcloud.com',
        url: 'https://soundcloud.com',
      };
      const results = adapter.extractFromScan(content);
      expect(results.some((r) => r.url.includes('track.mp3') && r.metadata?.source === 'sc-hydration')).toBe(true);
      expect(results.some((r) => r.url.includes('artwork.jpg') && r.metadata?.source === 'sc-hydration-artwork')).toBe(true);
    });

    it('handles empty content', () => {
      const content: ContentScanResponse = { html: '', links: [], media: [], openGraph: [], jsonLd: [], baseUrl: '', url: '' };
      const results = adapter.extractFromScan(content);
      expect(results).toHaveLength(0);
    });
  });

  describe('adjustConfidence', () => {
    it('boosts sndcdn.com audio URLs to 65', () => {
      const result = adapter.adjustConfidence({ url: 'https://cf-media.sndcdn.com/track.mp3', confidence: 30 } as Candidate);
      expect(result).toBe(65);
    });

    it('boosts sndcdn.com m3u8 URLs to 55', () => {
      const result = adapter.adjustConfidence({ url: 'https://cf-media.sndcdn.com/hls.m3u8', confidence: 30 } as Candidate);
      expect(result).toBe(55);
    });

    it('boosts soundcloud.com URLs to 50', () => {
      const result = adapter.adjustConfidence({ url: 'https://soundcloud.com/user/track', confidence: 20 } as Candidate);
      expect(result).toBe(50);
    });

    it('adds 5 for non-soundcloud URLs', () => {
      const result = adapter.adjustConfidence({ url: 'https://example.com/file.mp3', confidence: 50 } as Candidate);
      expect(result).toBe(55);
    });
  });

  describe('matchesCDN', () => {
    it('matches soundcloud CDN hostnames', () => {
      expect(adapter.matchesCDN('https://cf-media.sndcdn.com/track.mp3')).toBe(true);
      expect(adapter.matchesCDN('https://i1.sndcdn.com/artwork.jpg')).toBe(true);
    });

    it('rejects non-CDN hostnames', () => {
      expect(adapter.matchesCDN('https://example.com/file.mp3')).toBe(false);
    });
  });
});
