import type { TorrentOpenRequest } from '../api/tauriClient';

function requestKey(request: TorrentOpenRequest): string {
  return `${request.kind}:\u0000${request.value}`;
}

export interface TorrentSystemOpenQueue {
  enqueue: (request: TorrentOpenRequest) => void;
  enqueueMany: (requests: TorrentOpenRequest[]) => void;
  releaseActive: () => void;
  flush: () => void;
  pendingCount: () => number;
}

export function createTorrentSystemOpenQueue(
  isDialogBusy: () => boolean,
  openRequest: (request: TorrentOpenRequest) => void,
): TorrentSystemOpenQueue {
  const pending: TorrentOpenRequest[] = [];
  let activeKey: string | null = null;

  const flush = () => {
    if (activeKey !== null || isDialogBusy()) return;
    const next = pending.shift();
    if (!next) return;

    activeKey = requestKey(next);
    openRequest(next);
  };

  const enqueue = (request: TorrentOpenRequest) => {
    const key = requestKey(request);
    if (activeKey === key || pending.some((item) => requestKey(item) === key)) return;
    pending.push(request);
    flush();
  };

  return {
    enqueue,
    enqueueMany: (requests) => {
      for (const request of requests) enqueue(request);
    },
    releaseActive: () => {
      activeKey = null;
      flush();
    },
    flush,
    pendingCount: () => pending.length,
  };
}
