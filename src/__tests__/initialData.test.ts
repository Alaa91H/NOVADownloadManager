import { describe, it, expect } from 'vitest';
import { formatBytes, formatSpeed, formatTimeLeft, initialSettings, fileTypeMetadata, statusMetadata } from '../initialData';

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('returns "Unknown" for non-finite values', () => {
    expect(formatBytes(NaN)).toBe('Unknown');
    expect(formatBytes(Infinity)).toBe('Unknown');
  });

  it('handles fractional values', () => {
    const result = formatBytes(1500);
    expect(result).toContain('KB');
  });
});

describe('formatSpeed', () => {
  it('returns "0 B/s" for zero', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
  });

  it('formats speed correctly', () => {
    expect(formatSpeed(1024)).toBe('1 KB/s');
    expect(formatSpeed(1048576)).toBe('1 MB/s');
  });
});

describe('formatTimeLeft', () => {
  it('returns "Unknown" for zero or negative', () => {
    expect(formatTimeLeft(0)).toBe('Unknown');
    expect(formatTimeLeft(-1)).toBe('Unknown');
  });

  it('formats seconds only', () => {
    expect(formatTimeLeft(30)).toBe('30s');
  });

  it('formats minutes and seconds', () => {
    expect(formatTimeLeft(90)).toBe('1m 30s');
  });

  it('formats hours and minutes', () => {
    expect(formatTimeLeft(3661)).toBe('1h 1m');
  });
});

describe('initialSettings', () => {
  it('has default settings structure', () => {
    expect(initialSettings.general.integrateWithBrowsers).toBeDefined();
    expect(initialSettings.connection.speedLimiter).toBeDefined();
    expect(initialSettings.fileTypes.extensions.video).toContain('mp4');
  });

  it('has all required sections', () => {
    expect(initialSettings).toHaveProperty('general');
    expect(initialSettings).toHaveProperty('fileTypes');
    expect(initialSettings).toHaveProperty('connection');
    expect(initialSettings).toHaveProperty('saveAndCategories');
    expect(initialSettings).toHaveProperty('sounds');
    expect(initialSettings).toHaveProperty('ui');
    expect(initialSettings).toHaveProperty('keyboardShortcuts');
    expect(initialSettings).toHaveProperty('advanced');
    expect(initialSettings).toHaveProperty('extra');
  });

  it('defaults to English language', () => {
    expect(initialSettings.extra.language).toBe('en');
  });

  it('sounds are disabled by default', () => {
    expect(initialSettings.sounds.enabled).toBe(false);
  });
});

describe('fileTypeMetadata', () => {
  it('has entries for all file types', () => {
    const types = ['document', 'program', 'compressed', 'video', 'audio', 'other'];
    for (const type of types) {
      expect(fileTypeMetadata[type]).toBeDefined();
      expect(fileTypeMetadata[type].label).toBeDefined();
      expect(fileTypeMetadata[type].color).toBeDefined();
    }
  });

  it('has non-empty labels', () => {
    for (const entry of Object.values(fileTypeMetadata)) {
      expect(entry.label).toBeTruthy();
    }
  });
});

describe('statusMetadata', () => {
  it('has entries for all download statuses', () => {
    const statuses = ['downloading', 'completed', 'paused', 'queued', 'error'];
    for (const status of statuses) {
      expect(statusMetadata[status]).toBeDefined();
      expect(statusMetadata[status].label).toBeDefined();
      expect(statusMetadata[status].color).toBeDefined();
    }
  });

  it('has non-empty labels', () => {
    for (const entry of Object.values(statusMetadata)) {
      expect(entry.label).toBeTruthy();
    }
  });
});
