import { describe, it, expect, beforeEach, vi } from 'vitest';
import { taskStore, mergeDaemonTasks } from '../taskStore';
import type { DownloadItem } from '../../types/desktop-ui.types';

const { uiStoreMocks, queueStoreMocks, novaMock } = vi.hoisted(() => {
  let taskCounter = 0;
  return {
    uiStoreMocks: {
      selectedTaskId: null as string | null,
      setSelectedTaskId: vi.fn(),
      addToast: vi.fn(),
      openDialog: vi.fn(),
    },
    queueStoreMocks: {
      addTaskToQueueOrder: vi.fn(),
      removeTaskFromQueue: vi.fn(),
    },
    novaMock: {
      resetCounter: () => {
        taskCounter = 0;
      },
      createDownload: vi.fn().mockImplementation((item: Record<string, unknown>) => {
        taskCounter += 1;
        return Promise.resolve({
          ...item,
          id: `new_task_${String(taskCounter)}`,
          dateAdded: new Date().toISOString(),
          downloadedBytes: 0,
          speedBytesPerSec: 0,
          timeLeftSeconds: 0,
          segments: [],
        });
      }),
      createDownloadFromCaptureReview: vi
        .fn()
        .mockImplementation((_reviewId: string, item: Record<string, unknown>) => {
          taskCounter += 1;
          return Promise.resolve({
            ...item,
            id: `review_task_${String(taskCounter)}`,
            dateAdded: new Date().toISOString(),
            downloadedBytes: 0,
            speedBytesPerSec: 0,
            timeLeftSeconds: 0,
            segments: [],
          });
        }),
    },
  };
});

vi.mock('../../api/novaClient', () => ({
  novaClient: {
    createDownload: novaMock.createDownload,
    createDownloadFromCaptureReview: novaMock.createDownloadFromCaptureReview,
    pauseDownload: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve({ id, status: 'paused', name: 'Paused File' })),
    resumeDownload: vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve({ id, status: 'downloading', name: 'Resumed File' })),
    deleteDownload: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../api/tauriClient', () => ({
  tauriClient: {
    openDownloadedFile: vi.fn().mockResolvedValue(true),
    revealDownloadedFile: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock('../../utils/sound', () => ({ playAppSound: vi.fn() }));
vi.mock('../uiStore', () => ({
  uiStore: {
    getState: () => uiStoreMocks,
  },
}));
vi.mock('../bridgeStore', () => ({
  bridgeStore: {
    getState: () => ({
      status: 'connected',
      setIsDegradedMode: vi.fn(),
    }),
  },
}));
vi.mock('../queueStore', () => ({
  queueStore: {
    getState: () => queueStoreMocks,
  },
}));
vi.mock('../settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      settings: {
        saveAndCategories: { categoryFolders: { other: '/downloads' } },
      },
    }),
  },
}));

const makeTask = (id: string, status: DownloadItem['status']): DownloadItem => ({
  id,
  name: `${id}.zip`,
  url: `http://example.com/${id}.zip`,
  fileType: 'other',
  status,
  sizeBytes: 1024,
  downloadedBytes: status === 'completed' ? 1024 : 0,
  speedBytesPerSec: 0,
  timeLeftSeconds: 0,
  elapsedSeconds: 0,
  dateAdded: '2024-01-01T00:00:00Z',
  category: 'other',
  queueId: 'main',
  connections: 1,
  resumable: true,
  savePath: `/downloads/${id}.zip`,
  description: '',
  segments: [],
});

describe('mergeDaemonTasks', () => {
  it('returns shallow copies of each task', () => {
    const tasks = [
      { id: '1', name: 'a' },
      { id: '2', name: 'b' },
    ] as DownloadItem[];
    const result = mergeDaemonTasks(tasks);
    expect(result).toHaveLength(2);
    expect(result[0]).not.toBe(tasks[0]);
    expect(result[0].id).toBe('1');
  });

  it('returns the previous array by reference when nothing changed', () => {
    taskStore.setState({ tasks: [makeTask('task1', 'downloading')] });
    const prev = taskStore.getState().tasks;
    const result = mergeDaemonTasks([makeTask('task1', 'downloading')]);
    expect(result).toBe(prev);
  });

  it('returns a new array when any task changed', () => {
    taskStore.setState({ tasks: [makeTask('task1', 'downloading')] });
    const prev = taskStore.getState().tasks;
    const result = mergeDaemonTasks([makeTask('task1', 'completed')]);
    expect(result).not.toBe(prev);
    expect(result[0].status).toBe('completed');
  });

  it('does not hide metadata or direct-option changes from the daemon', () => {
    const existing = makeTask('task1', 'paused');
    taskStore.setState({ tasks: [existing] });
    const updated = {
      ...makeTask('task1', 'paused'),
      url: 'https://cdn.example.com/refreshed.bin',
      description: 'Refreshed signed link',
      directOptions: { referer: 'https://example.com/page' },
    };

    const result = mergeDaemonTasks([updated]);
    expect(result).not.toBe(taskStore.getState().tasks);
    expect(result[0]).toMatchObject({
      url: 'https://cdn.example.com/refreshed.bin',
      description: 'Refreshed signed link',
      directOptions: { referer: 'https://example.com/page' },
    });
  });

  it('returns a new array when the list changed size', () => {
    taskStore.setState({ tasks: [makeTask('task1', 'downloading')] });
    const prev = taskStore.getState().tasks;
    const result = mergeDaemonTasks([makeTask('task1', 'downloading'), makeTask('task2', 'queued')]);
    expect(result).not.toBe(prev);
    expect(result).toHaveLength(2);
  });

  it('returns a new array when the order changed', () => {
    const a = makeTask('task1', 'downloading');
    const b = makeTask('task2', 'queued');
    taskStore.setState({ tasks: [a, b] });
    const prev = taskStore.getState().tasks;
    const result = mergeDaemonTasks([b, a]);
    expect(result).not.toBe(prev);
    expect(result).toHaveLength(2);
  });
});

