import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TaskPropertiesDialog } from '../tasks/TaskPropertiesDialog';

const { mockTask, mockAddToast, mockUpdateTaskProperties, mockCloseDialog, mockShowDirectoryPicker, storeRef } =
  vi.hoisted(() => {
    const mockTask = {
      id: 'task-1',
      name: 'test-file.zip',
      url: 'https://example.com/test-file.zip',
      fileType: 'compressed' as const,
      status: 'paused' as const,
      sizeBytes: 1024 * 1024,
      downloadedBytes: 500 * 1024,
      speedBytesPerSec: 0,
      timeLeftSeconds: 0,
      dateAdded: '2024-01-01T00:00:00Z',
      category: 'compressed' as const,
      queueId: 'main',
      connections: 4,
      resumable: true,
      savePath: '/downloads/test-file.zip',
      description: '',
      segments: [],
    };
    const mockAddToast = vi.fn();
    const mockUpdateTaskProperties = vi.fn();
    const mockCloseDialog = vi.fn();
    const mockShowDirectoryPicker = vi.fn();
    const storeRef: { current: Record<string, unknown> } = { current: {} };
    return {
      mockTask,
      mockAddToast,
      mockUpdateTaskProperties,
      mockCloseDialog,
      mockShowDirectoryPicker,
      storeRef,
    };
  });

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

vi.mock('../../api/tauriClient', () => ({
  tauriClient: {
    showDirectoryPicker: () => mockShowDirectoryPicker(),
  },
}));

vi.mock('../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => storeRef.current.engineCapabilities || { supportsDirectOption: () => true },
}));

describe('TaskPropertiesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'taskProperties', payload: mockTask },
      closeDialog: mockCloseDialog,
      updateTaskProperties: mockUpdateTaskProperties,
      addToast: mockAddToast,
      engineCapabilities: {
        supportsDirectOption: (key: string) => key === 'range' || key === 'segmented',
      },
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
    render(<TaskPropertiesDialog />);
    expect(screen.getByDisplayValue('test-file.zip')).toBeInTheDocument();
  });

  it('renders source URL', () => {
    render(<TaskPropertiesDialog />);
    const urlInput = screen.getByDisplayValue('https://example.com/test-file.zip');
    expect(urlInput).toBeInTheDocument();
  });

  it('renders save path', () => {
    render(<TaskPropertiesDialog />);
    const pathInput = screen.getByDisplayValue('/downloads/test-file.zip');
    expect(pathInput).toBeInTheDocument();
  });

  it('renders file size', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('1 MB')).toBeInTheDocument();
  });

  it('renders date added', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('2024-01-01T00:00:00Z')).toBeInTheDocument();
  });

  it('renders status', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('paused')).toBeInTheDocument();
  });

  it('renders resume support', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('Supported')).toBeInTheDocument();
  });

  it('renders category selector', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('renders connections selector', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('Connections')).toBeInTheDocument();
  });

  it('renders description field', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('renders resumable checkbox', () => {
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('Treat this download as resumable')).toBeInTheDocument();
  });

  it('calls updateTaskProperties when save clicked', () => {
    render(<TaskPropertiesDialog />);
    fireEvent.click(screen.getByText('Save Changes'));
    expect(mockUpdateTaskProperties).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        name: 'test-file.zip',
        category: 'compressed',
        connections: 4,
        resumable: true,
      }),
    );
  });

  it('closes dialog when save clicked', () => {
    render(<TaskPropertiesDialog />);
    fireEvent.click(screen.getByText('Save Changes'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('closes dialog when cancel clicked', () => {
    render(<TaskPropertiesDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('renders fallback when no task payload', () => {
    storeRef.current = {
      dialog: { active: 'taskProperties', payload: undefined },
      closeDialog: mockCloseDialog,
      updateTaskProperties: mockUpdateTaskProperties,
      addToast: mockAddToast,
      t: (k: string) => {
        const map: Record<string, string> = { btn_close: 'Close' };
        return map[k] || k;
      },
    };
    render(<TaskPropertiesDialog />);
    expect(screen.getByText('No download was selected.')).toBeInTheDocument();
  });

  it('shows close button in fallback state', () => {
    storeRef.current = {
      dialog: { active: 'taskProperties', payload: undefined },
      closeDialog: mockCloseDialog,
      updateTaskProperties: mockUpdateTaskProperties,
      addToast: mockAddToast,
      t: (k: string) => {
        const map: Record<string, string> = { btn_close: 'Close' };
        return map[k] || k;
      },
    };
    render(<TaskPropertiesDialog />);
    fireEvent.click(screen.getByText('Close'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('allows editing name', () => {
    render(<TaskPropertiesDialog />);
    const input = screen.getByDisplayValue('test-file.zip');
    fireEvent.change(input, { target: { value: 'renamed-file.zip' } });
    expect(input).toHaveValue('renamed-file.zip');
  });

  it('allows editing URL', () => {
    render(<TaskPropertiesDialog />);
    const input = screen.getByDisplayValue('https://example.com/test-file.zip');
    fireEvent.change(input, { target: { value: 'https://new-url.com/file.zip' } });
    expect(input).toHaveValue('https://new-url.com/file.zip');
  });

  it('allows editing description', () => {
    render(<TaskPropertiesDialog />);
    const descriptionInput = screen.getByDisplayValue('');
    fireEvent.change(descriptionInput, { target: { value: 'Updated description' } });
    expect(descriptionInput).toHaveValue('Updated description');
  });

  it('disables connections selector when segmented not supported', () => {
    storeRef.current = {
      ...storeRef.current,
      engineCapabilities: {
        supportsDirectOption: () => false,
      },
    };
    render(<TaskPropertiesDialog />);
    const select = screen.getByText('Single connection (range unavailable)');
    expect(select).toBeInTheDocument();
  });

  it('disables resumable checkbox when range not supported', () => {
    storeRef.current = {
      ...storeRef.current,
      engineCapabilities: {
        supportsDirectOption: (key: string) => key !== 'range',
      },
    };
    render(<TaskPropertiesDialog />);
    const checkbox = screen.getByText('Treat this download as resumable');
    expect(checkbox).toBeInTheDocument();
  });
});
