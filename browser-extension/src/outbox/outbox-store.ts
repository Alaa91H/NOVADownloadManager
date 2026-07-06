import Dexie, { Table } from 'dexie';
import { MAX_OUTBOX_JOBS, OUTBOX_DEAD_LETTER_RETENTION_DAYS, OUTBOX_SENT_RETENTION_DAYS } from '../contracts/limits';
import { AdmExtensionError } from '../core/error-classification';
import { HandoffJob } from './handoff-job';

class OutboxDb extends Dexie {
  jobs!: Table<HandoffJob, string>;

  constructor() {
    super('adm-outbox');
    this.version(1).stores({ jobs: 'id,status,nextRetryAt,idempotencyKey,updatedAt' });
    this.version(2).stores({ jobs: 'id,status,nextRetryAt,idempotencyKey,updatedAt,leaseExpiresAt' });
  }
}

export class OutboxStore {
  private readonly db = new OutboxDb();

  async add(job: HandoffJob): Promise<void> {
    await this.addIfAbsent(job);
  }

  async addIfAbsent(job: HandoffJob): Promise<HandoffJob> {
    await this.maintenance();
    return this.db.transaction('rw', this.db.jobs, async () => {
      const existing = await this.db.jobs.where('idempotencyKey').equals(job.idempotencyKey).first();
      if (existing && existing.status !== 'dead-letter') return existing;
      await this.ensureCapacityForNewJob(false);
      await this.db.jobs.put(job);
      return job;
    });
  }

  private async ensureCapacityForNewJob(runMaintenance = true): Promise<void> {
    if (runMaintenance) await this.maintenance();
    const total = await this.db.jobs.count();
    if (total < MAX_OUTBOX_JOBS) return;
    const removable = await this.db.jobs
      .filter((existing) => existing.status === 'sent' || existing.status === 'dead-letter')
      .sortBy('updatedAt');
    if (removable[0]) {
      await this.db.jobs.delete(removable[0].id);
      return;
    }
    throw new AdmExtensionError({
      code: 'OUTBOX_FAILED',
      message: 'Outbox is full and has no terminal jobs that can be removed safely.',
      retryable: false,
      repairHint: 'Open diagnostics and clear completed or dead-letter jobs.',
      details: { maxJobs: MAX_OUTBOX_JOBS },
    });
  }

  get(id: string): Promise<HandoffJob | undefined> {
    return this.db.jobs.get(id);
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<HandoffJob | undefined> {
    return this.db.jobs.where('idempotencyKey').equals(idempotencyKey).first();
  }

  async update(id: string, patch: Partial<HandoffJob>): Promise<void> {
    await this.db.jobs.update(id, { ...patch, updatedAt: new Date().toISOString() });
  }

  pending(now = new Date()): Promise<HandoffJob[]> {
    const nowIso = now.toISOString();
    const staleSendingBefore = new Date(now.getTime() - 2 * 60_000).toISOString();
    return this.db.jobs
      .filter((job) => {
        if ((job.status === 'pending' || job.status === 'failed') && (!job.nextRetryAt || job.nextRetryAt <= nowIso)) return true;
        return job.status === 'sending' && job.updatedAt <= staleSendingBefore;
      })
      .toArray();
  }

  dead(): Promise<HandoffJob[]> {
    return this.db.jobs.where('status').equals('dead-letter').toArray();
  }

  // Recovery: move a dead-letter job back to pending so the retry worker re-attempts
  // it immediately. Resets the failure counters and clears any stale lease/error.
  async requeueDeadLetter(id: string): Promise<HandoffJob | undefined> {
    const job = await this.db.jobs.get(id);
    if (!job || job.status !== 'dead-letter') return undefined;
    await this.update(id, { status: 'pending', attempts: 0, nextRetryAt: undefined, lastError: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
    return this.db.jobs.get(id);
  }

  async requeueAllDeadLetter(): Promise<number> {
    const jobs = await this.dead();
    for (const job of jobs) await this.requeueDeadLetter(job.id);
    return jobs.length;
  }


  async claimDue(owner: string, limit = 25, now = new Date()): Promise<HandoffJob[]> {
    const due = await this.pending(now).then((jobs) => jobs.slice(0, limit));
    const leaseExpiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    const claimed: HandoffJob[] = [];
    await this.db.transaction('rw', this.db.jobs, async () => {
      for (const job of due) {
        const current = await this.db.jobs.get(job.id);
        if (!current) continue;
        const leaseStillActive = current.leaseExpiresAt && current.leaseExpiresAt > now.toISOString() && current.leaseOwner && current.leaseOwner !== owner;
        if (leaseStillActive) continue;
        await this.db.jobs.update(current.id, { leaseOwner: owner, leaseExpiresAt, updatedAt: new Date().toISOString() });
        const refreshed = await this.db.jobs.get(current.id);
        if (refreshed) claimed.push(refreshed);
      }
    });
    return claimed;
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    const job = await this.db.jobs.get(id);
    if (!job || job.leaseOwner !== owner) return;
    await this.update(id, { leaseOwner: undefined, leaseExpiresAt: undefined });
  }

  async counts(): Promise<{ pending: number; failed: number; sending: number; sent: number; deadLetter: number }> {
    await this.maintenance();
    const [pending, failed, sending, sent, deadLetter] = await Promise.all([
      this.db.jobs.where('status').equals('pending').count(),
      this.db.jobs.where('status').equals('failed').count(),
      this.db.jobs.where('status').equals('sending').count(),
      this.db.jobs.where('status').equals('sent').count(),
      this.db.jobs.where('status').equals('dead-letter').count(),
    ]);
    return { pending, failed, sending, sent, deadLetter };
  }


  async maintenance(now = new Date()): Promise<void> {
    const sentBefore = new Date(now.getTime() - OUTBOX_SENT_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    const deadBefore = new Date(now.getTime() - OUTBOX_DEAD_LETTER_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    await this.db.jobs.filter((job) => {
      if (job.status === 'sent') return job.updatedAt < sentBefore;
      if (job.status === 'dead-letter') return job.updatedAt < deadBefore;
      return false;
    }).delete();

    const total = await this.db.jobs.count();
    if (total <= MAX_OUTBOX_JOBS) return;
    const overflow = total - MAX_OUTBOX_JOBS;
    const removable = await this.db.jobs
      .filter((job) => job.status === 'sent' || job.status === 'dead-letter')
      .sortBy('updatedAt');
    const ids = removable.slice(0, overflow).map((job) => job.id);
    if (ids.length > 0) await this.db.jobs.bulkDelete(ids);
  }

  async clearTerminal(): Promise<void> {
    await this.db.jobs.where('status').anyOf('sent', 'dead-letter').delete();
  }

  async clearAll(): Promise<void> {
    await this.db.jobs.clear();
  }
}

