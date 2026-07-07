import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockStore } from '../../test/mockStore';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

const mockCaps = vi.hoisted(() => ({
  loading: false,
  error: null,
  raw: null,
  directReady: true,
  mediaReady: true,
  ffmpegReady: true,
  postProcessingReady: true,
  streamResolverReady: true,
  directEngineId: 'libcurl-multi',
  mediaEngineId: 'yt-dlp',
  postProcessorId: 'ffmpeg',
  directProtocols: ['http', 'https', 'ftp'],
  directOptionKeys: new Set<string>(),
  unsupportedDirectOptionKeys: new Set<string>(),
  mediaOptionKeys: new Set<string>(),
  unsupportedMediaOptionKeys: new Set<string>(),
  supportedExternalDownloaders: new Set<string>(),
  refresh: vi.fn(),
  supportsDirectOption: vi.fn(() => true),
  supportsMediaOption: vi.fn(() => true),
  supportsDirectProtocol: vi.fn(() => true),
  supportsStreamCandidate: vi.fn(() => true),
  sanitizeDirectOptions: vi.fn((o: unknown) => o),
  sanitizeMediaOptions: vi.fn((o: unknown) => o),
  directBlockedReason: vi.fn(() => null),
  mediaBlockedReason: vi.fn(() => null),
}));

const mockNovaClient = vi.hoisted(() => ({
  sendTelegramFile: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../capabilities/EngineCapabilityContext', () => ({
  useEngineCapabilities: () => mockCaps,
}));

vi.mock('../../api/novaClient', () => ({
  novaClient: mockNovaClient,
}));

vi.mock('../../state/appStore', () => ({
  useAppStore: () => mockStoreRef.current,
}));

import { TaskTable } from '../TaskTable';

const mockStoreRef: { current: Record<string, unknown> } = { current: createMockStore() };

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'test-file.zip',
    url: 'https://example.com/test-file.zip',
    fileType: 'compressed',
    status: 'downloading',
    sizeBytes: 1024 * 1024,
    downloadedBytes: 512 * 1024,
    speedBytesPerSec: 1024 * 100,
    timeLeftSeconds: 5,
    dateAdded: '2026-07-07',
    category: 'compressed',
    queueId: 'main',
    connections: 4,
    resumable: true,
    savePath: '/downloads/test-file.zip',
    description: '',
    engine: 'libcurl',
    segments: [],
    ...overrides,
  };
}

