import type { BridgeGateway } from '../core/bridge-gateway';
import { Candidate, CandidateSchema } from '../contracts/candidate.schema';
import { errorMessage, isRetryableHandoffError } from '../core/error-classification';
import { OutboxStore } from './outbox-store';

export const MAX_ATTEMPTS = 5;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

function asCandidatePayload(payload: unknown): Candidate[] | undefined {
  const single = CandidateSchema.safeParse(payload);
  if (single.success) return [single.data];
  const many = CandidateSchema.array().safeParse(payload);
  return many.success ? many.data : undefined;
}

export const RETRY_JITTER_MS = 500;

// Exponential backoff (2s, 4s, 8s, …) capped at RETRY_MAX_MS, plus up to
// RETRY_JITTER_MS of jitter to avoid synchronized retry storms. Exported for tests.
export function retryDelayMs(attempts: number): number {
  const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1)) + jitter;
}

export class OutboxRetryWorker {
  private readonly owner = `retry-${crypto.randomUUID()}`;

  constructor(private readonly store: OutboxStore, private readonly bridge: BridgeGateway) {}

  async runOnce(): Promise<void> {
    await this.store.maintenance();
    const jobs = await this.store.claimDue(this.owner);
    for (const job of jobs) {
      const attempts = job.attempts + 1;
      await this.store.update(job.id, { status: 'sending', attempts });
      const candidates = asCandidatePayload(job.payload);
      if (!candidates) {
        await this.store.update(job.id, { status: 'dead-letter', lastError: 'invalid payload', leaseOwner: undefined, leaseExpiresAt: undefined });
        continue;
      }
      try {
        if (candidates.length === 1) {
          const first = candidates[0];
          if (!first) throw new Error('missing candidate');
          await this.bridge.sendCandidateNow(first, job.idempotencyKey);
        } else {
          await this.bridge.sendBatchNow(candidates, job.idempotencyKey);
        }
        await this.store.update(job.id, { status: 'sent', nextRetryAt: undefined, lastError: undefined, leaseOwner: undefined, leaseExpiresAt: undefined });
      } catch (error) {
        const retryable = isRetryableHandoffError(error);
        await this.store.update(job.id, {
          status: !retryable || attempts >= MAX_ATTEMPTS ? 'dead-letter' : 'failed',
          lastError: errorMessage(error),
          nextRetryAt: !retryable || attempts >= MAX_ATTEMPTS ? undefined : new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
        });
      }
    }
  }
}
