import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateLinkDialog } from '../tasks/UpdateLinkDialog';

const { mockTask, mockAddToast, mockUpdateTaskProperties, mockCloseDialog, storeRef } = vi.hoisted(() => {
  const mockTask = {
    id: 'task-1',
    name: 'test-file.zip',
    url: 'https://example.com/test-file.zip',
    fileType: 'compressed' as const,
    status: 'paused' as const,
    sizeBytes: 1024,
    downloadedBytes: 500,
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
  const mockUpdateTaskProperties = vi.fn();
  const mockCloseDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { mockTask, mockAddToast, mockUpdateTaskProperties, mockCloseDialog, storeRef };
});

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

describe('UpdateLinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'updateLink', payload: mockTask },
      closeDialog: mockCloseDialog,
      updateTaskProperties: mockUpdateTaskProperties,
      addToast: mockAddToast,
      t: (k: string) => {
        const map: Record<string, string> = {
          toast_error_title: 'Error',
          btn_close: 'Close',
          btn_cancel: 'Cancel',
        };
        return map[k] || k;
      },
    };
  });

  it('renders task name', () => {
    render(<UpdateLinkDialog />);
    expect(screen.getByText('test-file.zip')).toBeInTheDocument();
  });

  it('renders current link', () => {
    render(<UpdateLinkDialog />);
    expect(screen.getByText('https://example.com/test-file.zip')).toBeInTheDocument();
  });

  it('renders browser mode by default', () => {
    render(<UpdateLinkDialog />);
    expect(screen.getByText('Open Page')).toBeInTheDocument();
  });

  it('switches to manual mode', () => {
    render(<UpdateLinkDialog />);
    fireEvent.click(screen.getByText('Paste Link'));
    expect(screen.getByText('Update Link')).toBeInTheDocument();
  });

  it('shows new URL input in manual mode', () => {
    storeRef.current = {
      ...storeRef.current,
      window: { open: vi.fn() },
    };
    render(<UpdateLinkDialog />);
    fireEvent.click(screen.getByText('Paste Link'));
    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  it('calls updateTaskProperties when updating valid URL', () => {
    render(<UpdateLinkDialog />);
    fireEvent.click(screen.getByText('Paste Link'));
    const input = screen.getByDisplayValue('https://example.com/test-file.zip');
    fireEvent.change(input, { target: { value: 'https://new-url.com/file.zip' } });
    fireEvent.click(screen.getByText('Update Link'));
    expect(mockUpdateTaskProperties).toHaveBeenCalledWith('task-1', { url: 'https://new-url.com/file.zip' });
  });

  it('shows error for invalid URL', () => {
    render(<UpdateLinkDialog />);
    fireEvent.click(screen.getByText('Paste Link'));
    const input = screen.getByDisplayValue('https://example.com/test-file.zip');
    fireEvent.change(input, { target: { value: 'ftp://invalid' } });
    fireEvent.click(screen.getByText('Update Link'));
    expect(mockAddToast).toHaveBeenCalledWith('error', 'Error', expect.any(String));
  });

  it('closes dialog with close button in browser mode', () => {
    render(<UpdateLinkDialog />);
    const closeBtn = screen.getAllByText('Close');
    fireEvent.click(closeBtn[0]);
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('closes dialog with cancel in manual mode', () => {
    render(<UpdateLinkDialog />);
    fireEvent.click(screen.getByText('Paste Link'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('renders fallback when no task payload', () => {
    storeRef.current = {
      dialog: { active: 'updateLink', payload: undefined },
      closeDialog: mockCloseDialog,
      updateTaskProperties: mockUpdateTaskProperties,
      addToast: mockAddToast,
      t: (k: string) => {
        const map: Record<string, string> = { btn_close: 'Close' };
        return map[k] || k;
      },
    };
    render(<UpdateLinkDialog />);
    expect(screen.getByText('No file was selected for link renewal.')).toBeInTheDocument();
  });

  it('shows close button in fallback state', () => {
    storeRef.current = {
      dialog: { active: 'updateLink', payload: undefined },
      closeDialog: mockCloseDialog,
      updateTaskProperties: mockUpdateTaskProperties,
      addToast: mockAddToast,
      t: (k: string) => {
        const map: Record<string, string> = { btn_close: 'Close' };
        return map[k] || k;
      },
    };
    render(<UpdateLinkDialog />);
    fireEvent.click(screen.getByText('Close'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });
});
