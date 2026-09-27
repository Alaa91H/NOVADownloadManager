import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, RETRY_BASE_MS, RETRY_JITTER_MS, RETRY_MAX_MS, retryDelayMs } from '../../outbox/retry-worker';

describe('retryDelayMs', () => {
  it('grows exponentially from the base delay for the first attempts', () => {
    for (let attempts = 1; attempts <= 4; attempts += 1) {
      const floor = RETRY_BASE_MS * 2 ** (attempts - 1);
      const delay = retryDelayMs(attempts);
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThan(floor + RETRY_JITTER_MS);
    }
  });

  it('keeps jitter within the configured window across many samples', () => {
    const floor = RETRY_BASE_MS; // attempts = 1
    const samples = Array.from({ length: 500 }, () => retryDelayMs(1) - floor);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(RETRY_JITTER_MS);
    // Jitter should actually vary, not be a constant.
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('caps the exponential term at RETRY_MAX_MS (plus jitter) for large attempt counts', () => {
    const delay = retryDelayMs(MAX_ATTEMPTS + 10);
    expect(delay).toBeGreaterThanOrEqual(RETRY_MAX_MS);
    expect(delay).toBeLessThan(RETRY_MAX_MS + RETRY_JITTER_MS);
  });
});
