import { describe, expect, it } from 'vitest';
import { logSafeUrlOrigin } from '../logSafeUrl';

describe('logSafeUrlOrigin', () => {
  it('keeps only the origin of a signed HTTP URL', () => {
    expect(
      logSafeUrlOrigin('https://release-assets.githubusercontent.com/release/file.zip?jwt=secret-token&sig=signature#fragment'),
    ).toBe('https://release-assets.githubusercontent.com');
  });

  it('does not expose embedded credentials, paths, queries, or fragments', () => {
    expect(logSafeUrlOrigin('https://user:password@example.test/private/file?access=secret#part')).toBe(
      'https://example.test',
    );
  });

  it('returns bounded labels for invalid and unsupported values', () => {
    expect(logSafeUrlOrigin('not a URL')).toBe('invalid-url');
    expect(logSafeUrlOrigin('file:///private/download.zip')).toBe('unsupported-url');
  });
});
