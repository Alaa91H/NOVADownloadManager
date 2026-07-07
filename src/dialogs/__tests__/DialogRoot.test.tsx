import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

vi.mock('../download/AddDownloadDialog', () => ({
  AddDownloadDialog: () => <div data-testid="add-download-dialog">AddDownloadDialog</div>,
}));
vi.mock('../download/WebpageGrabberDialog', () => ({
  WebpageGrabberDialog: () => <div data-testid="webpage-grabber-dialog">WebpageGrabberDialog</div>,
}));
vi.mock('../download/YoutubeDownloadDialog', () => ({
  YoutubeDownloadDialog: () => <div data-testid="youtube-download-dialog">YoutubeDownloadDialog</div>,
}));
vi.mock('../download/BatchImportDialog', () => ({
  BatchImportDialog: () => <div data-testid="batch-import-dialog">BatchImportDialog</div>,
}));
vi.mock('../diagnostics/DiagnosticsDialog', () => ({
  DiagnosticsDialog: () => <div data-testid="diagnostics-dialog">DiagnosticsDialog</div>,
}));
vi.mock('../tasks/TaskPropertiesDialog', () => ({
  TaskPropertiesDialog: () => <div data-testid="task-properties-dialog">TaskPropertiesDialog</div>,
}));
vi.mock('../tasks/UpdateLinkDialog', () => ({
  UpdateLinkDialog: () => <div data-testid="update-link-dialog">UpdateLinkDialog</div>,
}));
vi.mock('../download/AddToQueueDialog', () => ({
  AddToQueueDialog: () => <div data-testid="add-to-queue-dialog">AddToQueueDialog</div>,
}));
vi.mock('../download/ActiveProgressDialog', () => ({
  ActiveProgressDialog: () => <div data-testid="active-progress-dialog">ActiveProgressDialog</div>,
}));
vi.mock('../system/AboutDialog', () => ({
  AboutDialog: () => <div data-testid="about-dialog">AboutDialog</div>,
}));
vi.mock('../integration/BrowserIntegrationDialog', () => ({
  BrowserIntegrationDialog: () => <div data-testid="browser-integration-dialog">BrowserIntegrationDialog</div>,
}));
vi.mock('../common/ConfirmDialog', () => ({
  ConfirmDialog: () => <div data-testid="confirm-dialog">ConfirmDialog</div>,
}));
vi.mock('../common/GenericConfirmDialog', () => ({
  GenericConfirmDialog: () => <div data-testid="generic-confirm-dialog">GenericConfirmDialog</div>,
}));

import DefaultDialogRoot from '../DialogRoot';

const { storeRef, mockCloseDialog, mockTasks } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const mockTasks = [{ id: 'task-1', name: 'test.zip', sizeBytes: 1000, downloadedBytes: 500 }];
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { storeRef, mockCloseDialog, mockTasks };
});

