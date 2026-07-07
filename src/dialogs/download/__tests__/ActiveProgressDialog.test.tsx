import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActiveProgressDialog } from '../ActiveProgressDialog';

const mockTask = {
  id: 'task-1',
  name: 'test-file.zip',
  url: 'https://example.com/test-file.zip',
  fileType: 'compressed' as const,
  status: 'downloading' as const,
  sizeBytes: 1024 * 1024,
  downloadedBytes: 512 * 1024,
  speedBytesPerSec: 500 * 1024,
  timeLeftSeconds: 1,
  dateAdded: '2024-01-01T00:00:00Z',
  category: 'compressed' as const,
  queueId: 'main',
  connections: 4,
  resumable: true,
  savePath: '/downloads/test-file.zip',
  description: '',
  engine: 'curl' as const,
  segments: [
    { id: 0, progress: 50, active: true, totalBytes: 1024 * 1024 },
    { id: 1, progress: 30, active: false, totalBytes: 1024 * 1024 },
  ],
};

const { storeRef, mockCloseDialog, mockPauseTask, mockResumeTask, mockUpdateSettings } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const mockPauseTask = vi.fn();
  const mockResumeTask = vi.fn();
  const mockUpdateSettings = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { storeRef, mockCloseDialog, mockPauseTask, mockResumeTask, mockUpdateSettings };
});

vi.mock('../../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

vi.mock('../../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => ({
    directReady: true,
    mediaReady: true,
    directBlockedReason: () => null,
  }),
}));

describe('ActiveProgressDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'activeProgress', payload: mockTask },
      closeDialog: mockCloseDialog,
      tasks: [mockTask],
      pauseTask: mockPauseTask,
      resumeTask: mockResumeTask,
      settings: {
        connection: {
          speedLimiter: { enabled: false, maxSpeedKbs: 2048 },
        },
      },
      updateSettings: mockUpdateSettings,
      t: (k: string) => {
        const map: Record<string, string> = {
          topbar_stop: 'Stop',
        };
        return map[k] || k;
      },
    };
  });

  it('renders task URL', () => {
    render(<ActiveProgressDialog />);
    expect(screen.getByText('https://example.com/test-file.zip')).toBeInTheDocument();
  });

  it('shows downloading status fields', () => {
    render(<ActiveProgressDialog />);
    expect(screen.getByText('downloading')).toBeInTheDocument();
    expect(screen.getByText(/1\.00 MB/)).toBeInTheDocument();
    expect(screen.getByText(/500\.00 KB\/s/)).toBeInTheDocument();
  });

  it('shows Stop button when downloading', () => {
    render(<ActiveProgressDialog />);
    expect(screen.getByText('Stop')).toBeInTheDocument();
  });

  it('calls pauseTask when Stop is clicked', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Stop'));
    expect(mockPauseTask).toHaveBeenCalledWith('task-1');
  });

  it('shows Resume button for paused tasks', () => {
    storeRef.current = {
      ...storeRef.current,
      tasks: [{ ...mockTask, status: 'paused' as const }],
      dialog: { active: 'activeProgress', payload: { ...mockTask, status: 'paused' } },
    };
    render(<ActiveProgressDialog />);
    expect(screen.getByText('Resume')).toBeInTheDocument();
  });

  it('calls resumeTask when Resume is clicked', () => {
    storeRef.current = {
      ...storeRef.current,
      tasks: [{ ...mockTask, status: 'paused' as const }],
      dialog: { active: 'activeProgress', payload: { ...mockTask, status: 'paused' } },
    };
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Resume'));
    expect(mockResumeTask).toHaveBeenCalledWith('task-1');
  });

  it('shows Close button that closes dialog', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Close'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('switches to Speed Limit tab', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Speed Limit'));
    expect(screen.getByText('Use global speed limit')).toBeInTheDocument();
  });

  it('switches to Completion tab', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Completion'));
    expect(screen.getByText('Notify when complete')).toBeInTheDocument();
  });

  it('switches back to Status tab', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Speed Limit'));
    fireEvent.click(screen.getByText('Status'));
    expect(screen.getByText('downloading')).toBeInTheDocument();
  });

  it('toggles speed limit checkbox', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText('Speed Limit'));
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(mockUpdateSettings).toHaveBeenCalled();
  });

  it('toggles show details', () => {
    render(<ActiveProgressDialog />);
    const detailsBtn = screen.getByText(/Show Details/);
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Connection segments')).toBeInTheDocument();
    expect(screen.getByText(/Receiving data/)).toBeInTheDocument();
  });

  it('hides details when toggle again', () => {
    render(<ActiveProgressDialog />);
    fireEvent.click(screen.getByText(/Show Details/));
    expect(screen.getByText('Connection segments')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Hide Details/));
    expect(screen.queryByText('Connection segments')).not.toBeInTheDocument();
  });

  it('shows Finished badge for completed tasks', () => {
    storeRef.current = {
      ...storeRef.current,
      tasks: [{ ...mockTask, status: 'completed' as const }],
      dialog: { active: 'activeProgress', payload: { ...mockTask, status: 'completed' } },
    };
    render(<ActiveProgressDialog />);
    expect(screen.getByText('Finished')).toBeInTheDocument();
  });
});
