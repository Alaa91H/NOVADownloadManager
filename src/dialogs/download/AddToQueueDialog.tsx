/* src/dialogs/download/AddToQueueDialog.tsx */
import React, { useState } from 'react';
import { ListPlus, Clock, ArrowRightLeft, FolderHeart, Plus } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { TextField, DialogButton } from '../../components/primitives';
import { DownloadItem } from '../../types/desktop-ui.types';

export const AddToQueueDialog: React.FC = () => {
  const {
    dialog,
    closeDialog,
    queues,
    moveTaskToQueue,
    createQueueAndMoveTask,
    addToast,
    t,
  } = useAppStore();

  const task: DownloadItem = dialog.payload;
  const [newQueueName, setNewQueueName] = useState('');

  if (!task) {
    return (
      <div className="text-center p-4">
        <p className="text-red-500 text-xs">No file was selected.</p>
        <DialogButton onClick={closeDialog} variant="secondary" className="mt-2">{t('btn_close')}</DialogButton>
      </div>
    );
  }

  const handleSelectQueue = (queueId: string) => {
    if (task.queueId === queueId) {
      addToast('info', t('toast_info_title'), 'This file is already in that queue.');
      return;
    }
    moveTaskToQueue(task.id, queueId);
    closeDialog();
  };

  const handleCreateAndMove = () => {
    if (!newQueueName.trim()) {
      addToast('error', t('toast_error_title'), 'Enter a queue name first.');
      return;
    }
    createQueueAndMoveTask(newQueueName.trim(), task.id);
    closeDialog();
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 bg-[var(--bg-hover)] p-3 rounded-lg border border-[var(--border-color)]/30">
        <ArrowRightLeft className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-extrabold text-[var(--text-primary)]">Move File to Download Queue</p>
          <p className="text-[var(--text-secondary)] leading-relaxed">
            Choose a queue for this file, or create a new queue and move it there immediately.
          </p>
        </div>
      </div>

      <div>
        <span className="text-xs font-bold text-[var(--text-secondary)] block mb-1">Selected File</span>
        <div className="bg-[var(--bg-input)]/60 text-[var(--text-primary)] px-3 py-2 rounded border border-[var(--border-color)]/30 text-xs font-mono font-bold truncate">
          {task.name}
        </div>
      </div>

      <div className="space-y-2">
        <span className="text-xs font-bold text-[var(--text-secondary)] block mb-1">Available Queues</span>
        <div className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1">
          {queues.map((q) => {
            const isCurrent = task.queueId === q.id;
            return (
              <div
                key={q.id}
                onClick={() => handleSelectQueue(q.id)}
                className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition-all select-none ${
                  isCurrent
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-light)] text-[var(--text-primary)] font-bold'
                    : 'border-[var(--border-color)]/50 hover:border-[var(--accent-primary)]/40 hover:bg-[var(--bg-hover)]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`p-1.5 rounded ${isCurrent ? 'bg-[var(--accent-primary)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'}`}>
                    <FolderHeart className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-extrabold">{q.name}</p>
                    <p className="text-[10px] text-[var(--text-secondary)]">
                      {q.downloadOrder.length} scheduled file(s)
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {q.scheduled && (
                    <span className="flex items-center gap-1 text-[10px] bg-amber-500/10 text-amber-500 font-bold px-1.5 py-0.5 rounded">
                      <Clock className="w-3 h-3" />
                      <span>Scheduled ({q.startTime})</span>
                    </span>
                  )}
                  {isCurrent && (
                    <span className="text-[10px] bg-[var(--accent-primary)] text-white font-extrabold px-1.5 py-0.5 rounded">
                      Current
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="h-px bg-[var(--border-color)]/60 my-2" />

      <div className="space-y-3 p-3 bg-[var(--bg-input)]/30 rounded-lg border border-[var(--border-color)]/20">
        <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-primary)]">
          <ListPlus className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>Create New Queue</span>
        </div>

        <div className="flex gap-2">
          <TextField
            id="new-queue-name"
            placeholder="Work downloads, online courses..."
            value={newQueueName}
            onChange={(e) => setNewQueueName(e.target.value)}
            className="flex-1 text-xs"
          />
          <button
            onClick={handleCreateAndMove}
            className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white font-bold text-xs rounded-md transition-colors flex items-center gap-1 shrink-0 cursor-pointer shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create & Move</span>
          </button>
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <DialogButton onClick={closeDialog} variant="secondary">
          {t('btn_cancel')}
        </DialogButton>
      </div>
    </div>
  );
};
