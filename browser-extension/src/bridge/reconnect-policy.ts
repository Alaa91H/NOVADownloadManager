/**
 * Exponential-ish reconnect backoff for the desktop bridge.
 *
 * The schedule ramps from 2s → 5s and holds at 5s for several attempts, then
 * settles at a longer 15s cadence after sustained failure so a daemon that is
 * genuinely down does not get polled aggressively. Reset to zero on every
 * successful connection.
 */
export class ReconnectPolicy {
  private attempt = 0;

  // First six attempts: 2s, 3s, 5s, 5s, 5s, 5s — fast recovery while the
  // daemon is restarting. After that: 15s — gentle polling for a cold start.
  private readonly schedule = [2000, 3000, 5000, 5000, 5000, 5000];
  private readonly longDelayMs = 15000;

  next(): number {
    const delay = this.schedule[Math.min(this.attempt, this.schedule.length - 1)] ?? this.longDelayMs;
    this.attempt += 1;
    return delay;
  }

  reset(): void {
    this.attempt = 0;
  }
}
