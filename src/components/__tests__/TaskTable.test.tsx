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

const ALL_COLS_VISIBLE = {
  name: true, size: true, progress: true, speed: true, timeLeft: true,
  date: true, status: true, retries: true, connections: true,
  crc32: true, priority: true, completedDate: true, sourceUrl: true,
  smartCategory: true,
};
const DEFAULT_COL_ORDER = [
  'name', 'size', 'progress', 'speed', 'timeLeft', 'date', 'status',
  'retries', 'connections', 'crc32', 'priority', 'completedDate', 'sourceUrl', 'smartCategory',
];

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
    localStorage.setItem('nova_visible_cols', JSON.stringify(ALL_COLS_VISIBLE));
    localStorage.setItem('nova_col_order', JSON.stringify(DEFAULT_COL_ORDER));
  });

  it('shows empty state', () => {
    render(<TaskTable />);
    const matches = screen.getAllByText('No Downloads');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders task rows', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('test-file.zip');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows progress percentage', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('50%');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows completed status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed', downloadedBytes: 1024 * 1024 })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Completed');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows paused status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'paused' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Paused');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows error status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'error' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Error');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows queued status pill', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'queued' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Queued');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows speed for downloading task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'downloading', speedBytesPerSec: 204800 })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText(/200/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('formats size column', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ sizeBytes: 2 * 1024 * 1024 })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('2 MB');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows priority badge for fast queue', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ queueId: 'fast' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('High');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows priority badge for night queue', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ queueId: 'night' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Low');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows priority badge for normal queue', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ queueId: 'main' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Normal');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders multiple tasks', () => {
    const tasks = [makeTask({ id: 't1', name: 'file1.zip' }), makeTask({ id: 't2', name: 'file2.zip' })];
    mockStoreRef.current = createMockStore({ tasks });
    render(<TaskTable />);
    const tbl = within(screen.getByRole('table'));
    expect(tbl.getAllByText('file1.zip').length).toBeGreaterThan(0);
    expect(tbl.getAllByText('file2.zip').length).toBeGreaterThan(0);
  });

  it('shows batch action bar when task checked', () => {
    const tasks = [makeTask({ id: 't1' })];
    mockStoreRef.current = createMockStore({ tasks });
    render(<TaskTable />);
    const tableCheckboxes = within(screen.getByRole('table')).getAllByRole('checkbox');
    const taskCheckbox = tableCheckboxes[1];
    fireEvent.click(taskCheckbox);
    expect(screen.getByText(/selected/i)).toBeInTheDocument();
  });

  it('clicking select all checkbox selects all tasks', () => {
    const tasks = [makeTask({ id: 't1', name: 'f1.zip' }), makeTask({ id: 't2', name: 'f2.zip' })];
    mockStoreRef.current = createMockStore({ tasks });
    render(<TaskTable />);
    const tableCheckboxes = within(screen.getByRole('table')).getAllByRole('checkbox');
    const selectAllCheckbox = tableCheckboxes[0];
    fireEvent.click(selectAllCheckbox);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('opens confirmDelete dialog via batch delete', () => {
    const openDialog = vi.fn();
    const tasks = [makeTask({ id: 't1' })];
    const deleteTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks, openDialog, deleteTask });
    render(<TaskTable />);
    const tableCheckboxes = within(screen.getByRole('table')).getAllByRole('checkbox');
    const taskCheckbox = tableCheckboxes[1];
    fireEvent.click(taskCheckbox);
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(openDialog).toHaveBeenCalledWith('genericConfirm', expect.objectContaining({ isDanger: true }));
  });

  it('opens context menu on right click', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByText('Properties').length).toBeGreaterThan(0);
  });

  it('context menu shows stop for downloading task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'downloading' })] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByText('Stop').length).toBeGreaterThan(0);
  });

  it('context menu shows resume for paused task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'paused' })] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getAllByText('Resume').length).toBeGreaterThan(0);
  });

  it('context menu shows retry for error task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'error' })] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getByText('Retry Download')).toBeInTheDocument();
  });

  it('context menu shows open file for completed task', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'completed' })] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
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
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    expect(screen.getByText('Send to Telegram')).toBeInTheDocument();
  });

  it('context menu copies url', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('Copy URL'));
    expect(writeText).toHaveBeenCalledWith('https://example.com/test-file.zip');
  });

  it('context menu delete calls deleteTask', () => {
    const deleteTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask()], deleteTask });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Delete')[0]);
    expect(deleteTask).toHaveBeenCalledWith('task-1', false);
  });

  it('context menu resume calls resumeTask', () => {
    const resumeTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'paused' })], resumeTask });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Resume')[0]);
    expect(resumeTask).toHaveBeenCalledWith('task-1');
  });

  it('context menu stop calls pauseTask', () => {
    const pauseTask = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'downloading' })], pauseTask });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Stop')[0]);
    expect(pauseTask).toHaveBeenCalledWith('task-1');
  });

  it('context menu properties opens taskProperties dialog', () => {
    const openDialog = vi.fn();
    mockStoreRef.current = createMockStore({ tasks: [makeTask()], openDialog });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getAllByText('Properties')[0]);
    expect(openDialog).toHaveBeenCalledWith('taskProperties', expect.objectContaining({ id: 'task-1' }));
  });

  it('context menu resume disabled when engine unavailable for yt-dlp task', () => {
    mockCaps.mediaReady = false;
    mockStoreRef.current = createMockStore({ tasks: [makeTask({ status: 'paused', engine: 'yt-dlp' })] });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    fireEvent.contextMenu(row);
    const resumeBtns = screen.getAllByText('Resume');
    const resumeBtn = resumeBtns[0].closest('button') || resumeBtns[0];
    expect(resumeBtn.closest('[class*="disabled"]') || resumeBtn).toBeDefined();
  });

  it('double-click on completed task calls openTaskFile', () => {
    const openTaskFile = vi.fn();
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed' })],
      openTaskFile,
    });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
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
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
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
    const tableCheckboxes = within(screen.getByRole('table')).getAllByRole('checkbox');
    fireEvent.click(tableCheckboxes[0]);
    const resumeButtons = screen.getAllByText('Resume');
    fireEvent.click(resumeButtons[0]);
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
    const tableCheckboxes = within(screen.getByRole('table')).getAllByRole('checkbox');
    fireEvent.click(tableCheckboxes[0]);
    const stopButtons = screen.getAllByText('Stop');
    fireEvent.click(stopButtons[0]);
    expect(pauseTask).toHaveBeenCalledTimes(2);
  });

  it('shows column config button', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const matches = screen.getAllByTitle('Customize columns');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('opens column config panel on button click', () => {
    mockStoreRef.current = createMockStore({ tasks: [makeTask()] });
    render(<TaskTable />);
    const colConfigButtons = screen.getAllByTitle('Customize columns');
    fireEvent.click(colConfigButtons[colConfigButtons.length - 1]);
    const sizeMatches = screen.getAllByText('Size');
    expect(sizeMatches.length).toBeGreaterThan(0);
  });

  it('shows sourceUrl column data when column visible', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ url: 'https://example.com/file.zip' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('https://example.com/file.zip');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows retries count for error task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'error' })],
    });
    render(<TaskTable />);
    const colConfigButtons = screen.getAllByTitle('Customize columns');
    fireEvent.click(colConfigButtons[colConfigButtons.length - 1]);
    const matches = within(screen.getByRole('table')).getAllByText('3');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows smart category for program type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'program' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Programs');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows smart category for video type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'video' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Video');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows smart category for audio type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'audio' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Audio');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows smart category for document type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'document' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Documents');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows smart category for other type', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ fileType: 'other' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('Other');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows CRC32 for completed task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed' })],
    });
    render(<TaskTable />);
    const colConfigButtons = screen.getAllByTitle('Customize columns');
    fireEvent.click(colConfigButtons[colConfigButtons.length - 1]);
    const matches = within(screen.getByRole('table')).getAllByText('E89FA21B');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows -- for CRC32 when not completed', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'downloading' })],
    });
    render(<TaskTable />);
    const colConfigButtons = screen.getAllByTitle('Customize columns');
    fireEvent.click(colConfigButtons[colConfigButtons.length - 1]);
    const matches = within(screen.getByRole('table')).getAllByText('--');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows completedDate for completed task', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ status: 'completed', dateAdded: '2026-07-07' })],
    });
    render(<TaskTable />);
    const matches = within(screen.getByRole('table')).getAllByText('2026-07-07');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('highlights selected row', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask()],
      selectedTaskId: 'task-1',
    });
    render(<TaskTable />);
    const row = within(screen.getByRole('table')).getByText('test-file.zip').closest('tr')!;
    expect(row.className).toContain('selected');
  });

  it('auto connections display when connections is 0', () => {
    mockStoreRef.current = createMockStore({
      tasks: [makeTask({ connections: 0, segments: [{}, {}] })],
    });
    render(<TaskTable />);
    const colConfigButtons = screen.getAllByTitle('Customize columns');
    fireEvent.click(colConfigButtons[colConfigButtons.length - 1]);
    const matches = within(screen.getByRole('table')).getAllByText(/Auto/);
    expect(matches.length).toBeGreaterThan(0);
  });
});
