import { create } from 'zustand';
import type { Queue, DownloadItem } from '../types/desktop-ui.types';
import { initialQueues } from '../initialData';
import { createLocalId } from '../utils/idUtils';
import { uiStore } from './uiStore';

const allScheduleDays = [0, 1, 2, 3, 4, 5, 6];
const normalizeScheduleDays = (days: unknown): number[] => {
  if (!Array.isArray(days)) return allScheduleDays;
  const valid = days.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6);
  const unique = valid.filter((d, i, arr) => arr.indexOf(d) === i).sort((a, b) => a - b);
  return unique.length > 0 ? unique : allScheduleDays;
};
const inferScheduleType = (q: Partial<Queue>, days: number[]): Queue['scheduleType'] => {
  if (q.scheduleType === 'once' || q.scheduleType === 'daily' || q.scheduleType === 'custom') return q.scheduleType;
  if (days.length === 7) return 'daily';
  if (days.length === 1 && q.scheduled) return 'once';
  return 'custom';
};
const normalizeQueue = (q: Partial<Queue>, fallback?: Queue): Queue => {
  const base = fallback || initialQueues[0];
  const days = normalizeScheduleDays(q.days);
  return {
    ...base,
    ...q,
    id: q.id || createLocalId('q'),
    name: q.name || base.name || 'Download List',
    days,
    scheduleType: inferScheduleType(q, days),
    maxActive: typeof q.maxActive === 'number' && q.maxActive > 0 ? q.maxActive : base.maxActive || 1,
    scheduleCompleted: q.scheduleCompleted ?? false,
    downloadOrder: Array.isArray(q.downloadOrder) ? q.downloadOrder : [],
  };
};

const initQueues = (): Queue[] => {
  const cached = localStorage.getItem('nova_queues');
  if (cached) {
    try {
      return (JSON.parse(cached) as Partial<Queue>[]).map((q, i) => normalizeQueue(q, initialQueues[i]));
    } catch {
      /* fall through */
    }
  }
  return initialQueues;
};

interface QueueState {
  queues: Queue[];
  _undoStack: { queues: Queue[]; tasks: DownloadItem[] }[];
  updateQueue: (id: string, updated: Partial<Queue>, silent?: boolean) => void;
  addQueue: (name: string) => void;
  deleteQueue: (id: string) => void;
  removeTaskFromQueue: (taskId: string) => void;
  moveTaskToQueue: (taskId: string, targetQueueId: string) => void;
  addTaskToQueueOrder: (taskId: string, queueId: string) => void;
  createQueueAndMoveTask: (queueName: string, taskId: string) => void;
  reorderQueues: (fromIndex: number, toIndex: number) => void;
  snapshotForUndo: () => void;
  undoLast: () => void;
  _setQueues: (q: Queue[]) => void;
}

export const queueStore = create<QueueState>()((set, get) => ({
  queues: initQueues(),
  _undoStack: [],

  _setQueues: (q) => {
    set({ queues: q });
  },

  updateQueue: (id, updated, silent = false) => {
    set((p) => ({ queues: p.queues.map((q) => (q.id === id ? { ...q, ...updated } : q)) }));
    if (!silent) uiStore.getState().addToast('success', 'Queue Updated', 'Queue settings were saved successfully.');
  },

  addQueue: (name) => {
    const id = createLocalId('q');
    const newQueue: Queue = {
      id,
      name,
      active: false,
      scheduled: false,
      scheduleType: 'daily',
      maxActive: 1,
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
      downloadOrder: [],
    };
    set((p) => ({ queues: [...p.queues, newQueue] }));
    uiStore.getState().addToast('success', 'Queue Created', `Download queue "${name}" was added successfully.`);
  },

  deleteQueue: (id) => {
    if (id === 'main') {
      uiStore.getState().addToast('error', 'Delete Error', 'The default main queue cannot be deleted.');
      return;
    }
    const tq = get().queues.find((q) => q.id === id);
    if (!tq) return;
    set((p) => ({
      queues: p.queues
        .filter((q) => q.id !== id)
        // Reassign orphaned tasks (from the deleted queue's order) to the main queue.
        .map((q) =>
          q.id === 'main'
            ? {
                ...q,
                downloadOrder: [
                  ...q.downloadOrder,
                  ...tq.downloadOrder.filter((tid) => !q.downloadOrder.includes(tid)),
                ],
              }
            : q,
        ),
    }));
    uiStore
      .getState()
      .addToast(
        'warning',
        'Queue Deleted',
        `Queue "${tq.name}" was deleted and its ${String(tq.downloadOrder.length)} file(s) were moved to the main queue.`,
      );
  },

  removeTaskFromQueue: (taskId) => {
    set((p) => ({
      queues: p.queues.map((q) => ({ ...q, downloadOrder: q.downloadOrder.filter((id) => id !== taskId) })),
    }));
  },

  moveTaskToQueue: (taskId, targetQueueId) => {
    set((p) => ({
      queues: p.queues.map((q) => {
        let order = q.downloadOrder.filter((id) => id !== taskId);
        if (q.id === targetQueueId && !order.includes(taskId)) order = [...order, taskId];
        return { ...q, downloadOrder: order };
      }),
    }));
  },

  addTaskToQueueOrder: (taskId, queueId) => {
    set((p) => ({
      queues: p.queues.map((q) => {
        if (q.id !== queueId || q.downloadOrder.includes(taskId)) return q;
        return { ...q, downloadOrder: [...q.downloadOrder, taskId] };
      }),
    }));
  },

  createQueueAndMoveTask: (queueName, taskId) => {
    const newQueueId = createLocalId('q');
    const newQueue: Queue = {
      id: newQueueId,
      name: queueName,
      active: false,
      scheduled: false,
      scheduleType: 'daily',
      maxActive: 1,
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
      downloadOrder: [taskId],
    };
    set((p) => ({ queues: [...p.queues, newQueue] }));
    uiStore
      .getState()
      .addToast('success', 'Queue Created', `Queue "${queueName}" was created and the file was moved into it.`);
  },

  reorderQueues: (fromIndex, toIndex) => {
    set((p) => {
      if (fromIndex < 0 || fromIndex >= p.queues.length || toIndex < 0 || toIndex >= p.queues.length) {
        return p;
      }
      const n = [...p.queues];
      const [m] = n.splice(fromIndex, 1);
      n.splice(toIndex, 0, m);
      return { queues: n };
    });
  },

  snapshotForUndo: () => {
    const { queues } = get();
    set({
      _undoStack: [
        ...get()._undoStack.slice(-19),
        { queues: JSON.parse(JSON.stringify(queues)) as Queue[], tasks: [] },
      ],
    });
  },

  undoLast: () => {
    const stack = [...get()._undoStack];
    const snap = stack.pop();
    if (snap) {
      set({ queues: snap.queues, _undoStack: stack });
    }
  },
}));
