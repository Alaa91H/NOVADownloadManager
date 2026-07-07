import { describe, it, expect } from 'vitest';
import { parseTimeTo12Hour, formatTimeTo24Hour } from '../timeUtils';

describe('parseTimeTo12Hour', () => {
  it('parses midnight as 12 AM', () => {
    expect(parseTimeTo12Hour('00:00')).toEqual({ hour12: 12, minute: 0, ampm: 'AM' });
  });

  it('parses noon as 12 PM', () => {
    expect(parseTimeTo12Hour('12:00')).toEqual({ hour12: 12, minute: 0, ampm: 'PM' });
  });

  it('parses morning time', () => {
    expect(parseTimeTo12Hour('08:30')).toEqual({ hour12: 8, minute: 30, ampm: 'AM' });
  });

  it('parses afternoon time', () => {
    expect(parseTimeTo12Hour('13:45')).toEqual({ hour12: 1, minute: 45, ampm: 'PM' });
  });

  it('parses evening time', () => {
    expect(parseTimeTo12Hour('23:59')).toEqual({ hour12: 11, minute: 59, ampm: 'PM' });
  });

  it('defaults to 12 AM for empty input', () => {
    expect(parseTimeTo12Hour('')).toEqual({ hour12: 12, minute: 0, ampm: 'AM' });
  });

  it('defaults minute to 0 when only hour given', () => {
    expect(parseTimeTo12Hour('05')).toEqual({ hour12: 5, minute: 0, ampm: 'AM' });
  });
});

describe('formatTimeTo24Hour', () => {
  it('formats midnight correctly', () => {
    expect(formatTimeTo24Hour(12, 0, 'AM')).toBe('00:00');
  });

  it('formats noon correctly', () => {
    expect(formatTimeTo24Hour(12, 0, 'PM')).toBe('12:00');
  });

  it('formats morning time', () => {
    expect(formatTimeTo24Hour(8, 30, 'AM')).toBe('08:30');
  });

  it('formats afternoon time', () => {
    expect(formatTimeTo24Hour(1, 45, 'PM')).toBe('13:45');
  });

  it('formats evening time', () => {
    expect(formatTimeTo24Hour(11, 59, 'PM')).toBe('23:59');
  });

  it('pads single-digit hours and minutes', () => {
    expect(formatTimeTo24Hour(5, 5, 'AM')).toBe('05:05');
  });

  it('round-trips with parseTimeTo12Hour', () => {
    const inputs = ['00:00', '08:30', '12:00', '13:45', '23:59'];
    for (const timeStr of inputs) {
      const parsed = parseTimeTo12Hour(timeStr);
      const result = formatTimeTo24Hour(parsed.hour12, parsed.minute, parsed.ampm);
      expect(result).toBe(timeStr);
    }
  });
});
