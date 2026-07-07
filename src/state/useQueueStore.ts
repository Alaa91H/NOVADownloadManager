/* src/state/useQueueStore.ts */
import React, { useState, useEffect } from 'react';
import { Queue, DownloadItem } from '../types/desktop-ui.types';
import { initialQueues } from '../initialData';
import { createLocalId } from '../utils/idUtils';

const allScheduleDays = [0, 1, 2, 3, 4, 5, 6];

export const normalizeScheduleDays = (days: unknown): number[] => {
  if (!Array.isArray(days)) return allScheduleDays;
  const normalized = days
    .filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)
    .filter((day, index, arr) => arr.indexOf(day) === index)
    .sort();
  return normalized.length > 0 ? normalized : allScheduleDays;
};

export const inferScheduleType = (queue: Partial<Queue>, days: number[]): Queue['scheduleType'] => {
  if (queue.scheduleType === 'once' || queue.scheduleType === 'daily' || queue.scheduleType === 'custom') {
    return queue.scheduleType;
  }
  if (days.length === 7) return 'daily';
  if (days.length === 1 && queue.scheduled) return 'once';
  return 'custom';
};

export const normalizeQueue = (queue: Partial<Queue>, fallback?: Queue): Queue => {
  const base = fallback || initialQueues[0];
  const days = normalizeScheduleDays(queue.days);
  return {
    ...base,
    ...queue,
    id: queue.id || createLocalId('q'),
    name: queue.name || base.name || 'Download List',
    days,
    scheduleType: inferScheduleType(queue, days),
    maxActive: typeof queue.maxActive === 'number' && queue.maxActive > 0 ? queue.maxActive : base.maxActive || 1,
    scheduleCompleted: queue.scheduleCompleted ?? false,
    downloadOrder: Array.isArray(queue.downloadOrder) ? queue.downloadOrder : [],
  };
};

export function useQueueStore(
  tasks: DownloadItem[],
  addToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void,
  setTasks: React.Dispatch<React.SetStateAction<DownloadItem[]>>,
) {
  const [queues, setQueues] = useState<Queue[]>(() => {
    const cached = localStorage.getItem('nova_queues');
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as Partial<Queue>[];
        return parsed.map((queue, index) => normalizeQueue(queue, initialQueues[index]));
      } catch {
        return initialQueues;
      }
    }
    return initialQueues;
  });

  useEffect(() => {
    localStorage.setItem('nova_queues', JSON.stringify(queues));
  }, [queues]);

  const updateQueue = (id: string, updatedQueue: Partial<Queue>, silent?: boolean) => {
    setQueues((prev) =>
      prev.map((q) => {
        if (q.id === id) {
          return { ...q, ...updatedQueue };
        }
        return q;
      }),
    );
    if (!silent) {
      addToast('success', 'Queue Updated', 'Queue settings were saved successfully.');
    }
  };

  const addQueue = (name: string) => {
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
    setQueues((prev) => [...prev, newQueue]);
    addToast('success', 'Queue Created', `Download queue "${name}" was added successfully.`);
  };

  const deleteQueue = (id: string) => {
    if (id === 'main') {
      addToast('error', 'Delete Error', 'The default main queue cannot be deleted.');
      return;
    }
    const targetQueue = queues.find((q) => q.id === id);
    if (!targetQueue) return;

    setQueues((prev) => prev.filter((q) => q.id !== id));
    setTasks((prev) =>
      prev.map((t) => {
        if (t.queueId === id) {
          return { ...t, queueId: 'main' };
        }
        return t;
      }),
    );

    addToast(
      'warning',
      'Queue Deleted',
      `Queue "${targetQueue.name}" was deleted and its files were moved to the main queue.`,
    );
  };

  const removeTaskFromQueue = (taskId: string) => {
    const targetTask = tasks.find((t) => t.id === taskId);
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          return { ...t, queueId: 'main' };
        }
        return t;
      }),
    );
    setQueues((prev) =>
      prev.map((q) => {
        const order = q.downloadOrder.filter((id) => id !== taskId);
        return { ...q, downloadOrder: order };
      }),
    );
    if (targetTask) {
      addToast('info', 'Removed from Queue', `"${targetTask.name}" was moved to the main queue.`);
    }
  };

  const moveTaskToQueue = (taskId: string, targetQueueId: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          return { ...t, queueId: targetQueueId };
        }
        return t;
      }),
    );
    setQueues((prev) =>
      prev.map((q) => {
        let order = q.downloadOrder.filter((id) => id !== taskId);
        if (q.id === targetQueueId) {
          if (!order.includes(taskId)) {
            order = [...order, taskId];
          }
        }
        return { ...q, downloadOrder: order };
      }),
    );
  };

  const addTaskToQueueOrder = (taskId: string, queueId: string) => {
    setQueues((prev) =>
      prev.map((q) => {
        if (q.id !== queueId || q.downloadOrder.includes(taskId)) return q;
        return { ...q, downloadOrder: [...q.downloadOrder, taskId] };
      }),
    );
  };

  const createQueueAndMoveTask = (queueName: string, taskId: string) => {
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
    setQueues((prev) => [...prev, newQueue]);
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === taskId) {
          return { ...t, queueId: newQueueId };
        }
        return t;
      }),
    );
    addToast('success', 'Queue Created', `Queue "${queueName}" was created and the file was moved into it.`);
  };

  return {
    queues,
    updateQueue,
    addQueue,
    deleteQueue,
    removeTaskFromQueue,
    moveTaskToQueue,
    addTaskToQueueOrder,
    createQueueAndMoveTask,
  };
}
