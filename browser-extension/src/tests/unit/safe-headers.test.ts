import { describe, expect, it } from 'vitest';
import { safeHeaders } from '../../security/safe-headers';

describe('safe headers', () => {
  it('keeps only allowed headers and normalizes values', () => {
    const headers = safeHeaders({
      'content-type': ' video/mp4\r\nX-Bad: yes ',
      'authorization': 'Bearer secret',
      'set-cookie': 'a=b',
      'content-length': '12345',
    });
    expect(headers).toEqual({ contentType: 'video/mp4 X-Bad: yes', contentLength: '12345' });
  });

  it('bounds huge header values', () => {
    const headers = safeHeaders({ etag: 'x'.repeat(5000) });
    expect(headers.etag).toHaveLength(4096);
  });
});
