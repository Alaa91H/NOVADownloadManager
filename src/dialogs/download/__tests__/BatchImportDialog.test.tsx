import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BatchImportDialog } from '../BatchImportDialog';

const engineRef: { current: Record<string, unknown> } = { current: {} };

const { storeRef, mockCloseDialog, mockTriggerBatchDownload, mockAddToast } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const mockTriggerBatchDownload = vi.fn();
  const mockAddToast = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { storeRef, mockCloseDialog, mockTriggerBatchDownload, mockAddToast };
});

vi.mock('../../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

const mockEngineDefaults = {
  directReady: true,
  directProtocols: ['http', 'https', 'ftp'],
  supportsDirectProtocol: (url: string) => url.startsWith('http'),
  supportsDirectOption: (key: string) => ['segmented', 'range', 'referer', 'userAgent', 'proxy', 'retryCount', 'timeoutSec', 'headers', 'cookies'].includes(key),
  sanitizeDirectOptions: (options: Record<string, unknown>) => options,
};
Object.assign(engineRef.current, mockEngineDefaults);

const mockNoDirectEngine = () => {
  engineRef.current = {
    directReady: false,
    directProtocols: [],
    supportsDirectProtocol: () => false,
    supportsDirectOption: () => false,
    sanitizeDirectOptions: (o: Record<string, unknown>) => o,
  };
};

vi.mock('../../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => engineRef.current,
}));

vi.mock('../../../utils/clipboard', () => ({
  readClipboardText: vi.fn().mockRejectedValue(new Error('Clipboard unavailable')),
}));

describe('BatchImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      closeDialog: mockCloseDialog,
      triggerBatchDownload: mockTriggerBatchDownload,
      addToast: mockAddToast,
      settings: {
        saveAndCategories: {
          categoryFolders: {},
          defaultFolder: '/downloads',
        },
        extra: { userAgent: '' },
      },
      queues: [
        { id: 'main', name: 'Main Queue' },
        { id: 'nightly', name: 'Nightly Queue' },
      ],
      t: (k: string) => {
        const map: Record<string, string> = {
          toast_error_title: 'Error',
          btn_cancel: 'Cancel',
        };
        return map[k] || k;
      },
    };
  });

  it('renders info banner', () => {
    render(<BatchImportDialog />);
    expect(screen.getByText(/Enter one download link per line/)).toBeInTheDocument();
  });

  it('renders textarea for links', () => {
    render(<BatchImportDialog />);
    const textarea = document.querySelector('textarea');
    expect(textarea).toBeInTheDocument();
  });

  it('renders Import & Queue button', () => {
    render(<BatchImportDialog />);
    expect(screen.getByText('Import & Queue')).toBeInTheDocument();
  });

  it('renders Cancel button', () => {
    render(<BatchImportDialog />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('closes dialog on Cancel', () => {
    render(<BatchImportDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows advanced section when toggled', () => {
    render(<BatchImportDialog />);
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText('Queue')).toBeInTheDocument();
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(screen.getByText('Save Directory')).toBeInTheDocument();
  });

  it('imports valid URLs', async () => {
    render(<BatchImportDialog />);
    const textarea = document.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'https://example.com/file1.zip\nhttps://example.com/file2.zip' } });
    fireEvent.click(screen.getByText('Import & Queue'));
    await waitFor(() => {
      expect(mockTriggerBatchDownload).toHaveBeenCalledWith(
        ['https://example.com/file1.zip', 'https://example.com/file2.zip'],
        expect.any(Object),
      );
    });
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows error when no valid URLs', async () => {
    render(<BatchImportDialog />);
    const textarea = document.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'invalid\nnot a url' } });
    fireEvent.click(screen.getByText('Import & Queue'));
    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith('error', 'Error', expect.stringContaining('No valid direct links'));
    });
  });

  it('shows error when input is empty', async () => {
    render(<BatchImportDialog />);
    fireEvent.click(screen.getByText('Import & Queue'));
    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith('error', 'Error', expect.stringContaining('No valid direct links'));
    });
  });

  it('shows direct engine not ready warning', () => {
    mockNoDirectEngine();
    render(<BatchImportDialog />);
    expect(screen.getByText(/Direct imports are disabled/)).toBeInTheDocument();
  });
});
