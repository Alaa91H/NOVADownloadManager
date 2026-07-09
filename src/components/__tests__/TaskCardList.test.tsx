import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TaskCardList from '../TaskCardList';
import type { DownloadItem } from '../../types/desktop-ui.types';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        status_downloading: 'Downloading',
        status_completed: 'Completed',
        status_paused: 'Paused',
        status_queued: 'Queued',
        status_error: 'Error',
      };
      return map[k] || k;
    },
  }),
}));

const t = (k: string, _params?: Record<string, string | number>) => {
  const map: Record<string, string> = {
    no_downloads: 'No downloads yet',
    table_size_label: 'Size:',
    table_speed_label: 'Speed:',
    table_left_label: 'Left:',
    topbar_stop: 'Stop',
    resume: 'Resume',
    menu_open_file: 'Open File',
    menu_open_file_location: 'Open Location',
    properties: 'Properties',
    action_delete: 'Delete',
  };
  return map[k] || k;
};

function makeTask(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'task-1',
    name: 'test-file.zip',
    url: 'https://example.com/test-file.zip',
    fileType: 'compressed',
    status: 'downloading',
    sizeBytes: 1024 * 1024,
    downloadedBytes: 512 * 1024,
    speedBytesPerSec: 1024 * 100,
    timeLeftSeconds: 5,
    dateAdded: '2026-07-07',
    category: 'compressed',
    queueId: 'main',
    connections: 4,
    resumable: true,
    savePath: '/downloads/test-file.zip',
    description: '',
    segments: [],
    ...overrides,
  };
}

const defaultProps = {
  tasks: [] as DownloadItem[],
  selectedTaskId: null as string | null,
  checkedTaskIds: new Set<string>(),
  setSelectedTaskId: vi.fn(),
  handleToggleCheckTask: vi.fn(),
  startRowPress: vi.fn(),
  endRowPress: vi.fn(),
  cancelRowPress: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  openTaskFile: vi.fn(async () => {}),
  openTaskLocation: vi.fn(async () => {}),
  openDialog: vi.fn(),
  t,
};

