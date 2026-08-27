import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialSettings } from '../../initialData';

const state = vi.hoisted(() => ({
  triggerBatchDownload: vi.fn(),
  setActivePage: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('../../store/selectors', () => ({
  useDialogActions: () => ({ closeDialog: vi.fn() }),
  useTaskActions: () => ({ triggerBatchDownload: state.triggerBatchDownload }),
  useToastActions: () => ({ addToast: state.addToast }),
  useSettingsData: () => initialSettings,
  useQueueData: () => [{ id: 'main', name: 'Main' }],
  useNavigationActions: () => ({ setActivePage: state.setActivePage }),
  useI18n: () => (key: string) => key,
}));

vi.mock('../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => ({
    directReady: true,
    directProtocols: ['http', 'https'],
    supportsDirectProtocol: (url: string) => url.startsWith('https://'),
    supportsDirectOption: () => true,
    sanitizeDirectOptions: <T,>(value: T) => value,
  }),
}));

import { BatchImportPage } from '../BatchImportPage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('BatchImportPage import lifecycle', () => {
  beforeEach(() => {
    state.triggerBatchDownload.mockReset();
    state.setActivePage.mockReset();
    state.addToast.mockReset();
  });

  it('submits a batch once, remains busy while the daemon is accepting it, and navigates only after completion', async () => {
    const user = userEvent.setup();
    const accepted = deferred<{ attemptedCount: number; acceptedCount: number }>();
    state.triggerBatchDownload.mockReturnValue(accepted.promise);
    render(<BatchImportPage />);

    await user.type(screen.getByRole('textbox'), 'https://example.test/archive.zip');
    const submit = screen.getByRole('button', { name: 'batch_import_queue' });

    await user.click(submit);
    await user.click(submit);

    expect(state.triggerBatchDownload).toHaveBeenCalledTimes(1);
    expect(state.triggerBatchDownload).toHaveBeenCalledWith(
      ['https://example.test/archive.zip'],
      expect.objectContaining({ queueId: 'main' }),
    );
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-busy', 'true');
    expect(state.setActivePage).not.toHaveBeenCalled();

    accepted.resolve({ attemptedCount: 1, acceptedCount: 1 });
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    expect(submit).toHaveAttribute('aria-busy', 'false');
    expect(state.setActivePage).toHaveBeenCalledWith('downloads');
  });

  it('keeps the user on the batch page when the daemon accepts no links', async () => {
    const user = userEvent.setup();
    state.triggerBatchDownload.mockResolvedValue({ attemptedCount: 1, acceptedCount: 0 });
    render(<BatchImportPage />);

    await user.type(screen.getByRole('textbox'), 'https://example.test/rejected.zip');
    await user.click(screen.getByRole('button', { name: 'batch_import_queue' }));

    await waitFor(() => {
      expect(state.triggerBatchDownload).toHaveBeenCalledTimes(1);
    });
    expect(state.setActivePage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'batch_import_queue' })).toBeEnabled();
  });

  it('does not submit a blank or unsupported batch', async () => {
    const user = userEvent.setup();
    render(<BatchImportPage />);

    await user.type(screen.getByRole('textbox'), 'ftp://example.test/archive.zip');
    await user.click(screen.getByRole('button', { name: 'batch_import_queue' }));

    expect(state.triggerBatchDownload).not.toHaveBeenCalled();
    expect(state.setActivePage).not.toHaveBeenCalled();
    expect(state.addToast).toHaveBeenCalledWith(
      'error',
      'toast_error_title',
      expect.stringContaining('batch_no_valid_links'),
    );
  });
});
