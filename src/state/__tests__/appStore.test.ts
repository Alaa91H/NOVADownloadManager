import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateBrowserPairingToken,
  ensureBrowserPairingToken,
  mergeStoredSettings,
  containingFolder,
  toMinutes,
  isQueueScheduledForDay,
  isQueueInScheduleWindow,
} from '../appStore';
import { initialSettings } from '../../initialData';
import type { Queue } from '../../types/desktop-ui.types';

function createQueue(overrides: Partial<Queue> = {}): Queue {
  return {
    id: 'test-q',
    name: 'Test Queue',
    active: true,
    scheduled: true,
    scheduleType: 'daily',
    maxActive: 1,
    scheduleCompleted: false,
    startTime: '00:00',
    endTime: '23:59',
    days: [0, 1, 2, 3, 4, 5, 6],
    limitSpeed: false,
    speedLimitKbs: 0,
    oneTimeLimit: false,
    shutdownOnComplete: false,
    hangupOnComplete: false,
    retryCount: 3,
    downloadOrder: [],
    ...overrides,
  };
}

describe('generateBrowserPairingToken', () => {
  beforeEach(() => {
    crypto.getRandomValues = vi.fn((arr: ArrayBufferView | null) => {
      if (arr instanceof Uint8Array) {
        for (let i = 0; i < arr.length; i++) arr[i] = i + 1;
      }
      return arr as ArrayBufferView;
    }) as unknown as typeof crypto.getRandomValues;
  });

  it('generates a token starting with nova_token_', () => {
    const token = generateBrowserPairingToken();
    expect(token).toMatch(/^nova_token_[a-f0-9]+$/);
  });

  it('generates a 24-byte hex string (48 hex chars + prefix)', () => {
    const token = generateBrowserPairingToken();
    const hexPart = token.slice('nova_token_'.length);
    expect(hexPart).toHaveLength(48);
  });

  it('produces deterministic output with mocked random', () => {
    const token1 = generateBrowserPairingToken();
    const token2 = generateBrowserPairingToken();
    expect(token1).toBe(token2);
  });
});

describe('ensureBrowserPairingToken', () => {
  it('returns settings unchanged when token already exists', () => {
    const settings = { ...initialSettings, extra: { ...initialSettings.extra, browserPairingToken: 'existing-token' } };
    const result = ensureBrowserPairingToken(settings);
    expect(result.extra.browserPairingToken).toBe('existing-token');
  });

  it('adds a token when missing', () => {
    const settings = { ...initialSettings, extra: { ...initialSettings.extra, browserPairingToken: '' } };
    const result = ensureBrowserPairingToken(settings);
    expect(result.extra.browserPairingToken).toMatch(/^nova_token_/);
  });

  it('does not mutate the original settings object', () => {
    const settings = { ...initialSettings, extra: { ...initialSettings.extra, browserPairingToken: '' } };
    const result = ensureBrowserPairingToken(settings);
    expect(settings.extra.browserPairingToken).toBe('');
    expect(result.extra.browserPairingToken).toMatch(/^nova_token_/);
  });
});

describe('mergeStoredSettings', () => {
  it('merges partial settings with initialSettings', () => {
    const result = mergeStoredSettings({});
    expect(result.general.runOnStartup).toBe(initialSettings.general.runOnStartup);
  });

  it('overrides top-level fields', () => {
    const result = mergeStoredSettings({ general: { ...initialSettings.general, runOnStartup: true } });
    expect(result.general.runOnStartup).toBe(true);
  });

  it('deep merges integrateWithBrowsers', () => {
    const result = mergeStoredSettings({ general: { ...initialSettings.general, integrateWithBrowsers: { chrome: true, edge: false, firefox: false, safari: false } } });
    expect(result.general.integrateWithBrowsers.chrome).toBe(true);
    expect(result.general.integrateWithBrowsers.firefox).toBe(false);
  });

  it('deep merges speedLimiter', () => {
    const result = mergeStoredSettings({ connection: { ...initialSettings.connection, speedLimiter: { enabled: true, maxSpeedKbs: 500 } } });
    expect(result.connection.speedLimiter.enabled).toBe(true);
    expect(result.connection.speedLimiter.maxSpeedKbs).toBe(500);
  });

  it('ignores saveAndCategories with non-NOVA defaultFolder', () => {
    const result = mergeStoredSettings({ saveAndCategories: { ...initialSettings.saveAndCategories, defaultFolder: '/tmp/custom' } });
    expect(result.saveAndCategories.defaultFolder).toBe(initialSettings.saveAndCategories.defaultFolder);
  });

  it('accepts saveAndCategories with NOVA in defaultFolder', () => {
    const result = mergeStoredSettings({ saveAndCategories: { ...initialSettings.saveAndCategories, defaultFolder: '/home/NOVA/downloads' } });
    expect(result.saveAndCategories.defaultFolder).toBe('/home/NOVA/downloads');
  });

  it('ensures browserPairingToken is always present', () => {
    const result = mergeStoredSettings({});
    expect(result.extra.browserPairingToken).toMatch(/^nova_token_/);
  });

  it('merges ui toolbar settings', () => {
    const result = mergeStoredSettings({ ui: { ...initialSettings.ui, toolbar: { ...initialSettings.ui.toolbar, newDownload: { display: 'iconOnly', showDropdown: false } } } });
    expect(result.ui.toolbar.newDownload.display).toBe('iconOnly');
  });
});

