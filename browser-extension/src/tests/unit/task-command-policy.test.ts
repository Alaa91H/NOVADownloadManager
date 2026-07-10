import { describe, expect, it } from 'vitest';
import { assertTaskIdSafe } from '../../security/task-command-policy';
import { NovaExtensionError } from '../../core/error-classification';
import { MAX_TASK_ID_CHARS } from '../../contracts/limits';

describe('assertTaskIdSafe', () => {
  it('returns the trimmed id for a safe value', () => {
    expect(assertTaskIdSafe('  task-abc_123  ')).toBe('task-abc_123');
  });

  it('rejects an empty or whitespace-only id', () => {
    expect(() => assertTaskIdSafe('')).toThrow(NovaExtensionError);
    expect(() => assertTaskIdSafe('   ')).toThrow(NovaExtensionError);
  });

  it('rejects an id longer than the limit', () => {
    expect(() => assertTaskIdSafe('a'.repeat(MAX_TASK_ID_CHARS + 1))).toThrow(NovaExtensionError);
  });

  it('accepts an id exactly at the limit', () => {
    const id = 'a'.repeat(MAX_TASK_ID_CHARS);
    expect(assertTaskIdSafe(id)).toBe(id);
  });

  it('rejects ids containing control characters', () => {
    for (const bad of ['task\n1', 'task\t1', 'task\x00end', 'task\x7f']) {
      expect(() => assertTaskIdSafe(bad)).toThrow(NovaExtensionError);
    }
  });

  it('tags rejections as VALIDATION_FAILED', () => {
    try {
      assertTaskIdSafe('');
    } catch (error) {
      expect((error as NovaExtensionError).code).toBe('VALIDATION_FAILED');
    }
  });
});
