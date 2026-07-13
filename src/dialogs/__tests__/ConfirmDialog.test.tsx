import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfirmDialog } from '../common/ConfirmDialog';

const { mockDeleteTask, mockCloseDialog, storeRef } = vi.hoisted(() => {
  const mockDeleteTask = vi.fn();
  const mockCloseDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { mockDeleteTask, mockCloseDialog, storeRef };
});

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

const task = {
  id: 'task-1',
  name: 'test-file.zip',
  url: 'https://example.com/test-file.zip',
  fileType: 'compressed' as const,
  status: 'completed' as const,
  sizeBytes: 1024,
  downloadedBytes: 1024,
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

describe('ConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'confirmDelete', payload: task },
      closeDialog: mockCloseDialog,
      deleteTask: mockDeleteTask,
      t: (k: string) => {
        const map: Record<string, string> = {
          confirm_remove_download: 'Are you sure you want to remove this download?',
          confirm_delete_disk: 'Also delete files from disk',
          action_delete: 'Delete',
          btn_cancel: 'Cancel',
          btn_close: 'Close',
        };
        return map[k] || k;
      },
    };
  });

  it('renders confirmation message', () => {
    render(<ConfirmDialog />);
    expect(screen.getByText('Are you sure you want to remove this download?')).toBeInTheDocument();
  });

  it('renders task name', () => {
    render(<ConfirmDialog />);
    expect(screen.getByText('test-file.zip')).toBeInTheDocument();
  });

  it('renders delete from disk checkbox', () => {
    render(<ConfirmDialog />);
    expect(screen.getByText('Also delete files from disk')).toBeInTheDocument();
  });

  it('calls deleteTask with deleteDisk=false when delete clicked without checkbox', async () => {
    mockDeleteTask.mockResolvedValue(undefined);
    storeRef.current = {
      ...storeRef.current,
      deleteTask: mockDeleteTask,
    };
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('task-1', false);
      expect(mockCloseDialog).toHaveBeenCalled();
    });
  });

  it('calls deleteTask with deleteDisk=true when checkbox checked and delete clicked', async () => {
    mockDeleteTask.mockResolvedValue(undefined);
    storeRef.current = {
      ...storeRef.current,
      deleteTask: mockDeleteTask,
    };
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByText('Also delete files from disk'));
    fireEvent.click(screen.getByText('Delete'));
    await vi.waitFor(() => {
      expect(mockDeleteTask).toHaveBeenCalledWith('task-1', true);
    });
  });

  it('closes dialog when cancel clicked', () => {
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('renders fallback when no task payload', () => {
    storeRef.current = {
      dialog: { active: 'confirmDelete', payload: null },
      closeDialog: mockCloseDialog,
      deleteTask: mockDeleteTask,
      t: (k: string) => {
        const map: Record<string, string> = {
          btn_close: 'Close',
          confirm_item_not_found: 'The download item was not found.',
        };
        return map[k] || k;
      },
    };
    render(<ConfirmDialog />);
    expect(screen.getByText('The download item was not found.')).toBeInTheDocument();
  });

  it('shows close button in fallback state', () => {
    storeRef.current = {
      dialog: { active: 'confirmDelete', payload: null },
      closeDialog: mockCloseDialog,
      deleteTask: mockDeleteTask,
      t: (k: string) => {
        const map: Record<string, string> = { btn_close: 'Close' };
        return map[k] || k;
      },
    };
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByText('Close'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('handles payload without id gracefully', () => {
    storeRef.current = {
      dialog: { active: 'confirmDelete', payload: { something: 'else' } },
      closeDialog: mockCloseDialog,
      deleteTask: mockDeleteTask,
      t: (k: string) => {
        const map: Record<string, string> = {
          btn_close: 'Close',
          confirm_item_not_found: 'The download item was not found.',
        };
        return map[k] || k;
      },
    };
    render(<ConfirmDialog />);
    expect(screen.getByText('The download item was not found.')).toBeInTheDocument();
  });
});