describe('containingFolder', () => {
  it('extracts folder from forward-slash path', () => {
    expect(containingFolder('/home/user/downloads/file.zip')).toBe('/home/user/downloads');
  });

  it('extracts folder from backslash path', () => {
    expect(containingFolder('C:\\Users\\user\\Downloads\\file.zip')).toBe('C:\\Users\\user\\Downloads');
  });

  it('returns trimmed path when no slash found', () => {
    expect(containingFolder('file.zip')).toBe('file.zip');
  });

  it('handles trailing slashes by stripping last segment', () => {
    expect(containingFolder('/home/user/downloads/')).toBe('/home/user');
  });

  it('handles root path', () => {
    expect(containingFolder('/file.zip')).toBe('/file.zip');
  });
});

describe('toMinutes', () => {
  it('converts "00:00" to 0', () => {
    expect(toMinutes('00:00')).toBe(0);
  });

  it('converts "01:30" to 90', () => {
    expect(toMinutes('01:30')).toBe(90);
  });

  it('converts "23:59" to 1439', () => {
    expect(toMinutes('23:59')).toBe(1439);
  });

  it('returns null for invalid format', () => {
    expect(toMinutes('abc')).toBeNull();
  });

  it('returns null for hours > 23', () => {
    expect(toMinutes('24:00')).toBeNull();
  });

  it('returns null for minutes > 59', () => {
    expect(toMinutes('12:60')).toBeNull();
  });
});

describe('isQueueScheduledForDay', () => {
  it('returns true for daily schedule regardless of day', () => {
    const queue = createQueue({ scheduleType: 'daily' });
    expect(isQueueScheduledForDay(queue, 0)).toBe(true);
    expect(isQueueScheduledForDay(queue, 3)).toBe(true);
    expect(isQueueScheduledForDay(queue, 6)).toBe(true);
  });

  it('returns true when day is in days array', () => {
    const queue = createQueue({ scheduleType: 'custom', days: [1, 3, 5] });
    expect(isQueueScheduledForDay(queue, 1)).toBe(true);
    expect(isQueueScheduledForDay(queue, 3)).toBe(true);
    expect(isQueueScheduledForDay(queue, 5)).toBe(true);
  });

  it('returns false when day is not in days array', () => {
    const queue = createQueue({ scheduleType: 'custom', days: [1, 3, 5] });
    expect(isQueueScheduledForDay(queue, 0)).toBe(false);
    expect(isQueueScheduledForDay(queue, 2)).toBe(false);
  });
});

describe('isQueueInScheduleWindow', () => {
  it('returns true when start equals end and queue is scheduled for today', () => {
    const queue = createQueue({ scheduleType: 'daily', startTime: '00:00', endTime: '00:00' });
    const now = new Date('2024-01-01T12:00:00');
    expect(isQueueInScheduleWindow(queue, now)).toBe(true);
  });

  it('returns true when now is within window (same day)', () => {
    const queue = createQueue({ scheduleType: 'daily', startTime: '08:00', endTime: '18:00' });
    const now = new Date('2024-01-01T12:00:00');
    expect(isQueueInScheduleWindow(queue, now)).toBe(true);
  });

  it('returns false when now is outside window (same day)', () => {
    const queue = createQueue({ scheduleType: 'daily', startTime: '08:00', endTime: '18:00' });
    const now = new Date('2024-01-01T06:00:00');
    expect(isQueueInScheduleWindow(queue, now)).toBe(false);
  });

  it('handles overnight windows (start > end)', () => {
    const queue = createQueue({ scheduleType: 'daily', startTime: '22:00', endTime: '06:00' });
    const lateNow = new Date('2024-01-01T23:00:00');
    expect(isQueueInScheduleWindow(queue, lateNow)).toBe(true);
    const earlyNow = new Date('2024-01-01T03:00:00');
    expect(isQueueInScheduleWindow(queue, earlyNow)).toBe(true);
    const midNow = new Date('2024-01-01T12:00:00');
    expect(isQueueInScheduleWindow(queue, midNow)).toBe(false);
  });
});
