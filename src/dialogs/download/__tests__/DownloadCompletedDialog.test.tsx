import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialSettings } from '../../../initialData';
import type { DownloadItem } from '../../../types/desktop-ui.types';

const { closeDialog, openTaskFile, openTaskLocation, updateSettings, tasksMock, dialogPayload } = vi.hoisted(() => ({
  closeDialog: vi.fn(),
  openTaskFile: vi.fn(),
  openTaskLocation: vi.fn(),
  updateSettings: vi.fn(),
  tasksMock: [] as DownloadItem[],
  dialogPayload: { current: null as DownloadItem | null },
}));

vi.mock('../../../store/selectors', () => ({
  useDialogData: () => ({ active: 'downloadCompleted', payload: dialogPayload.current }),
  useTaskData: () => tasksMock,
  useTaskActions: () => ({ openTaskFile, openTaskLocation }),
  useSettingsData: () => initialSettings,
  useSettingsActions: () => ({ updateSettings }),
  useDialogActions: () => ({ closeDialog }),
  useI18n: () => (key: string) =>
    ({
      download_complete_message: 'Your download is ready.',
      download_complete_do_not_show_again: 'Do not show this completion window again',
      progress_close: 'Close',
      menu_open_file: 'Open File',
      menu_open_file_location: 'Open File Location',
    })[key] || key,
}));

import { DownloadCompletedDialog } from '../DownloadCompletedDialog';

const completedTask: DownloadItem = {
  id: 'completed-1',
  name: 'report.pdf',
  url: 'https://example.com/report.pdf',
  fileType: 'document',
  status: 'completed',
  sizeBytes: 2048,
  downloadedBytes: 2048,
  speedBytesPerSec: 0,
  timeLeftSeconds: 0,
  elapsedSeconds: 4,
  dateAdded: '2026-08-26T00:00:00Z',
  completedAt: '2026-08-26T00:00:04Z',
  category: 'document',
  queueId: 'main',
  connections: 1,
  resumable: true,
  savePath: 'C:\\Downloads\\report.pdf',
  description: '',
  segments: [{ id: 1, progress: 1, downloadedBytes: 2048, totalBytes: 2048, active: false, speed: 0 }],
};

describe('DownloadCompletedDialog', () => {
  beforeEach(() => {
    closeDialog.mockReset();
    openTaskFile.mockReset();
    openTaskLocation.mockReset();
    updateSettings.mockReset();
    tasksMock.length = 0;
    tasksMock.push(completedTask);
    dialogPayload.current = completedTask;
  });

  it('opens the completed file and dismisses the completion dialog', () => {
    render(<DownloadCompletedDialog />);

    fireEvent.click(screen.getByRole('button', { name: 'Open File' }));

    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(openTaskFile).toHaveBeenCalledWith(completedTask.id);
  });

  it('opens the file location and dismisses the completion dialog', () => {
    render(<DownloadCompletedDialog />);

    fireEvent.click(screen.getByRole('button', { name: 'Open File Location' }));

    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(openTaskLocation).toHaveBeenCalledWith(completedTask.id);
  });

  it('persists the opt-out choice before closing', () => {
    render(<DownloadCompletedDialog />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Do not show this completion window again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(updateSettings).toHaveBeenCalledWith(
      {
        ...initialSettings,
        extra: { ...initialSettings.extra, showCompletionDialog: false },
      },
      true,
    );
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });
});