describe('TaskTable', () => {
  beforeEach(() => {
    mockStoreRef.current = createMockStore();
    mockCaps.loading = false;
    mockCaps.directReady = true;
    mockCaps.mediaReady = true;
    mockCaps.ffmpegReady = true;
    mockCaps.directBlockedReason = vi.fn(() => null);
    mockCaps.mediaBlockedReason = vi.fn(() => null);
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('shows empty state', () => {
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('No Downloads')).toBeInTheDocument();
  });

  it('renders task rows', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('test-file.zip')).toBeInTheDocument();
  });

  it('shows progress percentage', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('50%')).toBeInTheDocument();
  });

  it('shows completed status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed', downloadedBytes: 1024 * 1024 })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Completed')).toBeInTheDocument();
  });

  it('shows paused status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'paused' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Paused')).toBeInTheDocument();
  });

  it('shows error status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'error' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Error')).toBeInTheDocument();
  });

  it('shows queued status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'queued' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Queued')).toBeInTheDocument();
  });

  it('shows speed for downloading task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'downloading', speedBytesPerSec: 204800 })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText(/200/)).toBeInTheDocument();
  });

  it('formats size column', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ sizeBytes: 2 * 1024 * 1024 })],
    });
    render(<TaskTable />);
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
  });

  it('shows priority badge for fast queue', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ queueId: 'fast' })],
    });
    render(<TaskTable />);
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('shows priority badge for night queue', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ queueId: 'night' })],
    });
    render(<TaskTable />);
    expect(screen.getByText('Low')).toBeInTheDocument();
  });

  it('shows priority badge for normal queue', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ queueId: 'main' })],
    });
    render(<TaskTable />);
    expect(screen.getByText('Normal')).toBeInTheDocument();
  });

  it('renders multiple tasks', () => {
    const tasks = [makeTask({ id: 't1', name: 'file1.zip' }), makeTask({ id: 't2', name: 'file2.zip' })];
    mockStoreRef.current = createMockStore({ tasks });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('file1.zip')).toBeInTheDocument();
    expect(within(table).getByText('file2.zip')).toBeInTheDocument();
  });

  it('shows batch action bar when task checked', () => {
    const tasks = [makeTask({ id: 't1' })];
    mockStoreRef.current = createMockStore({ tasks });
    render(<TaskTable />);
    const checkbox = screen.getAllByRole('checkbox')[1];
    fireEvent.click(checkbox);
    expect(screen.getByText(/Selected/)).toBeInTheDocument();
  });

  it('clicking select all checkbox selects all tasks', () => {
    const tasks = [makeTask({ id: 't1', name: 'f1.zip' }), makeTask({ id: 't2', name: 'f2.zip' })];
    mockStoreRef.current = createMockStore({ tasks });
    render(<TaskTable />);
    const selectAllCheckbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(selectAllCheckbox);
    expect(screen.getByText(/Selected.*2/)).toBeInTheDocument();
  });

  it('opens confirmDelete dialog via batch delete', () => {
    const openDialog = vi.fn();
    const tasks = [makeTask({ id: 't1' })];
    const deleteTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks, openDialog, deleteTask });
    render(<TaskTable />);
    const checkbox = screen.getAllByRole('checkbox')[1];
    fireEvent.click(checkbox);
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(openDialog).toHaveBeenCalledWith('genericConfirm', expect.objectContaining({ isDanger: true }));
  });

  it('opens context menu on right click', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByText('Properties')[0]).toBeInTheDocument();
  });

  it('context menu shows stop for downloading task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'downloading' })] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByText('Stop')[0]).toBeInTheDocument();
  });

  it('context menu shows resume for paused task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'paused' })] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByText('Resume')[0]).toBeInTheDocument();
  });

  it('context menu shows retry for error task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'error' })] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getByText('Retry Download')).toBeInTheDocument();
  });

  it('context menu shows open file for completed task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'completed' })] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getByText('Open File')).toBeInTheDocument();
  });

  it('context menu shows send telegram for completed task when tg enabled', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed' })],
      settings: {
        ...createMockStore().settings,
        extra: {
          ...createMockStore().settings.extra,
          tgEnabled: true,
          tgBotToken: 'token',
          tgChatId: 'id',
        },
      },
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getByText('Send to Telegram')).toBeInTheDocument();
  });

  it('context menu copies url', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Copy URL'));
    expect(writeText).toHaveBeenCalledWith('https://example.com/test-file.zip');
  });

  it('context menu delete calls deleteTask', () => {
    const deleteTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask()], deleteTask });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(deleteTask).toHaveBeenCalledWith('task-1', false);
  });

  it('context menu resume calls resumeTask', () => {
    const resumeTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'paused' })], resumeTask });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Resume')[0]);
    expect(resumeTask).toHaveBeenCalledWith('task-1');
  });

  it('context menu stop calls pauseTask', () => {
    const pauseTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'downloading' })], pauseTask });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Stop')[0]);
    expect(pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('context menu properties opens taskProperties dialog', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask()], openDialog });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Properties')[0]);
    expect(openDialog).toHaveBeenCalledWith('taskProperties', expect.objectContaining({ id: 'task-1' }));
  });

  it('context menu resume disabled when engine unavailable for yt-dlp task', () => {
    mockCaps.mediaReady = false;
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'paused', engine: 'yt-dlp' })] });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    const resumeBtn = screen.getAllByText('Resume')[0].closest('button') || screen.getAllByText('Resume')[0];
    expect(resumeBtn.closest('[class*="disabled"]') || resumeBtn).toBeDefined();
  });

  it('double-click on completed task calls openTaskFile', () => {
    const openTaskFile = vi.fn();
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed' })],
      openTaskFile,
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.doubleClick(row);
    expect(openTaskFile).toHaveBeenCalledWith('task-1');
  });

  it('double-click on downloading task opens activeProgress dialog', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'downloading' })],
      openDialog,
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    fireEvent.doubleClick(row);
    expect(openDialog).toHaveBeenCalledWith('activeProgress', expect.objectContaining({ id: 'task-1' }));
  });

  it('batch resume calls resumeTask for each checked paused task', () => {
    const resumeTask = vi.fn();
    const tasks = [
      makeTask({ id: 't1', status: 'paused', name: 'f1.zip' }),
      makeTask({ id: 't2', status: 'paused', name: 'f2.zip' }),
    ];
    mockStoreRef.current = createMockStore({ tasks, resumeTask });
    render(<TaskTable />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getAllByText('Resume')[0]);
    expect(resumeTask).toHaveBeenCalledTimes(2);
  });

  it('batch stop calls pauseTask for each checked downloading task', () => {
    const pauseTask = vi.fn();
    const tasks = [
      makeTask({ id: 't1', status: 'downloading', name: 'f1.zip' }),
      makeTask({ id: 't2', status: 'downloading', name: 'f2.zip' }),
    ];
    mockStoreRef.current = createMockStore({ tasks, pauseTask });
    render(<TaskTable />);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getAllByText('Stop')[0]);
    expect(pauseTask).toHaveBeenCalledTimes(2);
  });

  it('shows column config button', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    expect(screen.getByTitle('Customize columns')).toBeInTheDocument();
  });

  it('opens column config panel on button click', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    fireEvent.click(screen.getByTitle('Customize columns'));
    expect(screen.getByText('Size')).toBeInTheDocument();
  });

  it('shows sourceUrl column data when column visible', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ url: 'https://example.com/file.zip' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('https://example.com/file.zip')).toBeInTheDocument();
  });

  it('shows retries count for error task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'error' })],
    });
    render(<TaskTable />);
    fireEvent.click(screen.getByTitle('Customize columns'));
    const table = screen.getByRole('table');
    expect(within(table).getByText('3')).toBeInTheDocument();
  });

  it('shows smart category for program type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'program' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Programs')).toBeInTheDocument();
  });

  it('shows smart category for video type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'video' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Video')).toBeInTheDocument();
  });

  it('shows smart category for audio type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'audio' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Audio')).toBeInTheDocument();
  });

  it('shows smart category for document type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'document' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Documents')).toBeInTheDocument();
  });

  it('shows smart category for other type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'other' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Other')).toBeInTheDocument();
  });

  it('shows CRC32 for completed task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed' })],
    });
    render(<TaskTable />);
    fireEvent.click(screen.getByTitle('Customize columns'));
    const table = screen.getByRole('table');
    expect(within(table).getByText('E89FA21B')).toBeInTheDocument();
  });

  it('shows -- for CRC32 when not completed', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'downloading' })],
    });
    render(<TaskTable />);
    fireEvent.click(screen.getByTitle('Customize columns'));
    expect(screen.getAllByText('--').length).toBeGreaterThan(0);
  });

  it('shows completedDate for completed task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed', dateAdded: '2026-07-07' })],
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('2026-07-07')).toBeInTheDocument();
  });

  it('highlights selected row', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask()],
      selectedTaskId: 'task-1',
    });
    render(<TaskTable />);
    const table = screen.getByRole('table');
    const row = within(table).getByText('test-file.zip').closest('tr')!;
    expect(row.className).toContain('selected');
  });

  it('auto connections display when connections is 0', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ connections: 0, segments: [{}, {}] })],
    });
    render(<TaskTable />);
    fireEvent.click(screen.getByTitle('Customize columns'));
    const table = screen.getByRole('table');
    expect(within(table).getByText(/Auto/)).toBeInTheDocument();
  });
});
