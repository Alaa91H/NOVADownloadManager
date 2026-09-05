import { describe, expect, it } from 'vitest';
import { classifyDownloadNotice } from '../../background/download-state';

describe('download state classification', () => {
  it('treats a confirmed complete item as complete', () => {
    expect(classifyDownloadNotice({
      itemState: 'complete',
      itemCanResume: false,
      deltaState: 'interrupted',
    })).toBe('complete');
  });

  it('keeps an interrupted download resumable instead of reporting failure', () => {
    expect(classifyDownloadNotice({
      itemState: 'interrupted',
      itemCanResume: true,
      deltaState: 'interrupted',
    })).toBe('paused');
  });

  it('recognizes an explicit paused delta as resumable', () => {
    expect(classifyDownloadNotice({ deltaPaused: true })).toBe('paused');
  });

  it('reports only non-resumable interruptions as failures', () => {
    expect(classifyDownloadNotice({
      itemState: 'interrupted',
      itemCanResume: false,
      itemPaused: false,
      deltaState: 'interrupted',
    })).toBe('failed');
  });

  it('ignores unrelated progress changes', () => {
    expect(classifyDownloadNotice({ itemState: 'in_progress' })).toBeNull();
  });
});
