import { describe, it, expect } from 'vitest';
import { detectUrlType, getDialogForUrl } from '../urlDetector';

describe('detectUrlType', () => {
  it('detects YouTube URLs as media', () => {
    expect(detectUrlType('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('media');
    expect(detectUrlType('https://youtu.be/dQw4w9WgXcQ')).toBe('media');
  });

  it('detects Vimeo URLs as media', () => {
    expect(detectUrlType('https://vimeo.com/123456789')).toBe('media');
  });

  it('detects TikTok URLs as media', () => {
    expect(detectUrlType('https://www.tiktok.com/@user/video/123456789')).toBe('media');
  });

  it('detects direct download URLs as download', () => {
    expect(detectUrlType('https://example.com/file.zip')).toBe('download');
    expect(detectUrlType('https://cdn.example.com/downloads/setup.exe')).toBe('download');
  });

  it('returns unknown for invalid URLs', () => {
    expect(detectUrlType('not-a-url')).toBe('unknown');
    expect(detectUrlType('')).toBe('unknown');
  });

  it('detects SoundCloud URLs as media', () => {
    expect(detectUrlType('https://soundcloud.com/artist/track')).toBe('media');
  });

  it('detects Instagram reels as media', () => {
    expect(detectUrlType('https://www.instagram.com/reel/ABC123/')).toBe('media');
  });

  it('detects Twitter/X status URLs as media', () => {
    expect(detectUrlType('https://twitter.com/user/status/123456789')).toBe('media');
    expect(detectUrlType('https://x.com/user/status/123456789')).toBe('media');
  });
});

describe('getDialogForUrl', () => {
  it('returns mediaDownload for media URLs', () => {
    expect(getDialogForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('mediaDownload');
  });

  it('returns addDownload for download URLs', () => {
    expect(getDialogForUrl('https://example.com/file.zip')).toBe('addDownload');
  });
});
