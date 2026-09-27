import { EVENT_STREAM_STALE_MS } from '../contracts/limits';

// Tracks liveness of the event stream (SSE/WebSocket). The bridge marks a
// heartbeat on connect and on every heartbeat/connected event; callers use
// isStale() to decide when a silent stream drop should trigger a reconnect.
export class HealthMonitor {
  lastHeartbeat?: string;
  private lastHeartbeatMs?: number;

  constructor(private readonly staleAfterMs: number = EVENT_STREAM_STALE_MS) {}

  mark(now: number = Date.now()): void {
    this.lastHeartbeatMs = now;
    this.lastHeartbeat = new Date(now).toISOString();
  }

  reset(): void {
    this.lastHeartbeatMs = undefined;
    this.lastHeartbeat = undefined;
  }

  ageMs(now: number = Date.now()): number | undefined {
    return this.lastHeartbeatMs === undefined ? undefined : Math.max(0, now - this.lastHeartbeatMs);
  }

  // Stale only once a heartbeat has been observed and the threshold has elapsed.
  // Never marked means "not connected yet", which is handled by bridge state, not here.
  isStale(now: number = Date.now()): boolean {
    const age = this.ageMs(now);
    return age !== undefined && age > this.staleAfterMs;
  }
}
