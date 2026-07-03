/* src/state/useQueueStore.ts */
import React, { useState, useEffect } from 'react';
import { Queue, DownloadItem } from '../types/desktop-ui.types';
import { initialQueues } from '../initialData';

const createLocalId = (prefix: string) => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
};

export function useQueueStore(
  tasks: DownloadItem[],
  addToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, message: string) => void,
  setTasks: React.Dispatch<React.SetStateAction<DownloadItem[]>>
) {
  const [queues, setQueues] = useState<Queue[]>(() => {
    const cached = localStorage.getItem('nova_queues');
    return cached ? JSON.parse(cached) : initialQueues;
  });

  useEffect(() => {
    localStorage.setItem('nova_queues', JSON.stringify(queues));
  }, [queues]);

  const updateQueue = (id: string, updatedQueue: Partial<Queue>, silent?: boolean) => {
    setQueues(prev => prev.map(q => {
      if (q.id === id) {
        return { ...q, ...updatedQueue };
      }
      return q;
    }));
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
      startTime: '02:00',
      endTime: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      limitSpeed: false,
      speedLimitKbs: 1024,
      oneTimeLimit: false,
      shutdownOnComplete: false,
      hangupOnComplete: false,
      retryCount: 3,
      downloadOrder: []
    };
    setQueues(prev => [...prev, newQueue]);
    addToast('success', 'Queue Created', `Download queue "${name}" was added successfully.`);
  };

  const deleteQueue = (id: string) => {
    if (id === 'main') {
      addToast('error', 'Delete Error', 'The default main queue cannot be deleted.');
      return;
    }
    const targetQueue = queues.find(q => q.id === id);
    if (!targetQueue) return;

    setQueues(prev => prev.filter(q => q.id !== id));
    setTasks(prev => prev.map(t => {
      if (t.queueId === id) {
        return { ...t, queueId: 'main' };
      }
      return t;
    }));

    addToast('warning', 'Queue Deleted', `Queue "${targetQueue.name}" was deleted and its files were moved to the main queue.`);
  };

  const removeTaskFromQueue = (taskId: string) => {
    const targetTask = tasks.find(t => t.id === taskId);
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, queueId: 'main' };
      }
      return t;
    }));
    setQueues(prev => prev.map(q => {
      const order = q.downloadOrder.filter(id => id !== taskId);
      return { ...q, downloadOrder: order };
    }));
    if (targetTask) {
      addToast('info', 'Removed from Queue', `"${targetTask.name}" was moved to the main queue.`);
    }
  };

  const moveTaskToQueue = (taskId: string, targetQueueId: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, queueId: targetQueueId };
      }
      return t;
    }));
    setQueues(prev => prev.map(q => {
      let order = q.downloadOrder.filter(id => id !== taskId);
      if (q.id === targetQueueId) {
        if (!order.includes(taskId)) {
          order = [...order, taskId];
        }
      }
      return { ...q, downloadOrder: order };
    }));
  };

  const createQueueAndMoveTask = (queueName: string, taskId: string) => {
    const newQueueId = createLocalId('q');
    const newQueue: Queue = {
      id: newQueueId,
      name: queueName,
      active: false,
      scheduled: false,
      startTime: '02:00',
      endTime: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      limitSpeed: false,
      speedLimitKbs: 1024,
      oneTimeLimit: false,
      shutdownOnComplete: false,
      hangupOnComplete: false,
      retryCount: 3,
      downloadOrder: [taskId]
    };
    setQueues(prev => [...prev, newQueue]);
    setTasks(prev => prev.map(t => {
      if (t.id === taskId) {
        return { ...t, queueId: newQueueId };
      }
      return t;
    }));
    addToast('success', 'Queue Created', `Queue "${queueName}" was created and the file was moved into it.`);
  };

  return {
    queues,
    setQueues,
    updateQueue,
    addQueue,
    deleteQueue,
    removeTaskFromQueue,
    moveTaskToQueue,
    createQueueAndMoveTask
  };
}
