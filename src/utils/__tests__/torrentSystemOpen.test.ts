import { describe, expect, it, vi } from 'vitest';

import type { TorrentOpenRequest } from '../../api/tauriClient';
import { createTorrentSystemOpenQueue } from '../torrentSystemOpen';

describe('torrent system-open queue', () => {
  it('opens system sources sequentially without dropping later requests', () => {
    let busy = false;
    const opened: TorrentOpenRequest[] = [];
    const queue = createTorrentSystemOpenQueue(
      () => busy,
      (request) => {
        busy = true;
        opened.push(request);
      },
    );

    const magnet: TorrentOpenRequest = {
      kind: 'magnet',
      value: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111',
    };
    const file: TorrentOpenRequest = { kind: 'file', value: 'C:\\Downloads\\sample.torrent' };

    queue.enqueueMany([magnet, file]);

    expect(opened).toEqual([magnet]);
    expect(queue.pendingCount()).toBe(1);

    busy = false;
    queue.releaseActive();

    expect(opened).toEqual([magnet, file]);
    expect(queue.pendingCount()).toBe(0);
  });

  it('deduplicates the active request and queued duplicates', () => {
    let busy = false;
    const open = vi.fn(() => {
      busy = true;
    });
    const queue = createTorrentSystemOpenQueue(() => busy, open);
    const request: TorrentOpenRequest = {
      kind: 'magnet',
      value: 'magnet:?xt=urn:btih:2222222222222222222222222222222222222222',
    };

    queue.enqueue(request);
    queue.enqueue(request);
    queue.enqueue(request);

    expect(open).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(0);
  });
});
