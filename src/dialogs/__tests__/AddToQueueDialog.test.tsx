import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AddToQueueDialog } from '../download/AddToQueueDialog';

const {
  mockQueues,
  mockTask,
  mockAddToast,
  mockMoveTaskToQueue,
  mockCreateQueueAndMoveTask,
  mockCloseDialog,
  storeRef,
} = vi.hoisted(() => {
  const mockQueues = [
    { id: 'main', name: 'Main Queue', downloadOrder: ['task-1'] },
    { id: 'nightly', name: 'Nightly Queue', downloadOrder: [] },
  ];
  const mockTask = {
    id: 'task-1',
    name: 'test-file.zip',
    url: 'https://example.com/test-file.zip',
    fileType: 'compressed' as const,
    status: 'queued' as const,
    sizeBytes: 1024,
    downloadedBytes: 0,
    speedBytesPerSec: 0,
    timeLeftSeconds: 0,
    dateAdded: '2024-01-01T00:00:00Z',
    category: 'compressed' as const,
    queueId: 'main',
    connections: 1,
    resumable: true,
    savePath: '/downloads',
    description: '',
    segments: [],
  };
  const mockAddToast = vi.fn();
  const mockMoveTaskToQueue = vi.fn();
  const mockCreateQueueAndMoveTask = vi.fn();
  const mockCloseDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return {
    mockQueues,
    mockTask,
    mockAddToast,
    mockMoveTaskToQueue,
    mockCreateQueueAndMoveTask,
    mockCloseDialog,
    storeRef,
  };
});

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

describe('AddToQueueDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'addToQueue', payload: mockTask },
      closeDialog: mockCloseDialog,
      queues: mockQueues,
      moveTaskToQueue: mockMoveTaskToQueue,
      createQueueAndMoveTask: mockCreateQueueAndMoveTask,
      addToast: mockAddToast,
      t: (k: string) => {
        const map: Record<string, string> = {
          queue_move_file_title: 'Move file to queue',
          queue_move_file_desc: 'Select a queue to move this download to.',
          queue_selected_file: 'Selected File',
          queue_available_queues: 'Available Queues',
          queue_scheduled_files: '{count} file(s)',
          queue_scheduled_time: 'Scheduled at {time}',
          queue_current: 'Current',
          queue_file_already_in_queue: 'File is already in this queue.',
          toast_info_title: 'Info',
          queue_create_new: 'Create New Queue',
          queue_new_placeholder: 'Queue name...',
          queue_create_and_move: 'Create & Move',
          queue_enter_name_first: 'Enter a queue name first.',
          toast_error_title: 'Error',
          btn_cancel: 'Cancel',
        };
        return map[k] || k;
      },
    };
  });

  it('renders task name', () => {
    render(<AddToQueueDialog />);
    expect(screen.getByText('test-file.zip')).toBeInTheDocument();
  });

  it('renders available queues', () => {
    render(<AddToQueueDialog />);
    expect(screen.getByText('Main Queue')).toBeInTheDocument();
    expect(screen.getByText('Nightly Queue')).toBeInTheDocument();
  });

  it('shows current badge on active queue', () => {
    render(<AddToQueueDialog />);
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('calls moveTaskToQueue when clicking a different queue', () => {
    render(<AddToQueueDialog />);
    fireEvent.click(screen.getByText('Nightly Queue'));
    expect(mockMoveTaskToQueue).toHaveBeenCalledWith('task-1', 'nightly');
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows toast when clicking the current queue', () => {
    render(<AddToQueueDialog />);
    const queueItems = screen.getAllByText('Main Queue');
    fireEvent.click(queueItems[0].closest('div')!);
    expect(mockAddToast).toHaveBeenCalledWith('info', 'Info', 'File is already in this queue.');
  });

  it('renders create new queue section', () => {
    render(<AddToQueueDialog />);
    expect(screen.getByText('Create New Queue')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Queue name...')).toBeInTheDocument();
    expect(screen.getByText('Create & Move')).toBeInTheDocument();
  });

  it('creates queue and moves task', () => {
    render(<AddToQueueDialog />);
    const input = screen.getByPlaceholderText('Queue name...');
    fireEvent.change(input, { target: { value: 'New Queue' } });
    fireEvent.click(screen.getByText('Create & Move'));
    expect(mockCreateQueueAndMoveTask).toHaveBeenCalledWith('New Queue', 'task-1');
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows error when creating queue with empty name', () => {
    render(<AddToQueueDialog />);
    fireEvent.click(screen.getByText('Create & Move'));
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Error', 'Enter a queue name first.');
  });

  it('closes dialog when cancel clicked', () => {
    render(<AddToQueueDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('renders file count for each queue', () => {
    render(<AddToQueueDialog />);
    expect(screen.getAllByText(/file\(s\)/).length).toBeGreaterThanOrEqual(1);
  });
});
