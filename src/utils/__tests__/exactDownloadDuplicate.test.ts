import { describe, expect, it } from 'vitest';
import { hasExactDownloadUrlDuplicate } from '../exactDownloadDuplicate';

describe('hasExactDownloadUrlDuplicate', () => {
  it('finds an exact existing URL', () => {
    expect(
      hasExactDownloadUrlDuplicate('https://downloads.example.test/releases/nova.zip', [
        { url: 'https://downloads.example.test/releases/nova.zip' },
      ]),
    ).toBe(true);
  });

  it('does not conflate distinct signed URLs', () => {
    const existing = [{ url: 'https://cdn.example.test/release.zip?signature=first-token' }];

    expect(hasExactDownloadUrlDuplicate('https://cdn.example.test/release.zip?signature=second-token', existing)).toBe(
      false,
    );
    expect(
      hasExactDownloadUrlDuplicate('https://cdn.example.test/other/release.zip?signature=first-token', existing),
    ).toBe(false);
  });

  it('does not normalize case, paths, queries, fragments, or credentials', () => {
    const existing = [{ url: 'https://user:password@example.test/File.zip?token=A#anchor' }];

    expect(hasExactDownloadUrlDuplicate('https://example.test/File.zip?token=A#anchor', existing)).toBe(false);
    expect(hasExactDownloadUrlDuplicate('https://user:password@example.test/file.zip?token=A#anchor', existing)).toBe(
      false,
    );
  });

  it('rejects an empty submitted URL and malformed task candidates', () => {
    expect(hasExactDownloadUrlDuplicate('', [{ url: '' }, { url: null }, {}])).toBe(false);
    expect(hasExactDownloadUrlDuplicate('https://example.test/file.zip', [{ url: null }, {}])).toBe(false);
  });
});
