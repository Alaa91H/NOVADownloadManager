import { describe, it, expect } from 'vitest';
import { normalizeScheduleDays, inferScheduleType, normalizeQueue } from '../useQueueStore';

describe('normalizeScheduleDays', () => {
  it('returns all days for non-array input', () => {
    expect(normalizeScheduleDays(null)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeScheduleDays(undefined)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeScheduleDays('abc')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeScheduleDays({})).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('filters out invalid day values', () => {
    expect(normalizeScheduleDays([-1, 0, 7, 1, 2.5, 2])).toEqual([0, 1, 2]);
  });

  it('deduplicates and sorts', () => {
    expect(normalizeScheduleDays([3, 1, 3, 0, 5, 1])).toEqual([0, 1, 3, 5]);
  });

  it('returns all days when filtered array is empty', () => {
    expect(normalizeScheduleDays([-1, 7, 99])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('inferScheduleType', () => {
  it('returns "once" when explicitly set', () => {
    expect(inferScheduleType({ scheduleType: 'once' }, [0, 1, 2, 3, 4, 5, 6])).toBe('once');
  });

  it('returns "daily" when explicitly set', () => {
    expect(inferScheduleType({ scheduleType: 'daily' }, [0, 1])).toBe('daily');
  });

  it('returns "custom" when explicitly set', () => {
    expect(inferScheduleType({ scheduleType: 'custom' }, [0, 1, 2, 3, 4, 5, 6])).toBe('custom');
  });

  it('infers "daily" for all 7 days', () => {
    expect(inferScheduleType({}, [0, 1, 2, 3, 4, 5, 6])).toBe('daily');
  });

  it('infers "once" for single day when scheduled', () => {
    expect(inferScheduleType({ scheduled: true }, [3])).toBe('once');
  });

  it('defaults to "custom" for partial days without scheduled flag', () => {
    expect(inferScheduleType({}, [1, 3, 5])).toBe('custom');
  });
});

describe('normalizeQueue', () => {
  it('fills missing fields from fallback', () => {
    const result = normalizeQueue({ name: 'Test Queue' });
    expect(result.id).toContain('q-');
    expect(result.name).toBe('Test Queue');
    expect(result.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.maxActive).toBe(1);
  });

  it('preserves explicit fields', () => {
    const result = normalizeQueue({ id: 'custom-id', name: 'Custom', maxActive: 5, scheduleCompleted: true });
    expect(result.id).toBe('custom-id');
    expect(result.maxActive).toBe(5);
    expect(result.scheduleCompleted).toBe(true);
  });

  it('ensures maxActive is at least 1', () => {
    expect(normalizeQueue({ maxActive: 0 }).maxActive).toBe(1);
    expect(normalizeQueue({ maxActive: -5 }).maxActive).toBe(1);
  });

  it('falls back to base name when name is empty', () => {
    const result = normalizeQueue({ name: '' });
    expect(result.name).toBe('Main Queue');
  });
});
