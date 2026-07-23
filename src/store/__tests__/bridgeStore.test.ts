import { describe, it, expect, beforeEach } from 'vitest';
import { bridgeStore } from '../bridgeStore';

describe('bridgeStore', () => {
  beforeEach(() => {
    bridgeStore.setState({
      status: 'connecting',
      version: '',
      pid: 0,
      speedLimit: null,
      isDegradedMode: false,
    });
  });

  it('has correct initial state', () => {
    const s = bridgeStore.getState();
    expect(s.status).toBe('connecting');
    expect(s.version).toBe('');
    expect(s.pid).toBe(0);
    expect(s.speedLimit).toBeNull();
    expect(s.isDegradedMode).toBe(false);
  });

  it('setBridge updates status, version, pid, speedLimit', () => {
    bridgeStore.getState().setBridge({ status: 'connected', version: '1.2.3', pid: 12345, speedLimit: 5120 });
    const s = bridgeStore.getState();
    expect(s.status).toBe('connected');
    expect(s.version).toBe('1.2.3');
    expect(s.pid).toBe(12345);
    expect(s.speedLimit).toBe(5120);
  });

  it('setIsDegradedMode toggles degraded flag', () => {
    bridgeStore.getState().setIsDegradedMode(true);
    expect(bridgeStore.getState().isDegradedMode).toBe(true);
    bridgeStore.getState().setIsDegradedMode(false);
    expect(bridgeStore.getState().isDegradedMode).toBe(false);
  });

  it('setBridge syncs isDegradedMode atomically with status', () => {
    bridgeStore.getState().setBridge({ status: 'degraded', version: '1.0', pid: 1, speedLimit: null });
    expect(bridgeStore.getState().isDegradedMode).toBe(true);
    bridgeStore.getState().setBridge({ status: 'disconnected', version: '2.0', pid: 99, speedLimit: null });
    // status changed to disconnected, so isDegradedMode must be false now
    expect(bridgeStore.getState().isDegradedMode).toBe(false);
  });
});