describe('DialogRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: null, payload: null },
      closeDialog: mockCloseDialog,
      tasks: mockTasks,
      t: (k: string) => {
        const map: Record<string, string> = {
          action_add: 'Add Download',
          dlg_webpage_grabber: 'Webpage Grabber',
          dlg_media_downloader: 'Media Downloader',
          action_add_batch: 'Batch Import',
          nav_diagnostics: 'Diagnostics',
          nav_properties: 'Properties',
          action_update_link: 'Update Link',
          action_add_queue: 'Add to Queue',
          nav_about: 'About',
          nav_browser_integration: 'Browser Integration',
          action_delete: 'Delete',
          app_name: 'NOVA',
        };
        return map[k] || k;
      },
    };
  });

  it('returns null when no dialog is active', () => {
    const { container } = render(<DefaultDialogRoot />);
    expect(container.innerHTML).toBe('');
  });

  it('renders AddDownloadDialog for addDownload', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'addDownload', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('add-download-dialog')).toBeInTheDocument();
    expect(screen.getByText('Add Download')).toBeInTheDocument();
  });

  it('renders WebpageGrabberDialog for webpageGrabber', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'webpageGrabber', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('webpage-grabber-dialog')).toBeInTheDocument();
    expect(screen.getByText('Webpage Grabber')).toBeInTheDocument();
  });

  it('renders YoutubeDownloadDialog for youtubeDownload', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'youtubeDownload', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('youtube-download-dialog')).toBeInTheDocument();
    expect(screen.getByText('Media Downloader')).toBeInTheDocument();
  });

  it('renders BatchImportDialog for batchDownload', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'batchDownload', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('batch-import-dialog')).toBeInTheDocument();
    expect(screen.getByText('Batch Import')).toBeInTheDocument();
  });

  it('renders DiagnosticsDialog for diagnostics', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'diagnostics', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('diagnostics-dialog')).toBeInTheDocument();
    expect(screen.getByText('Diagnostics')).toBeInTheDocument();
  });

  it('renders TaskPropertiesDialog for taskProperties', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'taskProperties', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('task-properties-dialog')).toBeInTheDocument();
    expect(screen.getByText('Properties')).toBeInTheDocument();
  });

  it('renders UpdateLinkDialog for updateLink', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'updateLink', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('update-link-dialog')).toBeInTheDocument();
    expect(screen.getByText('Update Link')).toBeInTheDocument();
  });

  it('renders AddToQueueDialog for addToQueue', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'addToQueue', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('add-to-queue-dialog')).toBeInTheDocument();
    expect(screen.getByText('Add to Queue')).toBeInTheDocument();
  });

  it('renders ActiveProgressDialog for activeProgress', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'activeProgress', payload: mockTasks[0] } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('active-progress-dialog')).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  it('renders AboutDialog for about', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'about', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('about-dialog')).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();
  });

  it('renders BrowserIntegrationDialog for browserIntegration', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'browserIntegration', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('browser-integration-dialog')).toBeInTheDocument();
    expect(screen.getByText('Browser Integration')).toBeInTheDocument();
  });

  it('renders ConfirmDialog for confirmDelete', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'confirmDelete', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('renders GenericConfirmDialog for genericConfirm', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'genericConfirm', payload: null } };
    render(<DefaultDialogRoot />);
    expect(screen.getByTestId('generic-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('NOVA')).toBeInTheDocument();
  });

  it('returns null for unknown dialog type', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'unknownDialog', payload: null } };
    const { container } = render(<DefaultDialogRoot />);
    expect(container.innerHTML).toBe('');
  });

  it('closes dialog when close button clicked', () => {
    storeRef.current = { ...storeRef.current, dialog: { active: 'about', payload: null } };
    render(<DefaultDialogRoot />);
    const closeBtn = screen.getByTitle('Close');
    fireEvent.click(closeBtn);
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('computes progress for activeProgress with no matching task in list', () => {
    storeRef.current = {
      ...storeRef.current,
      tasks: [],
      dialog: { active: 'activeProgress', payload: { id: 'orphan', name: 'orphan.zip', sizeBytes: 200, downloadedBytes: 50 } },
    };
    render(<DefaultDialogRoot />);
    expect(screen.getByText(/25%/)).toBeInTheDocument();
    expect(screen.getByTestId('active-progress-dialog')).toBeInTheDocument();
  });

  it('renders fallback title when activeProgress payload has no task info', () => {
    storeRef.current = {
      ...storeRef.current,
      dialog: { active: 'activeProgress', payload: {} },
    };
    render(<DefaultDialogRoot />);
    expect(screen.getByText('Properties')).toBeInTheDocument();
  });

  it('renders with active-progress-modal id for activeProgress', () => {
    storeRef.current = {
      ...storeRef.current,
      dialog: { active: 'activeProgress', payload: mockTasks[0] },
    };
    render(<DefaultDialogRoot />);
    const modal = document.getElementById('active-progress-modal');
    expect(modal).toBeInTheDocument();
  });

  it('handles minimizable modal for activeProgress', () => {
    storeRef.current = {
      ...storeRef.current,
      dialog: { active: 'activeProgress', payload: mockTasks[0] },
    };
    render(<DefaultDialogRoot />);
    const minBtn = screen.getByTitle('Minimize');
    fireEvent.click(minBtn);
    expect(screen.getByText(/Minimized:/)).toBeInTheDocument();
  });
});
