/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { mergeDaemonTasks } from '../useTaskStore';

describe('mergeDaemonTasks', () => {
  it('returns an empty array when given an empty array', () => {
    expect(mergeDaemonTasks([])).toEqual([]);
  });

  it('hydrates each task (returns shallow copy)', () => {
    const tasks = [
      { id: '1', name: 'Task 1', url: 'https://example.com/file1.zip' },
      { id: '2', name: 'Task 2', url: 'https://example.com/file2.zip' },
    ];
    const result = mergeDaemonTasks(tasks as any);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(tasks[0]);
    expect(result[1]).toEqual(tasks[1]);
    expect(result[0]).not.toBe(tasks[0]);
  });

  it('preserves all properties on each task', () => {
    const task = {
      id: 'abc-123',
      name: 'My Download',
      url: 'https://example.com/file.zip',
      status: 'downloading',
      sizeBytes: 1048576,
      downloadedBytes: 524288,
      engine: 'curl',
    };
    const [result] = mergeDaemonTasks([task as any]);
    expect(result.id).toBe('abc-123');
    expect(result.name).toBe('My Download');
    expect(result.url).toBe('https://example.com/file.zip');
    expect(result.status).toBe('downloading');
    expect(result.sizeBytes).toBe(1048576);
    expect(result.downloadedBytes).toBe(524288);
  });
});
