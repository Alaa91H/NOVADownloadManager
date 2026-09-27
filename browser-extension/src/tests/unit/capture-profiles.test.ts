import { describe, expect, it } from 'vitest';
import { applyProfile, degradedReason, CAPTURE_PROFILES } from '../../profiles/capture-profiles';
import type { Settings } from '../../contracts/settings.schema';
import { defaultSettings } from '../../contracts/settings.schema';

describe('capture profiles', () => {
  it('store-safe disables network, downloads, and takeover', () => {
    const s = applyProfile(defaultSettings, 'store-safe');
    expect(s.capture.network).toBe(false);
    expect(s.capture.downloads).toBe(false);
    expect(s.capture.aggressiveMode).toBe(false);
    expect(s.capture.takeoverEnabled).toBe(false);
  });

  it('aggressive enables all capture features and absolute takeover', () => {
    const s = applyProfile(defaultSettings, 'aggressive');
    expect(s.capture.aggressiveMode).toBe(true);
    expect(s.capture.network).toBe(true);
    expect(s.capture.downloads).toBe(true);
    expect(s.capture.minFileSizeMB).toBe(0);
    expect(s.capture.showLowConfidence).toBe(true);
    expect(s.capture.takeoverEnabled).toBe(true);
    expect(s.capture.askBeforeTakeover).toBe(false);
    expect(s.capture.takeoverMinSizeMB).toBe(0);
  });

  it('power-user enables takeover without asking', () => {
    const s = applyProfile(defaultSettings, 'power-user');
    expect(s.capture.takeoverEnabled).toBe(true);
    expect(s.capture.askBeforeTakeover).toBe(false);
  });

  it('enterprise preserves existing settings', () => {
    const custom: Settings = { ...defaultSettings, enabled: false };
    const s = applyProfile(custom, 'enterprise');
    expect(s.enabled).toBe(false);
    expect(s.captureProfile).toBe('enterprise');
  });

  it('all five profiles are defined', () => {
    const ids = Object.keys(CAPTURE_PROFILES);
    expect(ids).toContain('store-safe');
    expect(ids).toContain('smart');
    expect(ids).toContain('aggressive');
    expect(ids).toContain('power-user');
    expect(ids).toContain('enterprise');
  });

  it('returns a degraded reason for network-headers in store-safe', () => {
    const reason = degradedReason('network-headers', 'store-safe');
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/Store Safe/i);
  });

  it('returns undefined for a feature available in the profile', () => {
    expect(degradedReason('network-headers', 'aggressive')).toBeUndefined();
  });
});
