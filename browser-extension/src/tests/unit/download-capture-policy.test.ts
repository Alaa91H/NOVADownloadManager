import { describe, expect, it } from 'vitest';
import { isContentDownloadCaptureEnabled } from '../../capture/download-capture-policy';

describe('content-script download capture policy', () => {
  it('keeps capture enabled for absent legacy settings', () => {
    expect(isContentDownloadCaptureEnabled(undefined)).toBe(true);
    expect(isContentDownloadCaptureEnabled({ enabled: true })).toBe(true);
  });

  it('does not intercept when the extension is disabled', () => {
    expect(isContentDownloadCaptureEnabled({
      enabled: false,
      capture: { downloads: true, takeoverEnabled: true, aggressiveMode: true },
    })).toBe(false);
  });

  it('does not intercept when download capture is disabled without aggressive mode', () => {
    expect(isContentDownloadCaptureEnabled({
      enabled: true,
      capture: { downloads: false, takeoverEnabled: true, aggressiveMode: false },
    })).toBe(false);
  });

  it('does not intercept when takeover is disabled without aggressive mode', () => {
    expect(isContentDownloadCaptureEnabled({
      enabled: true,
      capture: { downloads: true, takeoverEnabled: false, aggressiveMode: false },
    })).toBe(false);
  });

  it('allows explicit aggressive capture even when standard toggles are disabled', () => {
    expect(isContentDownloadCaptureEnabled({
      enabled: true,
      capture: { downloads: false, takeoverEnabled: false, aggressiveMode: true },
    })).toBe(true);
  });
});