describe('TaskCardList', () => {
  it('renders empty state when no tasks', () => {
    render(<TaskCardList {...defaultProps} />);
    expect(screen.getByText('No downloads yet')).toBeInTheDocument();
  });

  it('renders task rows', () => {
    const tasks = [makeTask()];
    render(<TaskCardList {...defaultProps} tasks={tasks} />);
    expect(screen.getByText('test-file.zip')).toBeInTheDocument();
  });

  it('displays progress percentage', () => {
    const tasks = [makeTask({ downloadedBytes: 256 * 1024, sizeBytes: 1024 * 1024 })];
    render(<TaskCardList {...defaultProps} tasks={tasks} />);
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('shows 0% progress when sizeBytes is 0', () => {
    const tasks = [makeTask({ sizeBytes: 0, downloadedBytes: 0 })];
    render(<TaskCardList {...defaultProps} tasks={tasks} />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows speed and time left for downloading tasks', () => {
    const tasks = [makeTask({ status: 'downloading' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} />);
    expect(screen.getByText(/Speed:/)).toBeInTheDocument();
    expect(screen.getByText(/Left:/)).toBeInTheDocument();
  });

  it('shows pause button for downloading tasks', () => {
    const pauseTask = vi.fn();
    const tasks = [makeTask({ status: 'downloading' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} pauseTask={pauseTask} />);
    fireEvent.click(screen.getByText('Stop'));
    expect(pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('shows resume button for paused tasks', () => {
    const resumeTask = vi.fn();
    const tasks = [makeTask({ status: 'paused' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} resumeTask={resumeTask} />);
    fireEvent.click(screen.getByText('Resume'));
    expect(resumeTask).toHaveBeenCalledWith('task-1');
  });

  it('shows resume button for error tasks', () => {
    const resumeTask = vi.fn();
    const tasks = [makeTask({ status: 'error' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} resumeTask={resumeTask} />);
    fireEvent.click(screen.getByText('Resume'));
    expect(resumeTask).toHaveBeenCalledWith('task-1');
  });

  it('shows open file and location buttons for completed tasks', () => {
    const openTaskFile = vi.fn(async () => {});
    const openTaskLocation = vi.fn(async () => {});
    const tasks = [makeTask({ status: 'completed' })];
    render(
      <TaskCardList {...defaultProps} tasks={tasks} openTaskFile={openTaskFile} openTaskLocation={openTaskLocation} />,
    );
    expect(screen.getByLabelText('Open File')).toBeInTheDocument();
    expect(screen.getByLabelText('Open Location')).toBeInTheDocument();
  });

  it('calls openTaskFile on open file button click', () => {
    const openTaskFile = vi.fn(async () => {});
    const tasks = [makeTask({ status: 'completed' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} openTaskFile={openTaskFile} />);
    fireEvent.click(screen.getByLabelText('Open File'));
    expect(openTaskFile).toHaveBeenCalledWith('task-1');
  });

  it('calls openTaskLocation on open location button click', () => {
    const openTaskLocation = vi.fn(async () => {});
    const tasks = [makeTask({ status: 'completed' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} openTaskLocation={openTaskLocation} />);
    fireEvent.click(screen.getByLabelText('Open Location'));
    expect(openTaskLocation).toHaveBeenCalledWith('task-1');
  });

  it('opens task properties dialog', () => {
    const openDialog = vi.fn();
    const tasks = [makeTask()];
    render(<TaskCardList {...defaultProps} tasks={tasks} openDialog={openDialog} />);
    fireEvent.click(screen.getByText('Properties'));
    expect(openDialog).toHaveBeenCalledWith('taskProperties', tasks[0]);
  });

  it('opens delete confirmation dialog', () => {
    const openDialog = vi.fn();
    const tasks = [makeTask()];
    render(<TaskCardList {...defaultProps} tasks={tasks} openDialog={openDialog} />);
    fireEvent.click(screen.getByText('Delete'));
    expect(openDialog).toHaveBeenCalledWith('confirmDelete', tasks[0]);
  });

  it('applies selected styling when task is selected', () => {
    const tasks = [makeTask()];
    const { container } = render(<TaskCardList {...defaultProps} tasks={tasks} selectedTaskId="task-1" />);
    const card = container.querySelector('.bg-\\[var\\(--bg-selected\\)\\]');
    expect(card).toBeInTheDocument();
  });

  it('applies checked styling when task is checked', () => {
    const tasks = [makeTask()];
    const { container } = render(<TaskCardList {...defaultProps} tasks={tasks} checkedTaskIds={new Set(['task-1'])} />);
    const card = container.querySelector('.bg-\\[var\\(--accent-primary\\)\\]\\/5');
    expect(card).toBeInTheDocument();
  });

  it('calls startRowPress on mouse down', () => {
    const startRowPress = vi.fn();
    const tasks = [makeTask()];
    render(<TaskCardList {...defaultProps} tasks={tasks} startRowPress={startRowPress} />);
    const nameSpan = screen.getByText('test-file.zip');
    fireEvent.mouseDown(nameSpan);
    expect(startRowPress).toHaveBeenCalledWith('task-1', expect.any(Object));
  });

  it('calls endRowPress on mouse up', () => {
    const endRowPress = vi.fn();
    const tasks = [makeTask()];
    render(<TaskCardList {...defaultProps} tasks={tasks} endRowPress={endRowPress} />);
    const nameSpan = screen.getByText('test-file.zip');
    fireEvent.mouseUp(nameSpan);
    expect(endRowPress).toHaveBeenCalledWith('task-1', expect.any(Object), expect.any(Function));
  });

  it('calls cancelRowPress on mouse leave', () => {
    const cancelRowPress = vi.fn();
    const tasks = [makeTask()];
    render(<TaskCardList {...defaultProps} tasks={tasks} cancelRowPress={cancelRowPress} />);
    const nameSpan = screen.getByText('test-file.zip');
    fireEvent.mouseLeave(nameSpan);
    expect(cancelRowPress).toHaveBeenCalled();
  });

  it('renders multiple tasks', () => {
    const tasks = [makeTask({ id: 't1', name: 'file1.zip' }), makeTask({ id: 't2', name: 'file2.zip' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} />);
    expect(screen.getByText('file1.zip')).toBeInTheDocument();
    expect(screen.getByText('file2.zip')).toBeInTheDocument();
  });

  it('does not show stop button for completed tasks', () => {
    const tasks = [makeTask({ status: 'completed' })];
    render(<TaskCardList {...defaultProps} tasks={tasks} />);
    expect(screen.queryByText('Stop')).not.toBeInTheDocument();
  });
});
