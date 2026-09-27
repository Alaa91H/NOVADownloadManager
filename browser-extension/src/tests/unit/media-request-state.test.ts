import { describe, expect, it } from 'vitest';
import {
  beginMediaRequest,
  createMediaRequestState,
  finishMediaRequest,
  invalidateMediaRequest,
  isCurrentMediaRequest,
} from '../../content/media-request-state';

describe('media request state', () => {
  it('accepts only the newest active request', () => {
    const state = createMediaRequestState();
    const first = beginMediaRequest(state);
    const second = beginMediaRequest(state);

    expect(isCurrentMediaRequest(state, first)).toBe(false);
    expect(isCurrentMediaRequest(state, second)).toBe(true);
  });

  it('invalidates an in-flight request without reusing its identity', () => {
    const state = createMediaRequestState();
    const requestId = beginMediaRequest(state);

    invalidateMediaRequest(state);

    expect(isCurrentMediaRequest(state, requestId)).toBe(false);
    const nextRequestId = beginMediaRequest(state);
    expect(nextRequestId).toBeGreaterThan(requestId);
    expect(isCurrentMediaRequest(state, nextRequestId)).toBe(true);
  });

  it('finishes only the request that still owns the active slot', () => {
    const state = createMediaRequestState();
    const first = beginMediaRequest(state);
    const second = beginMediaRequest(state);

    finishMediaRequest(state, first);
    expect(isCurrentMediaRequest(state, second)).toBe(true);

    finishMediaRequest(state, second);
    expect(isCurrentMediaRequest(state, second)).toBe(false);
  });
});
