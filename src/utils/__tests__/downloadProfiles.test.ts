import { describe, expect, it } from 'vitest';
import { normalizeDownloadProfiles, selectActiveDownloadProfile } from '../downloadProfiles';

describe('download profile normalization', () => {
  it('keeps valid daemon profiles, normalizes display whitespace, and sorts by name', () => {
    expect(
      normalizeDownloadProfiles([
        { id: 'background', name: ' Background ', description: '  Minimal\nresource usage  ' },
        { id: 'balanced', name: 'Balanced', description: '' },
      ]),
    ).toEqual([
      { id: 'background', name: 'Background', description: 'Minimal resource usage' },
      { id: 'balanced', name: 'Balanced' },
    ]);
  });

  it('uses a valid id as a display fallback and drops malformed or duplicate entries', () => {
    expect(
      normalizeDownloadProfiles([
        { id: 'safe-profile' },
        { id: 'safe-profile', name: 'Duplicate' },
        { id: '', name: 'Missing id' },
        { id: 42, name: 'Wrong id type' },
        null,
        'not a profile',
      ]),
    ).toEqual([{ id: 'safe-profile', name: 'safe-profile' }]);
  });

  it('truncates excessively long display strings and strips control characters', () => {
    const name = `Trusted\u0000 profile ${'x'.repeat(160)}`;
    const description = `Safe\tdescription ${'x'.repeat(360)}`;
    const [profile] = normalizeDownloadProfiles([{ id: 'trusted', name, description }]);
    expect(profile.name).toHaveLength(120);
    expect(profile.description).toHaveLength(320);
    expect(profile.name).not.toContain('\u0000');
  });

  it('accepts an active id only when it belongs to the selectable list', () => {
    const profiles = normalizeDownloadProfiles([{ id: 'balanced', name: 'Balanced' }]);
    expect(selectActiveDownloadProfile(' balanced ', profiles)).toBe('balanced');
    expect(selectActiveDownloadProfile('unknown', profiles)).toBeUndefined();
    expect(selectActiveDownloadProfile({ id: 'balanced' }, profiles)).toBeUndefined();
  });
});
