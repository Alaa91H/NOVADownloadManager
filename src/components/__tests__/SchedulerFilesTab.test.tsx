import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { DownloadItem } from '../../types/desktop-ui.types';

const noop = vi.fn();

vi.mock('../../store/selectors', () => ({
  useDialogActions: () => ({ openDialog: noop, closeDialog: noop }),
  useI18n: () => (k: string) => {
    if (k === 'sched_size_unknown') return 'Unknown';
    if (k === 'sched_files_of_list') return 'Files of list';
    return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  },
}));

import { SchedulerFilesTab } from '../SchedulerFilesTab';

const baseTask: DownloadItem = {
  id: 't1',
  name: 'file.bin',
  url: 'https://example.com/file.bin',
  fileType: 'other',
  status: 'downloading',
  sizeBytes: 0,
  downloadedBytes: 0,
  speedBytesPerSec: 1024,
  timeLeftSeconds: 10,
  elapsedSeconds: 2,
  dateAdded: '2026-01-01T00:00:00Z',
  category: 'other',
  queueId: 'main',
  connections: 2,
  resumable: true,
  savePath: '/tmp/file.bin',
  description: '',
  segments: [],
};

const props = {
  name: 'Main',
  isScheduled: false,
  startTime: '02:00',
  endTime: '08:00',
  searchQuery: '',
  taskToRemoveId: null,
  onSearchChange: noop,
  onRemoveRequest: noop,
  onRemoveConfirm: noop,
  onMoveUp: noop,
  onMoveDown: noop,
  onMoveToEdge: noop,
  onReorder: noop,
};

describe('SchedulerFilesTab — unified live progress', () => {
  it('renders the shared TaskProgressBar per row with the indeterminate sweep while size is unknown', () => {
    const task = { ...baseTask, sizeBytes: 0, status: 'downloading' as const };
    const { rerender } = render(<SchedulerFilesTab {...props} filteredTasks={[task]} />);

    expect(screen.getByText('file.bin')).toBeInTheDocument();
    const sweep = screen.getByTestId('progress-sweep');
    const fill = screen.getByTestId('progress-fill');
    expect(sweep.className).toContain('opacity-100');
    expect(fill).toHaveStyle({ width: '0%' });
    // Indeterminate percent label: no fake percentage.
    expect(screen.queryByText('0%')).not.toBeInTheDocument();

    // Phase 2: the engine discovers the size from headers — the SAME nodes
    // stay mounted and the sweep fades out while the fill glides to the real
    // percentage (identical cross-fade to the table/cards/dialog).
    rerender(<SchedulerFilesTab {...props} filteredTasks={[{ ...task, sizeBytes: 1000, downloadedBytes: 800 }]} />);
    expect(screen.getByTestId('progress-sweep')).toBe(sweep);
    expect(screen.getByTestId('progress-fill')).toBe(fill);
    expect(sweep.className).toContain('opacity-0');
    expect(fill).toHaveStyle({ width: '80%' });
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('shows the live size label and an inactive bar for non-downloading tasks', () => {
    const task = {
      ...baseTask,
      id: 't2',
      name: 'done.zip',
      status: 'completed' as const,
      sizeBytes: 500,
      downloadedBytes: 500,
    };
    render(<SchedulerFilesTab {...props} filteredTasks={[task]} />);

    // 500 bytes → "500 B" via formatBytes; bar is determinate at 100%.
    expect(screen.getByText('500 B')).toBeInTheDocument();
    expect(screen.getByTestId('progress-fill')).toHaveStyle({ width: '100%' });
    expect(screen.getByTestId('progress-sweep').className).toContain('opacity-0');
  });

  it('keeps the drag affordances intact alongside the new bar', () => {
    const task = { ...baseTask, status: 'paused' as const };
    render(<SchedulerFilesTab {...props} filteredTasks={[task]} />);
    // The row is still draggable and the context menu still opens.
    const row = screen.getByText('file.bin').closest('[draggable="true"]');
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row as HTMLElement);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
