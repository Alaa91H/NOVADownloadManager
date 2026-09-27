import { describe, expect, it } from 'vitest';
import {
  abbreviateSha256,
  sanitizeProbeOrigin,
  shouldShowDownloadProbeInspection,
  summarizeDownloadProbe,
} from '../downloadProbeInspection';

describe('download probe inspection', () => {
  it('removes credentials, paths, queries, and fragments from probe origins', () => {
    expect(sanitizeProbeOrigin('https://user:secret@example.test/signed/file?token=abc#fragment')).toBe(
      'https://example.test',
    );
    expect(sanitizeProbeOrigin('ftp://example.test/file.zip')).toBeUndefined();
    expect(sanitizeProbeOrigin('not a URL')).toBeUndefined();
  });

  it('creates a safe technical summary from known daemon probe fields', () => {
    const digest = 'a'.repeat(64);
    const summary = summarizeDownloadProbe({
      url: 'https://landing.example.test/request?tracking=secret',
      finalUrl: 'https://cdn.example.test/file.iso?signature=private',
      contentType: 'application/octet-stream; charset=binary',
      resumable: true,
      digestSha256: digest.toUpperCase(),
      httpStatus: 206,
      linkMirrors: [
        'https://mirror-one.example.test/file.iso?token=private',
        'https://mirror-two.example.test/file.iso',
        'ftp://unsupported.example.test/file.iso',
      ],
    });

    expect(summary).toEqual({
      sourceOrigin: 'https://landing.example.test',
      finalOrigin: 'https://cdn.example.test',
      redirected: true,
      contentType: 'application/octet-stream',
      resumable: true,
      digestSha256: digest,
      httpStatus: 206,
      mirrorCount: 2,
    });
  });

  it('drops malformed technical fields instead of presenting untrusted values', () => {
    const summary = summarizeDownloadProbe({
      url: 'https://example.test/file',
      finalUrl: 'https://example.test/file',
      contentType: '   ',
      resumable: false,
      digestSha256: 'not-a-checksum',
      httpStatus: 99,
      linkMirrors: ['javascript:alert(1)'],
    });

    expect(summary.contentType).toBeUndefined();
    expect(summary.digestSha256).toBeUndefined();
    expect(summary.httpStatus).toBeUndefined();
    expect(summary.mirrorCount).toBe(0);
    expect(summary.redirected).toBe(false);
  });

  it('keeps the inspection hidden while a probe is incomplete or refreshing', () => {
    const inspection = summarizeDownloadProbe({ url: 'https://example.test/file', resumable: true });

    expect(shouldShowDownloadProbeInspection(inspection, false, false)).toBe(false);
    expect(shouldShowDownloadProbeInspection(inspection, true, true)).toBe(false);
    expect(shouldShowDownloadProbeInspection(inspection, true, false)).toBe(true);
    expect(shouldShowDownloadProbeInspection(null, true, false)).toBe(false);
  });

  it('abbreviates a verified checksum without mutating short values', () => {
    expect(abbreviateSha256('a'.repeat(64))).toBe('aaaaaaaaaaaa…');
    expect(abbreviateSha256('abc')).toBe('abc');
  });
});
