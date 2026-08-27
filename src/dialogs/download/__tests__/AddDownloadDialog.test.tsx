import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialSettings } from '../../../initialData';

const { dialogPayload, probeDownload, taskItems, addTask } = vi.hoisted(() => ({
  dialogPayload: { current: { url: '' } },
  probeDownload: vi.fn(),
  taskItems: { current: [] as Array<{ url: string }> },
  addTask: vi.fn(),
}));

vi.mock('../../../store/selectors', () => ({
  useDialogData: () => ({ active: 'addDownload', payload: dialogPayload.current }),
  useDialogActions: () => ({ closeDialog: vi.fn(), openDialog: vi.fn() }),
  useSettingsData: () => initialSettings,
  useTaskActions: () => ({ addTask }),
  useTaskData: () => taskItems.current,
  useToastActions: () => ({ addToast: vi.fn() }),
  useI18n: () => (key: string) => key,
}));

vi.mock('../../../api/tauriClient', () => ({
  tauriClient: {
    getDownloadsDir: vi.fn().mockResolvedValue('/tmp/Downloads'),
    validateVpnRoute: vi.fn().mockResolvedValue({ ok: true, message: '' }),
    showDirectoryPicker: vi.fn(),
  },
}));

vi.mock('../../../api/novaClient', () => ({
  novaClient: { probeDownload },
}));

vi.mock('../../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => ({
    directReady: true,
    supportsDirectOption: () => true,
    directBlockedReason: () => null,
    sanitizeDirectOptions: <T,>(value: T) => value,
  }),
}));

import { AddDownloadDialog } from '../AddDownloadDialog';

describe('AddDownloadDialog probe inspection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dialogPayload.current = { url: 'https://landing.example.test/download?tracking=private' };
    probeDownload.mockReset();
    addTask.mockReset();
    taskItems.current = [];
    probeDownload.mockResolvedValue({
      url: 'https://landing.example.test/download?tracking=private',
      finalUrl: 'https://cdn.example.test/files/archive.zip?signature=private',
      fileName: 'archive.zip',
      fileType: 'compressed',
      sizeBytes: 4096,
      resumable: true,
      supportsSegments: true,
      contentType: 'application/zip; charset=binary',
      digestSha256: 'a'.repeat(64),
      linkMirrors: ['https://mirror.example.test/archive.zip?token=private'],
      httpStatus: 206,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a technical summary after a successful probe without exposing signed URL details', async () => {
    render(<AddDownloadDialog />);

    expect(screen.queryByTestId('download-probe-inspection')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    const inspection = screen.getByTestId('download-probe-inspection');
    expect(inspection).toHaveTextContent('HTTP 206');
    expect(inspection).toHaveTextContent('MIME application/zip');
    expect(inspection).toHaveTextContent('Range bytes');
    expect(inspection).toHaveTextContent('SHA-256 aaaaaaaaaaaa…');
    expect(inspection).toHaveTextContent('https://landing.example.test → https://cdn.example.test');
    expect(inspection).toHaveTextContent('Link 1');
    expect(inspection).not.toHaveTextContent('tracking=private');
    expect(inspection).not.toHaveTextContent('signature=private');
    expect(inspection).not.toHaveTextContent('token=private');
  });

  it('warns for an exact existing URL without exposing signed query details', async () => {
    const signedUrl = 'https://cdn.example.test/archive.zip?signature=private-token';
    dialogPayload.current = { url: signedUrl };
    taskItems.current = [{ url: signedUrl }];

    await act(async () => {
      render(<AddDownloadDialog />);
      await Promise.resolve();
    });

    const warning = screen.getByTestId('exact-url-duplicate-warning');
    expect(warning).toHaveTextContent('toast_warning_title');
    expect(warning).toHaveTextContent('queue_file_already_in_queue');
    expect(warning).not.toHaveTextContent('signature=private-token');
  });

  it('does not warn when a signed URL has a different query token', async () => {
    dialogPayload.current = { url: 'https://cdn.example.test/archive.zip?signature=new-token' };
    taskItems.current = [{ url: 'https://cdn.example.test/archive.zip?signature=old-token' }];

    await act(async () => {
      render(<AddDownloadDialog />);
      await Promise.resolve();
    });

    expect(screen.queryByTestId('exact-url-duplicate-warning')).not.toBeInTheDocument();
  });

  it('keeps intentional exact repeats available for queueing', async () => {
    const signedUrl = 'https://cdn.example.test/archive.zip?signature=private-token';
    dialogPayload.current = { url: signedUrl };
    taskItems.current = [{ url: signedUrl }];
    addTask.mockResolvedValue({ id: 'intentional-repeat' });

    await act(async () => {
      render(<AddDownloadDialog />);
      await Promise.resolve();
    });

    const queueButton = screen.getByRole('button', { name: 'add_dl_queue_only' });
    expect(queueButton).toBeEnabled();

    await act(async () => {
      fireEvent.click(queueButton);
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({ url: signedUrl }), false, false, undefined);
  });
});
