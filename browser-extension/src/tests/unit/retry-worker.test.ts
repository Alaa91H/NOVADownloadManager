import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandoffJob } from '../../outbox/handoff-job';
import { OutboxStore } from '../../outbox/outbox-store';
import { OutboxRetryWorker, MAX_ATTEMPTS, retryDelayMs } from '../../outbox/retry-worker';

function fakeBridge(sendOk = true) {
  return {
    sendCandidateNow: sendOk
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    sendBatchNow: sendOk
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `j-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `ik-${Math.random().toString(36).slice(2)}`,
    candidateIds: ['c1'],
    payload: { id: 'c1', url: 'https://example.com/v.mp4', source: 'dom', mediaType: 'video', confidence: 75, createdAt: now },
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as HandoffJob;
}

describe('OutboxRetryWorker', () => {
  let store: OutboxStore;

  beforeEach(async () => {
    store = new OutboxStore();
    await store.clearAll();
  });

  afterEach(async () => {
    await store.clearAll();
  });

  it('sends a pending job successfully and marks it sent', async () => {
    const bridge = fakeBridge(true);
    const job = makeJob();
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.status).toBe('sent');
    expect(bridge.sendCandidateNow).toHaveBeenCalledTimes(1);
  });

  it('sends a batch job when payload has multiple candidates', async () => {
    const bridge = fakeBridge(true);
    const job = makeJob({
      candidateIds: ['c1', 'c2'],
        payload: [
        { id: 'c1', url: 'https://example.com/a.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() },
        { id: 'c2', url: 'https://example.com/b.mp4', source: 'dom' as const, mediaType: 'video' as const, confidence: 75, createdAt: new Date().toISOString() },
      ],
    });
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.status).toBe('sent');
    expect(bridge.sendBatchNow).toHaveBeenCalledTimes(1);
  });

  it('moves invalid payload to dead-letter', async () => {
    const bridge = fakeBridge(true);
    const job = makeJob({ payload: 'not-a-valid-candidate' });
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.status).toBe('dead-letter');
    expect(updated?.lastError).toBe('invalid payload');
  });

  it('marks failed jobs as dead-letter after max attempts', async () => {
    const bridge = fakeBridge(false);
    const job = makeJob({ attempts: MAX_ATTEMPTS - 1 });
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.status).toBe('dead-letter');
    expect(updated?.attempts).toBe(MAX_ATTEMPTS);
  });

  it('marks non-retryable errors as dead-letter immediately', async () => {
    const bridge = {
      sendCandidateNow: vi.fn().mockRejectedValue(Object.assign(new Error('NOT_AUTH'), { code: 'AUTH_REQUIRED' })),
      sendBatchNow: vi.fn().mockRejectedValue(Object.assign(new Error('NOT_AUTH'), { code: 'AUTH_REQUIRED' })),
    };
    const job = makeJob();
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.status).toBe('dead-letter');
  });

  it('sets nextRetryAt for retryable failures', async () => {
    const bridge = fakeBridge(false);
    const before = Date.now();
    const job = makeJob();
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.nextRetryAt).toBeDefined();
    expect(new Date(updated!.nextRetryAt!).getTime()).toBeGreaterThan(before);
  });

  it('releases lease after processing', async () => {
    const bridge = fakeBridge(true);
    const job = makeJob();
    await store.add(job);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    const updated = await store.get(job.id);
    expect(updated?.leaseOwner).toBeUndefined();
    expect(updated?.leaseExpiresAt).toBeUndefined();
  });

  it('runs maintenance before processing', async () => {
    const bridge = fakeBridge(true);
    const oldSent = makeJob({ id: 'old-sent', status: 'sent', updatedAt: new Date('2020-01-01').toISOString() });
    await store.add(oldSent);
    const worker = new OutboxRetryWorker(store, bridge as never);
    await worker.runOnce();
    expect(await store.get('old-sent')).toBeUndefined();
  });
});

describe('retryDelayMs (deterministic)', () => {
  it('returns base delay for attempt 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delay = retryDelayMs(1);
    expect(delay).toBe(2000);
    vi.restoreAllMocks();
  });

  it('returns capped delay for attempt > MAX_ATTEMPTS', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delay = retryDelayMs(MAX_ATTEMPTS + 10);
    expect(delay).toBe(60000);
    vi.restoreAllMocks();
  });
});
