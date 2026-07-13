import { beforeEach, describe, expect, it } from 'vitest';
import { OutboxStore } from '../../outbox/outbox-store';
import { HandoffJob } from '../../outbox/handoff-job';

function job(overrides: Partial<HandoffJob> = {}): HandoffJob {
  // Use a current timestamp so terminal (sent/dead-letter) jobs are not purged by
  // the store's retention sweep during the test.
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `job-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: overrides.idempotencyKey ?? `key-${Math.random().toString(36).slice(2)}`,
    candidateIds: overrides.candidateIds ?? ['c1'],
    payload: overrides.payload ?? { id: 'c1', url: 'https://example.com/a.zip', source: 'dom', mediaType: 'archive', confidence: 75, createdAt: now },
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? 0,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

describe('OutboxStore', () => {
  beforeEach(async () => {
    await new OutboxStore().clearAll();
  });

  it('persists jobs across store instances (survives a service-worker restart)', async () => {
    const writer = new OutboxStore();
    const enqueued = job({ id: 'durable-1' });
    await writer.add(enqueued);

    // A fresh instance models the MV3 service worker being torn down and respawned.
    const reader = new OutboxStore();
    const recovered = await reader.get('durable-1');
    expect(recovered?.id).toBe('durable-1');
    expect(recovered?.status).toBe('pending');
  });

  it('reports counts grouped by status', async () => {
    const store = new OutboxStore();
    await store.add(job({ id: 'p1', status: 'pending' }));
    await store.add(job({ id: 's1', status: 'sent' }));
    await store.add(job({ id: 'd1', status: 'dead-letter' }));

    const counts = await store.counts();
    expect(counts.pending).toBe(1);
    expect(counts.sent).toBe(1);
    expect(counts.deadLetter).toBe(1);
  });

  it('requeues a dead-letter job back to pending and resets its failure state', async () => {
    const store = new OutboxStore();
    await store.add(job({ id: 'dead-1', status: 'dead-letter', attempts: 5, lastError: 'boom', nextRetryAt: '2026-01-01T00:01:00.000Z' }));

    const recovered = await store.requeueDeadLetter('dead-1');
    expect(recovered?.status).toBe('pending');
    expect(recovered?.attempts).toBe(0);
    expect(recovered?.lastError).toBeUndefined();
    expect(recovered?.nextRetryAt).toBeUndefined();

    const dead = await store.dead();
    expect(dead).toHaveLength(0);
  });

  it('only requeues jobs that are actually in dead-letter state', async () => {
    const store = new OutboxStore();
    await store.add(job({ id: 'sent-1', status: 'sent' }));
    expect(await store.requeueDeadLetter('sent-1')).toBeUndefined();
    expect(await store.requeueDeadLetter('missing')).toBeUndefined();
  });

  it('requeues every dead-letter job and returns how many were recovered', async () => {
    const store = new OutboxStore();
    await store.add(job({ id: 'dl-1', status: 'dead-letter' }));
    await store.add(job({ id: 'dl-2', status: 'dead-letter' }));
    await store.add(job({ id: 'ok-1', status: 'pending' }));

    expect(await store.requeueAllDeadLetter()).toBe(2);
    const counts = await store.counts();
    expect(counts.deadLetter).toBe(0);
    expect(counts.pending).toBe(3);
  });
});
