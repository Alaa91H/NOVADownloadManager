import { describe, it, expect } from 'vitest';
import { extractFirstHttpUrl } from '../clipboard';

describe('extractFirstHttpUrl', () => {
  it('extracts http URL from text', () => {
    expect(extractFirstHttpUrl('Check this: http://example.com/file.zip')).toBe('http://example.com/file.zip');
  });

  it('extracts https URL from text', () => {
    expect(extractFirstHttpUrl('https://example.com/file.zip')).toBe('https://example.com/file.zip');
  });

  it('extracts URL with path', () => {
    expect(extractFirstHttpUrl('Download at https://cdn.example.com/downloads/setup.exe?ver=1.0')).toBe('https://cdn.example.com/downloads/setup.exe?ver=1.0');
  });

  it('strips trailing punctuation', () => {
    expect(extractFirstHttpUrl('Visit https://example.com, please')).toBe('https://example.com');
    expect(extractFirstHttpUrl('Check https://example.com; it works')).toBe('https://example.com');
  });

  it('returns null when no URL present', () => {
    expect(extractFirstHttpUrl('no url here')).toBeNull();
    expect(extractFirstHttpUrl('')).toBeNull();
  });

  it('extracts first URL when multiple present', () => {
    const result = extractFirstHttpUrl('https://first.com and https://second.com');
    expect(result).toBe('https://first.com');
  });

  it('handles URLs in brackets', () => {
    expect(extractFirstHttpUrl('See <https://example.com> for details')).toBe('https://example.com');
  });
});
