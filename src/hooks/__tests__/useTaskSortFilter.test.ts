import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTaskSortFilter } from '../useTaskSortFilter';

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-' + Math.random().toString(36).slice(2),
    name: 'Test Download',
    url: 'https://example.com/file.zip',
    status: 'queued',
    fileType: 'other',
    sizeBytes: 0,
    downloadedBytes: 0,
    speedBytesPerSec: 0,
    timeLeftSeconds: 0,
    dateAdded: new Date().toISOString(),
    queueId: 'main',
    ...overrides,
  } as any;
}

describe('useTaskSortFilter', () => {
  describe('filtering', () => {
    it('returns all tasks for "all" view', () => {
      const tasks = [createTask({ name: 'A' }), createTask({ name: 'B' }), createTask({ name: 'C' })];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'all'));
      expect(result.current.filteredTasks).toHaveLength(3);
    });

    it('shows only unfinished tasks', () => {
      const tasks = [
        createTask({ name: 'Active', status: 'downloading' }),
        createTask({ name: 'Done', status: 'completed' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'unfinished'));
      expect(result.current.filteredTasks).toHaveLength(1);
      expect(result.current.filteredTasks[0].name).toBe('Active');
    });

    it('shows only finished tasks', () => {
      const tasks = [
        createTask({ name: 'Active', status: 'downloading' }),
        createTask({ name: 'Done', status: 'completed' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'finished'));
      expect(result.current.filteredTasks).toHaveLength(1);
      expect(result.current.filteredTasks[0].name).toBe('Done');
    });

    it('shows only queued tasks', () => {
      const tasks = [
        createTask({ name: 'Active', status: 'downloading' }),
        createTask({ name: 'Queued', status: 'queued' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'queued'));
      expect(result.current.filteredTasks).toHaveLength(1);
      expect(result.current.filteredTasks[0].name).toBe('Queued');
    });

    it('filters by search query (name match)', () => {
      const tasks = [
        createTask({ name: 'Ubuntu ISO', url: 'https://example.com/ubuntu.iso' }),
        createTask({ name: 'Fedora ISO', url: 'https://example.com/fedora.iso' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, 'ubuntu', 'all'));
      expect(result.current.filteredTasks).toHaveLength(1);
      expect(result.current.filteredTasks[0].name).toBe('Ubuntu ISO');
    });

    it('filters by search query (URL match)', () => {
      const tasks = [
        createTask({ name: 'File 1', url: 'https://example.com/video.mp4' }),
        createTask({ name: 'File 2', url: 'https://other.com/file.zip' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, 'video', 'all'));
      expect(result.current.filteredTasks).toHaveLength(1);
    });

    it('returns empty when no tasks match search', () => {
      const tasks = [createTask({ name: 'Foo', url: 'https://example.com/foo' })];
      const { result } = renderHook(() => useTaskSortFilter(tasks, 'nonexistent', 'all'));
      expect(result.current.filteredTasks).toHaveLength(0);
    });

    it('returns empty when no tasks exist', () => {
      const { result } = renderHook(() => useTaskSortFilter([], '', 'all'));
      expect(result.current.filteredTasks).toHaveLength(0);
    });
  });

  describe('sorting', () => {
    it('defaults to descending dateAdded', () => {
      const tasks = [
        createTask({ name: 'Older', dateAdded: '2024-01-01T00:00:00.000Z' }),
        createTask({ name: 'Newer', dateAdded: '2024-06-01T00:00:00.000Z' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'all'));
      expect(result.current.sortedTasks[0].name).toBe('Newer');
      expect(result.current.sortedTasks[1].name).toBe('Older');
    });

    it('toggles sort order on handleSort', () => {
      const tasks = [
        createTask({ name: 'A', dateAdded: '2024-01-01T00:00:00.000Z' }),
        createTask({ name: 'B', dateAdded: '2024-06-01T00:00:00.000Z' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'all'));
      act(() => result.current.handleSort('dateAdded'));
      expect(result.current.sortOrder).toBe('asc');
      expect(result.current.sortedTasks[0].name).toBe('A');
    });

    it('sorts by name alphabetically', () => {
      const tasks = [createTask({ name: 'Zebra' }), createTask({ name: 'Apple' })];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'all'));
      act(() => result.current.handleSort('name'));
      expect(result.current.sortedTasks[0].name).toBe('Zebra');
      act(() => result.current.handleSort('name'));
      expect(result.current.sortedTasks[0].name).toBe('Apple');
    });

    it('sorts by progress', () => {
      const tasks = [
        createTask({ name: 'Half', sizeBytes: 100, downloadedBytes: 50 }),
        createTask({ name: 'Full', sizeBytes: 100, downloadedBytes: 100 }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'all'));
      act(() => result.current.handleSort('progress'));
      expect(result.current.sortedTasks[0].name).toBe('Full');
      expect(result.current.sortedTasks[1].name).toBe('Half');
    });

    it('sorts by priority', () => {
      const tasks = [
        createTask({ name: 'Fast', queueId: 'fast' }),
        createTask({ name: 'Normal', queueId: 'main' }),
        createTask({ name: 'Night', queueId: 'night' }),
      ];
      const { result } = renderHook(() => useTaskSortFilter(tasks, '', 'all'));
      act(() => result.current.handleSort('priority'));
      expect(result.current.sortedTasks[0].name).toBe('Fast');
      expect(result.current.sortedTasks[1].name).toBe('Normal');
      expect(result.current.sortedTasks[2].name).toBe('Night');
    });
  });
});
