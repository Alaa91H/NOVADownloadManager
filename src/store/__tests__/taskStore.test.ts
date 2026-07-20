import { describe, it, expect, beforeEach, vi } from 'vitest';
import { taskStore, mergeDaemonTasks } from '../taskStore';
import type { DownloadItem } from '../../types/desktop-ui.types';

vi.mock('../../api/novaClient', () => ({
  novaClient: {
    createDownload: vi.fn().mockImplementation((item: Record<string, unknown>) =>
      Promise.resolve({
        ...item,
        id: 'new_task_1',
        dateAdded: new Date().toISOString(),
        downloadedBytes: 0,
        speedBytesPerSec: 0,
        timeLeftSeconds: 0,
        segments: [],
      }),
    ),
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
    getState: () => ({
      selectedTaskId: null,
      setSelectedTaskId: vi.fn(),
      addToast: vi.fn(),
      openDialog: vi.fn(),
    }),
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
    getState: () => ({
      addTaskToQueueOrder: vi.fn(),
    }),
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
});

describe('taskStore', () => {
  beforeEach(() => {
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
