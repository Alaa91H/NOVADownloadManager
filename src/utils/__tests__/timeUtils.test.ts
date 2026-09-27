import { describe, it, expect } from 'vitest';
import { parseTimeTo12Hour, formatTimeTo24Hour } from '../timeUtils';

describe('parseTimeTo12Hour', () => {
  it('parses morning time', () => {
    expect(parseTimeTo12Hour('09:30')).toEqual({ hour12: 9, minute: 30, ampm: 'AM' });
  });

  it('parses afternoon time', () => {
    expect(parseTimeTo12Hour('14:05')).toEqual({ hour12: 2, minute: 5, ampm: 'PM' });
  });

  it('maps midnight to 12 AM', () => {
    expect(parseTimeTo12Hour('00:00')).toEqual({ hour12: 12, minute: 0, ampm: 'AM' });
  });

  it('maps noon to 12 PM', () => {
    expect(parseTimeTo12Hour('12:00')).toEqual({ hour12: 12, minute: 0, ampm: 'PM' });
  });

  it('handles minute overflow values', () => {
    expect(parseTimeTo12Hour('09:99')).toEqual({ hour12: 9, minute: 99, ampm: 'AM' });
  });

  it('returns safe defaults for empty input', () => {
    expect(parseTimeTo12Hour('')).toEqual({ hour12: 12, minute: 0, ampm: 'AM' });
  });

  it('treats malformed segments as zero', () => {
    expect(parseTimeTo12Hour('abc')).toEqual({ hour12: 12, minute: 0, ampm: 'AM' });
    expect(parseTimeTo12Hour('09')).toEqual({ hour12: 9, minute: 0, ampm: 'AM' });
  });
});

describe('formatTimeTo24Hour', () => {
  it('formats morning with padding', () => {
    expect(formatTimeTo24Hour(9, 30, 'AM')).toBe('09:30');
  });

  it('converts PM hours', () => {
    expect(formatTimeTo24Hour(2, 5, 'PM')).toBe('14:05');
  });

  it('converts 12 AM to 00', () => {
    expect(formatTimeTo24Hour(12, 0, 'AM')).toBe('00:00');
  });

  it('keeps 12 PM as 12', () => {
    expect(formatTimeTo24Hour(12, 45, 'PM')).toBe('12:45');
  });

  it('pads single digit minutes', () => {
    expect(formatTimeTo24Hour(8, 1, 'AM')).toBe('08:01');
  });

  it('round-trips a full day', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const { hour12, minute, ampm } = parseTimeTo12Hour(
          `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        );
        expect(formatTimeTo24Hour(hour12, minute, ampm)).toBe(
          `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
        );
      }
    }
  });
});
