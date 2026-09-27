import { describe, expect, it } from 'vitest';
import {
  isTaskActiveStatus,
  isTaskPausableStatus,
  isTaskReceivingBytes,
  isTaskResumableStatus,
} from '../taskStatus';

describe('task lifecycle status helpers', () => {
  it('classifies every engine-owned lifecycle phase as active', () => {
    for (const status of [
      'preparing',
      'probing',
      'downloading',
      'pausing',
      'stopping',
      'retrying',
      'recovering',
      'verifying',
      'finalizing',
    ] as const) {
      expect(isTaskActiveStatus(status)).toBe(true);
    }

    for (const status of ['queued', 'paused', 'completed', 'error', 'interrupted'] as const) {
      expect(isTaskActiveStatus(status)).toBe(false);
    }
  });

  it('allows pause only before the completion commit pipeline', () => {
    for (const status of ['preparing', 'probing', 'downloading', 'retrying', 'recovering'] as const) {
      expect(isTaskPausableStatus(status)).toBe(true);
    }

    for (const status of ['verifying', 'finalizing', 'completed'] as const) {
      expect(isTaskPausableStatus(status)).toBe(false);
    }
  });

  it('allows non-destructive resume only from recoverable idle states', () => {
    for (const status of ['paused', 'queued', 'error', 'interrupted'] as const) {
      expect(isTaskResumableStatus(status)).toBe(true);
    }
    expect(isTaskResumableStatus('completed')).toBe(false);
    expect(isTaskResumableStatus('downloading')).toBe(false);
  });

  it('reports live transfer speed only while bytes are being received', () => {
    expect(isTaskReceivingBytes('downloading')).toBe(true);
    expect(isTaskReceivingBytes('retrying')).toBe(false);
    expect(isTaskReceivingBytes('verifying')).toBe(false);
  });
});
