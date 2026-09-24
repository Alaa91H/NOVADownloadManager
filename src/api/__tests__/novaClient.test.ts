import { describe, it, expect, vi, beforeEach } from 'vitest';
import { novaClient, setApiBase } from '../novaClient';

describe('novaClient', () => {
  beforeEach(() => {
    setApiBase('http://127.0.0.1:3199');
  });

  it('health() builds correct URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'connected', engines: { curl: {}, media: {} } }),
    });
    await novaClient.health();
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3199/api/health',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('createMediaDownload() uses the native media endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'media-task' }),
    });

    await novaClient.createMediaDownload({
      name: 'video',
      url: 'https://example.test/watch',
      mediaOptions: { mode: 'video' },
    } as never);

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3199/api/media/download',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
