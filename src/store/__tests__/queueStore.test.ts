import { describe, it, expect, beforeEach, vi } from 'vitest';
import { queueStore } from '../queueStore';

vi.mock('../../utils/sound', () => ({ playAppSound: vi.fn() }));

describe('queueStore', () => {
  beforeEach(() => {
    queueStore.setState({
      queues: [
        {
          id: 'main',
          name: 'Main Queue',
          active: false,
          scheduled: false,
          scheduleType: 'daily',
          maxActive: 3,
          scheduleCompleted: false,
          startTime: '02:00',
          endTime: '08:00',
          days: [0, 1, 2, 3, 4, 5, 6],
          limitSpeed: false,
          speedLimitKbs: 1024,
          oneTimeLimit: false,
          shutdownOnComplete: false,
          hangupOnComplete: false,
          retryCount: 3,
          downloadOrder: ['task1', 'task2'],
        },
        {
          id: 'q2',
          name: 'Night Queue',
          active: true,
          scheduled: true,
          scheduleType: 'daily',
          maxActive: 1,
          scheduleCompleted: false,
          startTime: '22:00',
          endTime: '06:00',
          days: [0, 1, 2, 3, 4, 5, 6],
          limitSpeed: true,
          speedLimitKbs: 512,
          oneTimeLimit: false,
          shutdownOnComplete: false,
          hangupOnComplete: false,
          retryCount: 3,
          downloadOrder: ['task3'],
        },
      ],
      _undoStack: [],
    });
  });

  it('has initial queues from state', () => {
    expect(queueStore.getState().queues).toHaveLength(2);
    expect(queueStore.getState().queues[0].id).toBe('main');
  });

  it('addQueue creates a new queue with correct defaults', () => {
    const before = queueStore.getState().queues.length;
    queueStore.getState().addQueue('My Queue');
    const queues = queueStore.getState().queues;
    expect(queues).toHaveLength(before + 1);
    const added = queues[queues.length - 1];
    expect(added.name).toBe('My Queue');
    expect(added.maxActive).toBe(1);
    expect(added.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(added.id).toMatch(/^q-/);
  });

  it('deleteQueue removes non-main queue', () => {
    queueStore.getState().deleteQueue('q2');
    expect(queueStore.getState().queues.find((q) => q.id === 'q2')).toBeUndefined();
  });

  it('deleteQueue rejects main queue', () => {
    queueStore.getState().deleteQueue('main');
    expect(queueStore.getState().queues.find((q) => q.id === 'main')).toBeDefined();
  });

  it('deleteQueue no-ops on nonexistent id', () => {
    const before = queueStore.getState().queues.length;
    queueStore.getState().deleteQueue('nonexistent');
    expect(queueStore.getState().queues).toHaveLength(before);
  });

  it('updateQueue merges partial updates', () => {
    queueStore.getState().updateQueue('main', { name: 'Renamed', maxActive: 5 }, true);
    const main = queueStore.getState().queues.find((q) => q.id === 'main');
    expect(main).toBeDefined();
    if (!main) return;
    expect(main.name).toBe('Renamed');
    expect(main.maxActive).toBe(5);
    expect(main.downloadOrder).toEqual(['task1', 'task2']);
  });

  it('updateQueue with silent=true does not trigger toast (no crash)', () => {
    expect(() => {
      queueStore.getState().updateQueue('main', { name: 'X' }, true);
    }).not.toThrow();
  });

  it('removeTaskFromQueue removes task from all queues', () => {
    queueStore.getState().removeTaskFromQueue('task1');
    const main = queueStore.getState().queues.find((q) => q.id === 'main');
    expect(main).toBeDefined();
    if (!main) return;
    expect(main.downloadOrder).toEqual(['task2']);
    const q2 = queueStore.getState().queues.find((q) => q.id === 'q2');
    expect(q2).toBeDefined();
    if (!q2) return;
    expect(q2.downloadOrder).toEqual(['task3']);
  });

  it('moveTaskToQueue moves task between queues', () => {
    queueStore.getState().moveTaskToQueue('task1', 'q2');
    const main = queueStore.getState().queues.find((q) => q.id === 'main');
    expect(main).toBeDefined();
    if (!main) return;
    expect(main.downloadOrder).toEqual(['task2']);
    const q2 = queueStore.getState().queues.find((q) => q.id === 'q2');
    expect(q2).toBeDefined();
    if (!q2) return;
    expect(q2.downloadOrder).toContain('task1');
  });

  it('moveTaskToQueue does not duplicate in target', () => {
    queueStore.getState().moveTaskToQueue('task3', 'q2');
    const q2 = queueStore.getState().queues.find((q) => q.id === 'q2');
    expect(q2).toBeDefined();
    if (!q2) return;
    expect(q2.downloadOrder.filter((id) => id === 'task3')).toHaveLength(1);
  });

  it('addTaskToQueueOrder appends task to queue', () => {
    queueStore.getState().addTaskToQueueOrder('task_new', 'q2');
    const q2 = queueStore.getState().queues.find((q) => q.id === 'q2');
    expect(q2).toBeDefined();
    if (!q2) return;
    expect(q2.downloadOrder).toContain('task_new');
  });

  it('addTaskToQueueOrder does not duplicate', () => {
    queueStore.getState().addTaskToQueueOrder('task3', 'q2');
    const q2 = queueStore.getState().queues.find((q) => q.id === 'q2');
    expect(q2).toBeDefined();
    if (!q2) return;
    expect(q2.downloadOrder.filter((id) => id === 'task3')).toHaveLength(1);
  });

  it('addTaskToQueueOrder ignores nonexistent queue', () => {
    queueStore.getState().addTaskToQueueOrder('task_new', 'nonexistent');
    const q2 = queueStore.getState().queues.find((q) => q.id === 'q2');
    expect(q2).toBeDefined();
    if (!q2) return;
    expect(q2.downloadOrder).not.toContain('task_new');
  });

  it('createQueueAndMoveTask creates queue and adds task', () => {
    const before = queueStore.getState().queues.length;
    queueStore.getState().createQueueAndMoveTask('New Q', 'task1');
    expect(queueStore.getState().queues).toHaveLength(before + 1);
    const newQ = queueStore.getState().queues[queueStore.getState().queues.length - 1];
    expect(newQ.name).toBe('New Q');
    expect(newQ.downloadOrder).toContain('task1');
  });

  it('reorderQueues moves queue from one index to another', () => {
    queueStore.getState().reorderQueues(0, 1);
    expect(queueStore.getState().queues[0].id).toBe('q2');
    expect(queueStore.getState().queues[1].id).toBe('main');
  });

  describe('undo', () => {
    it('snapshotForUndo and undoLast restores previous state', () => {
      queueStore.getState().snapshotForUndo();
      queueStore.getState().deleteQueue('q2');
      expect(queueStore.getState().queues).toHaveLength(1);
      queueStore.getState().undoLast();
      expect(queueStore.getState().queues).toHaveLength(2);
    });

    it('undoLast is no-op when stack is empty', () => {
      const before = JSON.stringify(queueStore.getState().queues);
      queueStore.getState().undoLast();
      expect(JSON.stringify(queueStore.getState().queues)).toBe(before);
    });

    it('undoStack is capped at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        queueStore.getState().snapshotForUndo();
      }
      expect(queueStore.getState()._undoStack.length).toBe(20);
    });
  });
});
