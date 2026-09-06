import { describe, expect, it } from 'vitest';
import {
  MAX_PERSISTED_TRACKED_DOWNLOADS,
  deserializeTrackedDownloads,
  serializeTrackedDownloads,
} from '../../background/download-tracking-store';

describe('download tracking persistence', () => {
  it('redacts invalid entries and bounds filenames', () => {
    const restored = deserializeTrackedDownloads({
      '12': { filename: ' video.mp4 ', lastNotice: 'paused' },
      'bad': { filename: 'ignored' },
      '13': { filename: '', lastNotice: 'complete' },
      '14': { filename: 'safe.bin', lastNotice: 'secret' },
    });

    expect([...restored.entries()]).toEqual([
      [12, { filename: 'video.mp4', lastNotice: 'paused' }],
      [14, { filename: 'safe.bin' }],
    ]);
  });

  it('serializes only bounded redacted metadata', () => {
    const downloads = new Map<number, { filename: string; lastNotice?: 'paused' | 'complete' | 'failed' }>();
    for (let id = 0; id < MAX_PERSISTED_TRACKED_DOWNLOADS + 12; id += 1) {
      downloads.set(id, { filename: `file-${id}.bin`, lastNotice: 'paused' });
    }

    const serialized = serializeTrackedDownloads(downloads);
    expect(Object.keys(serialized)).toHaveLength(MAX_PERSISTED_TRACKED_DOWNLOADS);
    expect(serialized['0']).toBeUndefined();
    expect(serialized[String(MAX_PERSISTED_TRACKED_DOWNLOADS + 11)]).toEqual({
      filename: `file-${MAX_PERSISTED_TRACKED_DOWNLOADS + 11}.bin`,
      lastNotice: 'paused',
    });
  });
});
