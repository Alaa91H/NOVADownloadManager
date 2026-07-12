import { Candidate } from '../contracts/candidate.schema';

export interface BridgeGateway {
  sendCandidateNow(candidate: Candidate, idempotencyKey: string): Promise<unknown>;
  sendBatchNow(candidates: Candidate[], idempotencyKey: string): Promise<unknown>;
}