describe('taskStore', () => {
  beforeEach(() => {
    novaMock.resetCounter();
    novaMock.createDownload.mockClear();
    novaMock.createDownloadFromCaptureReview.mockClear();
    taskStore.setState({
      tasks: [
        {
          id: 'task1',
          name: 'file1.zip',
          url: 'http://example.com/file1.zip',
          fileType: 'compressed',
          status: 'downloading',
          sizeBytes: 1024,
          downloadedBytes: 512,
          speedBytesPerSec: 100,
          timeLeftSeconds: 5,
          category: 'other',
          queueId: 'main',
          connections: 4,
          resumable: true,
          savePath: '/downloads/file1.zip',
          description: '',
          elapsedSeconds: 10,
          engine: 'curl',
          segments: [],
          dateAdded: '2024-01-01T00:00:00Z',
        },
        {
          id: 'task2',
          name: 'file2.pdf',
          url: 'http://example.com/file2.pdf',
          fileType: 'other',
          status: 'completed',
          sizeBytes: 2048,
          downloadedBytes: 2048,
          speedBytesPerSec: 0,
          timeLeftSeconds: 0,
          category: 'other',
          queueId: 'main',
          connections: 4,
          resumable: true,
          savePath: '/downloads/file2.pdf',
          description: '',
          elapsedSeconds: 30,
          engine: 'curl',
          segments: [],
          dateAdded: '2024-01-02T00:00:00Z',
        },
        {
          id: 'task3',
          name: 'video.mp4',
          url: 'http://example.com/video.mp4',
          fileType: 'video',
          status: 'queued',
          sizeBytes: 0,
          downloadedBytes: 0,
          speedBytesPerSec: 0,
          timeLeftSeconds: 0,
          category: 'other',
          queueId: 'main',
          connections: 0,
          resumable: true,
          savePath: '/downloads/video.mp4',
          description: '',
          elapsedSeconds: 0,
          engine: 'yt-dlp',
          segments: [],
          dateAdded: '2024-01-03T00:00:00Z',
        },
      ],
      completedTaskIds: new Set(),
      hasSyncedDownloads: false,
    });
  });

  it('has initial tasks', () => {
    expect(taskStore.getState().tasks).toHaveLength(3);
  });

  it('setTasks replaces task list', () => {
    taskStore.getState().setTasks([{ id: 'x', name: 'only' } as DownloadItem]);
    expect(taskStore.getState().tasks).toHaveLength(1);
    expect(taskStore.getState().tasks[0].id).toBe('x');
  });

  it('setTasksWith uses updater function', () => {
    taskStore.getState().setTasksWith((prev) => prev.filter((t) => t.status === 'completed'));
    expect(taskStore.getState().tasks).toHaveLength(1);
    expect(taskStore.getState().tasks[0].id).toBe('task2');
  });

  it('setCompletedTaskIds', () => {
    taskStore.getState().setCompletedTaskIds(new Set(['a', 'b']));
    expect(taskStore.getState().completedTaskIds).toEqual(new Set(['a', 'b']));
  });

  it('setHasSyncedDownloads', () => {
    taskStore.getState().setHasSyncedDownloads(true);
    expect(taskStore.getState().hasSyncedDownloads).toBe(true);
  });

  it('updateTaskProperties updates a specific task', () => {
    taskStore.getState().updateTaskProperties('task1', { name: 'renamed.zip' });
    const task = taskStore.getState().tasks.find((t) => t.id === 'task1');
    expect(task).toBeDefined();
    if (!task) return;
    expect(task.name).toBe('renamed.zip');
  });

  it('updateTaskProperties no-ops for nonexistent task', () => {
    taskStore.getState().updateTaskProperties('nonexistent', { name: 'X' });
    expect(taskStore.getState().tasks).toHaveLength(3);
  });

  describe('addTask', () => {
    it('adds a new task on success', async () => {
      const task = await taskStore.getState().addTask(
        {
          name: 'new.zip',
          url: 'http://example.com/new.zip',
          fileType: 'other',
          status: 'queued',
          sizeBytes: 0,
          category: 'other',
          queueId: 'main',
          connections: 0,
          resumable: true,
          savePath: '/downloads/new.zip',
          description: '',
          directOptions: undefined,
          elapsedSeconds: 0,
        },
        false,
      );
      expect(task).not.toBeNull();
      if (!task) return;
      expect(task.id).toBe('new_task_1');
    });

    it('consumes a browser capture review instead of creating a direct task', async () => {
      const task = await taskStore.getState().addTask(
        {
          name: 'captured.zip',
          url: 'https://example.com/captured.zip',
          fileType: 'compressed',
          status: 'queued',
          sizeBytes: 42,
          category: 'compressed',
          queueId: 'main',
          connections: 4,
          resumable: true,
          savePath: '/downloads/captured.zip',
          description: 'browser capture',
          directOptions: undefined,
          elapsedSeconds: 0,
        },
        false,
        false,
        'review-123',
      );

      expect(task?.id).toBe('review_task_1');
      expect(novaMock.createDownloadFromCaptureReview).toHaveBeenCalledWith(
        'review-123',
        expect.objectContaining({ startImmediately: false, url: 'https://example.com/captured.zip' }),
      );
      expect(novaMock.createDownload).not.toHaveBeenCalled();
    });
  });

  describe('pauseTask', () => {
    it('pauses a native engine task', async () => {
      await taskStore.getState().pauseTask('task1');
      const task = taskStore.getState().tasks.find((t) => t.id === 'task1');
      expect(task).toBeDefined();
      if (!task) return;
      expect(task.status).toBe('paused');
    });
  });

  describe('deleteTask', () => {
    it('removes task from list', async () => {
      await taskStore.getState().deleteTask('task1', false);
      expect(taskStore.getState().tasks.find((t) => t.id === 'task1')).toBeUndefined();
      expect(taskStore.getState().tasks).toHaveLength(2);
    });

    it('calls novaClient.deleteDownload with deleteDisk flag', async () => {
      const { novaClient } = await import('../../api/novaClient');
      await taskStore.getState().deleteTask('task1', true);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(novaClient.deleteDownload).toHaveBeenCalledWith('task1', true);
    });

    it('prunes the task id from all queue downloadOrder lists', async () => {
      await taskStore.getState().deleteTask('task1', false);
      expect(queueStoreMocks.removeTaskFromQueue).toHaveBeenCalledWith('task1');
    });
  });

  describe('triggerBatchDownload', () => {
    beforeEach(() => {
      taskStore.setState({ tasks: [] });
      uiStoreMocks.addToast.mockClear();
      novaMock.resetCounter();
    });

    it('accepts all URLs with a single summary toast (silent per-task adds)', async () => {
      const result = await taskStore
        .getState()
        .triggerBatchDownload(['http://example.com/a.zip', 'http://example.com/b.zip', 'http://example.com/c.zip']);
      expect(result).toEqual({ attemptedCount: 3, acceptedCount: 3 });
      expect(taskStore.getState().tasks).toHaveLength(3);
      // One toast for the batch summary, none per individual task.
      expect(uiStoreMocks.addToast).toHaveBeenCalledTimes(1);
    });

    it('skips empty lines and reports only non-empty attempts', async () => {
      const result = await taskStore.getState().triggerBatchDownload(['http://example.com/a.zip', '', '  ']);
      expect(result).toEqual({ attemptedCount: 1, acceptedCount: 1 });
      expect(taskStore.getState().tasks).toHaveLength(1);
      expect(uiStoreMocks.addToast).toHaveBeenCalledTimes(1);
    });

    it('reports a zero-acceptance result without a success toast', async () => {
      const result = await taskStore.getState().triggerBatchDownload(['', '  ']);
      expect(result).toEqual({ attemptedCount: 0, acceptedCount: 0 });
      expect(taskStore.getState().tasks).toHaveLength(0);
      expect(uiStoreMocks.addToast).not.toHaveBeenCalled();
    });
  });

  describe('openTaskFile', () => {
    it('opens file for completed task', async () => {
      const { tauriClient } = await import('../../api/tauriClient');
      await taskStore.getState().openTaskFile('task2');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tauriClient.openDownloadedFile).toHaveBeenCalledWith('/downloads/file2.pdf');
    });
  });

  describe('openTaskLocation', () => {
    it('reveals file location for task with savePath', async () => {
      const { tauriClient } = await import('../../api/tauriClient');
      await taskStore.getState().openTaskLocation('task1');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(tauriClient.revealDownloadedFile).toHaveBeenCalledWith('/downloads/file1.zip');
    });
  });
});
