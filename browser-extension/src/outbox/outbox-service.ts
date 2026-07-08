import { Candidate, CandidateSchema } from '../contracts/candidate.schema';
import { HandoffJob, HandoffJobSchema } from './handoff-job';
import { idempotencyKeyFor } from './idempotency';
import { assertHandoffPayloadBudget } from '../security/payload-budget';
import { OutboxStore } from './outbox-store';

export class OutboxService {
  constructor(private readonly store = new OutboxStore()) {}

  async enqueueCandidate(candidate: Candidate): Promise<HandoffJob> {
    return this.enqueueBatch([candidate]);
  }

  async enqueueBatch(candidates: Candidate[]): Promise<HandoffJob> {
    const parsed = CandidateSchema.array().min(1).parse(candidates);
    assertHandoffPayloadBudget(parsed);
    const now = new Date().toISOString();
    const idempotencyKey = await idempotencyKeyFor(parsed);
    const existing = await this.store.findByIdempotencyKey(idempotencyKey);
    if (existing && existing.status !== 'dead-letter') return existing;
    const job = HandoffJobSchema.parse({
      id: crypto.randomUUID(),
      idempotencyKey,
      candidateIds: parsed.map((candidate) => candidate.id),
      payload: parsed.length === 1 ? parsed[0] : parsed,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return this.store.addIfAbsent(job);
  }
}
