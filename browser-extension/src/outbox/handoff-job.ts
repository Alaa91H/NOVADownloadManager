import { z } from 'zod';
export const HandoffJobSchema = z.object({ id:z.string(), idempotencyKey:z.string(), candidateIds:z.array(z.string()), payload:z.unknown(), status:z.enum(['pending','sending','sent','failed','dead-letter']), attempts:z.number().int().nonnegative(), lastError:z.string().optional(), createdAt:z.string(), updatedAt:z.string(), nextRetryAt:z.string().optional(), leaseOwner:z.string().optional(), leaseExpiresAt:z.string().optional() });
export type HandoffJob = z.infer<typeof HandoffJobSchema>;
