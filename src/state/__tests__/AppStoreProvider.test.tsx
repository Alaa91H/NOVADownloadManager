import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listCaptureReviews: vi.fn(),
  listDownloads: vi.fn().mockResolvedValue([]),
  streamDownloads: vi.fn().mockReturnValue(() => {}),
  configureBrowserExtension: vi.fn().mockResolvedValue(undefined),
  updateTelegramConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../api/novaClient', () => ({
  novaClient: api,
  setApiBase: vi.fn(),
  setAuthToken: vi.fn(),
}));

vi.mock('../../api/tauriClient', () => ({
  tauriClient: {
    getDownloadsDir: vi.fn().mockResolvedValue('/tmp/NOVA-downloads'),
    saveConfigToDisk: vi.fn().mockResolvedValue(undefined),
    checkDaemonHealth: vi.fn().mockResolvedValue({ status: 'connected', version: 'test', pid: 1 }),
    triggerNativeNotification: vi.fn().mockResolvedValue(undefined),
    scanDownloadedFile: vi.fn().mockResolvedValue(undefined),
    openDownloadedFile: vi.fn().mockResolvedValue(undefined),
    revealDownloadedFile: vi.fn().mockResolvedValue(undefined),
    checkTauriUpdate: vi.fn().mockResolvedValue({ hasUpdate: false, latestVersion: 'test' }),
  },
  getDaemonUrl: vi.fn().mockResolvedValue('http://127.0.0.1:8765'),
  getDaemonToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../../utils/windowMode', () => ({ isDetachedWindow: () => true }));
vi.mock('../../utils/sound', () => ({ playAppSound: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), setEnabled: vi.fn(), setMinLevel: vi.fn() },
}));

import { AppStoreProvider } from '../appStore';
import { uiStore } from '../../store/uiStore';

describe('AppStoreProvider capture-review polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.listCaptureReviews.mockReset();
    api.listDownloads.mockClear();
    uiStore.setState({ dialog: { active: null } });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('serializes polls and does not reopen a review after an empty response while its dialog was active', async () => {
    let resolveInitial: ((reviews: Array<{ reviewId: string; url: string; createdAt: number }>) => void) | undefined;
    const review = { reviewId: 'capture-1', url: 'https://example.test/file.zip', createdAt: 1 };
    api.listCaptureReviews
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ reviewId: string; url: string; createdAt: number }>>((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([review]);

    render(
      <AppStoreProvider>
        <div />
      </AppStoreProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.listCaptureReviews).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitial?.([review]);
      await Promise.resolve();
    });
    expect(uiStore.getState().dialog).toEqual({ active: 'addDownload', payload: review });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.listCaptureReviews).toHaveBeenCalledTimes(2);
    expect(uiStore.getState().dialog.active).toBe('addDownload');

    uiStore.getState().closeDialog();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(api.listCaptureReviews).toHaveBeenCalledTimes(3);
    expect(uiStore.getState().dialog.active).toBeNull();
  });
});
