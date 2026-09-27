import { describe, expect, it } from 'vitest';
import { HealthMonitor } from '../../bridge/health-monitor';
import { EVENT_STREAM_STALE_MS } from '../../contracts/limits';

describe('HealthMonitor', () => {
  it('is not stale before any heartbeat is observed', () => {
    const monitor = new HealthMonitor();
    expect(monitor.ageMs()).toBeUndefined();
    expect(monitor.isStale()).toBe(false);
  });

  it('records a heartbeat and reports a fresh age', () => {
    const monitor = new HealthMonitor();
    const t0 = 1_000_000;
    monitor.mark(t0);
    expect(monitor.lastHeartbeat).toBe(new Date(t0).toISOString());
    expect(monitor.ageMs(t0 + 1_000)).toBe(1_000);
    expect(monitor.isStale(t0 + 1_000)).toBe(false);
  });

  it('becomes stale only after the configured threshold elapses', () => {
    const monitor = new HealthMonitor();
    const t0 = 1_000_000;
    monitor.mark(t0);
    expect(monitor.isStale(t0 + EVENT_STREAM_STALE_MS)).toBe(false);
    expect(monitor.isStale(t0 + EVENT_STREAM_STALE_MS + 1)).toBe(true);
  });

  it('honors a custom staleness threshold', () => {
    const monitor = new HealthMonitor(1_000);
    monitor.mark(0);
    expect(monitor.isStale(1_000)).toBe(false);
    expect(monitor.isStale(1_001)).toBe(true);
  });

  it('reset clears the heartbeat and returns to the not-connected baseline', () => {
    const monitor = new HealthMonitor(1_000);
    monitor.mark(0);
    monitor.reset();
    expect(monitor.lastHeartbeat).toBeUndefined();
    expect(monitor.ageMs(10_000)).toBeUndefined();
    expect(monitor.isStale(10_000)).toBe(false);
  });
});
