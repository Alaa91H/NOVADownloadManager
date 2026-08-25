import { describe, it, expect } from 'vitest';
import {
  expandUrlPattern,
  expandUrlList,
  countUrlPattern,
  countUrlList,
  deduplicateUrlList,
  MAX_EXPANDED_URLS,
} from '../urlPatternExpander';

describe('expandUrlPattern', () => {
  it('returns a single URL unchanged when no pattern present', () => {
    expect(expandUrlPattern('https://example.com/file.zip')).toEqual(['https://example.com/file.zip']);
  });

  it('expands numeric ranges', () => {
    expect(expandUrlPattern('file[1-3].zip')).toEqual(['file1.zip', 'file2.zip', 'file3.zip']);
  });

  it('zero-pads based on the widest bound', () => {
    expect(expandUrlPattern('file[01-10].zip')).toEqual([
      'file01.zip',
      'file02.zip',
      'file03.zip',
      'file04.zip',
      'file05.zip',
      'file06.zip',
      'file07.zip',
      'file08.zip',
      'file09.zip',
      'file10.zip',
    ]);
  });

  it('expands letter ranges', () => {
    expect(expandUrlPattern('img[a-c].png')).toEqual(['imga.png', 'imgb.png', 'imgc.png']);
  });

  it('handles descending numeric ranges', () => {
    expect(expandUrlPattern('file[3-1].zip')).toEqual(['file1.zip', 'file2.zip', 'file3.zip']);
  });

  it('supports a step suffix', () => {
    expect(expandUrlPattern('file[1-10:2].zip')).toEqual([
      'file01.zip',
      'file03.zip',
      'file05.zip',
      'file07.zip',
      'file09.zip',
    ]);
  });

  it('computes the cartesian product of multiple brackets', () => {
    expect(expandUrlPattern('file[1-2]_[a-b].zip')).toEqual([
      'file1_a.zip',
      'file1_b.zip',
      'file2_a.zip',
      'file2_b.zip',
    ]);
  });

  it('keeps the trailing literal suffix', () => {
    expect(expandUrlPattern('file[1-2].zip?download=1')).toEqual(['file1.zip?download=1', 'file2.zip?download=1']);
  });

  it('treats non-range brackets as literal text', () => {
    expect(expandUrlPattern('file[abc].zip')).toEqual(['fileabc.zip']);
  });
});

describe('countUrlPattern', () => {
  it('counts without materializing and matches expansion', () => {
    expect(countUrlPattern('file[1-3].zip')).toBe(3);
    expect(countUrlPattern('file[1-10:2].zip')).toBe(5);
    expect(countUrlPattern('file[1-2]_[a-b].zip')).toBe(4);
    expect(countUrlPattern('https://example.com/file.zip')).toBe(1);
    expect(countUrlPattern('file[abc].zip')).toBe(1);
  });

  it('throws when a pattern exceeds the cap, like expansion', () => {
    expect(() => countUrlPattern('file[1-999999999].zip')).toThrow(RangeError);
    expect(() => countUrlPattern('file[1-100]_[1-100]_[1-100].zip')).toThrow(RangeError);
  });
});

describe('countUrlList', () => {
  it('sums per-line counts without materializing', () => {
    expect(countUrlList('file[1-2].zip\nfile[x-z].txt')).toBe(5);
    expect(countUrlList('file[1-3].zip')).toBe(3);
    expect(countUrlList('')).toBe(0);
  });

  it('throws when lines together exceed the cap, like expansion', () => {
    const half = `file[1-${String(MAX_EXPANDED_URLS / 2 + 1)}].zip`;
    expect(() => countUrlList(`${half}\n${half}`)).toThrow(RangeError);
  });
});

describe('deduplicateUrlList', () => {
  it('keeps the first occurrence of every exact URL in input order', () => {
    expect(
      deduplicateUrlList([
        'https://example.com/a.zip',
        'https://example.com/b.zip',
        'https://example.com/a.zip',
        'https://example.com/c.zip',
        'https://example.com/b.zip',
      ]),
    ).toEqual({
      urls: ['https://example.com/a.zip', 'https://example.com/b.zip', 'https://example.com/c.zip'],
      duplicateCount: 2,
    });
  });

  it('uses exact matching without rewriting signed or case-sensitive URLs', () => {
    expect(
      deduplicateUrlList([
        'https://example.com/file?signature=ABC',
        'https://example.com/file?signature=abc',
        'https://example.com/file?signature=ABC',
      ]),
    ).toEqual({
      urls: ['https://example.com/file?signature=ABC', 'https://example.com/file?signature=abc'],
      duplicateCount: 1,
    });
  });
});

describe('expansion caps', () => {
  it('throws when a single numeric range exceeds the cap', () => {
    expect(() => expandUrlPattern('file[1-999999999].zip')).toThrow(RangeError);
  });

  it('throws when the cartesian product exceeds the cap', () => {
    // 100 × 100 × 100 = 1,000,000 ≫ 10,000
    expect(() => expandUrlPattern('file[1-100]_[1-100]_[1-100].zip')).toThrow(RangeError);
  });

  it('allows expansion up to exactly the cap', () => {
    const urls = expandUrlPattern(`file[1-${String(MAX_EXPANDED_URLS)}].zip`);
    expect(urls).toHaveLength(MAX_EXPANDED_URLS);
    expect(urls[0]).toBe('file00001.zip');
    expect(urls[MAX_EXPANDED_URLS - 1]).toBe(`file${String(MAX_EXPANDED_URLS)}.zip`);
  });

  it('throws when multiple lines together exceed the cap', () => {
    const half = `file[1-${String(MAX_EXPANDED_URLS / 2 + 1)}].zip`;
    expect(() => expandUrlList(`${half}\n${half}`)).toThrow(RangeError);
  });
});

describe('expandUrlList', () => {
  it('expands each non-empty line', () => {
    const input = 'file[1-2].zip\n\n  https://example.com/a.zip  \nfile[x-z].txt';
    expect(expandUrlList(input)).toEqual([
      'file1.zip',
      'file2.zip',
      'https://example.com/a.zip',
      'filex.txt',
      'filey.txt',
      'filez.txt',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(expandUrlList('')).toEqual([]);
    expect(expandUrlList('   \n\n  ')).toEqual([]);
  });
});
