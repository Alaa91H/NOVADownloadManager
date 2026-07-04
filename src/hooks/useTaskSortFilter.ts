import { useMemo, useState } from 'react';
import { DownloadItem, FileType } from '../types/desktop-ui.types';
import { SortColumn } from '../utils/taskTableUtils';

type WorkspaceView = 'all' | 'unfinished' | 'finished' | 'queued' | FileType | 'browser' | 'scheduler' | 'diagnostics';

export function useTaskSortFilter(
  tasks: DownloadItem[],
  searchQuery: string,
  workspaceView: WorkspaceView
) {
  const [sortBy, setSortBy] = useState<SortColumn>('dateAdded');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const filteredTasks = useMemo(() => {
    return tasks.filter(task => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!task.name.toLowerCase().includes(q) && !task.url.toLowerCase().includes(q)) {
          return false;
        }
      }
      if (workspaceView === 'all') return true;
      if (workspaceView === 'unfinished') return task.status !== 'completed';
      if (workspaceView === 'finished') return task.status === 'completed';
      if (workspaceView === 'queued') return task.status === 'queued';
      return task.fileType === workspaceView;
    });
  }, [tasks, searchQuery, workspaceView]);

  const sortedTasks = useMemo(() => {
    return [...filteredTasks].sort((a, b) => {
      const valA: unknown = a[sortBy as keyof DownloadItem];
      const valB: unknown = b[sortBy as keyof DownloadItem];

      if (sortBy === 'progress') {
        const progA = a.sizeBytes > 0 ? (a.downloadedBytes / a.sizeBytes) : 0;
        const progB = b.sizeBytes > 0 ? (b.downloadedBytes / b.sizeBytes) : 0;
        return sortOrder === 'asc' ? progA - progB : progB - progA;
      }
      if (sortBy === 'speed') {
        return sortOrder === 'asc' ? (valA as number || 0) - (valB as number || 0) : (valB as number || 0) - (valA as number || 0);
      }
      if (sortBy === 'timeLeft') {
        return sortOrder === 'asc' ? (valA as number || 0) - (valB as number || 0) : (valB as number || 0) - (valA as number || 0);
      }
      if (sortBy === 'retries') {
        const rA = a.status === 'error' ? 3 : 0;
        const rB = b.status === 'error' ? 3 : 0;
        return sortOrder === 'asc' ? rA - rB : rB - rA;
      }
      if (sortBy === 'crc32') {
        const cA = a.status === 'completed' ? 1 : 0;
        const cB = b.status === 'completed' ? 1 : 0;
        return sortOrder === 'asc' ? cA - cB : cB - cA;
      }
      if (sortBy === 'priority') {
        const pA = a.queueId === 'fast' ? 3 : a.queueId === 'night' ? 1 : 2;
        const pB = b.queueId === 'fast' ? 3 : b.queueId === 'night' ? 1 : 2;
        return sortOrder === 'asc' ? pA - pB : pB - pA;
      }
      if (sortBy === 'completedDate') {
        const dA = a.status === 'completed' ? a.dateAdded : '';
        const dB = b.status === 'completed' ? b.dateAdded : '';
        return sortOrder === 'asc' ? dA.localeCompare(dB) : dB.localeCompare(dA);
      }
      if (sortBy === 'smartCategory') {
        return sortOrder === 'asc'
          ? String(valA || '').localeCompare(String(valB || ''))
          : String(valB || '').localeCompare(String(valA || ''));
      }

      if (typeof valA === 'string' && typeof valB === 'string') {
        return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      } else if (typeof valA === 'number' && typeof valB === 'number') {
        return sortOrder === 'asc' ? valA - valB : valB - valA;
      }
      return 0;
    });
  }, [filteredTasks, sortBy, sortOrder]);

  const handleSort = (column: SortColumn) => {
    if (sortBy === column) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  };

  return {
    sortBy,
    sortOrder,
    filteredTasks,
    sortedTasks,
    handleSort,
  };
}
