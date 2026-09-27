import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../../transport/http-transport';

describe('HttpTransport loopback discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps scanning after an earlier port fails and adopts a later reachable port', async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:3200/')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return Promise.reject(new TypeError('connection refused'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport();
    await expect(transport.isAvailable()).resolves.toBe(true);
    expect(transport.url('/v1/ping')).toBe('http://127.0.0.1:3200/v1/ping');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3200/v1/ping',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
