/* src/components/SchedulerPanel.tsx */
import React, { useState } from 'react';
import { Clock, Play, Pause, Plus, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { Button, DialogButton } from './primitives';
import { SchedulerSidebar } from './SchedulerSidebar';
import { SchedulerFilesTab } from './SchedulerFilesTab';
import { SchedulerBasicTab } from './SchedulerBasicTab';
import { SchedulerSpeedTab } from './SchedulerSpeedTab';
import { SchedulerActionsTab } from './SchedulerActionsTab';
import { SchedulerRetriesTab } from './SchedulerRetriesTab';

type TabId = 'files' | 'basic' | 'speed' | 'actions' | 'retries';

export const SchedulerPanel: React.FC = () => {
  const { 
    tasks, 
    queues, 
    updateQueue, 
    resumeTask, 
    pauseTask, 
    addToast, 
    addQueue, 
    deleteQueue, 
    removeTaskFromQueue,
    closeDialog,
    t
  } = useAppStore();
  
  const [selectedQueueId, setSelectedQueueId] = useState<string>('main');
  const [prevQueuesCount, setPrevQueuesCount] = useState(queues.length);
  const [queueToDeleteId, setQueueToDeleteId] = React.useState<string | null>(null);
  const [taskToRemoveId, setTaskToRemoveId] = React.useState<string | null>(null);

  // Select a newly added queue, adjusting state during render instead of in an effect.
  if (queues.length !== prevQueuesCount) {
    if (queues.length > prevQueuesCount) {
      const lastQueue = queues[queues.length - 1];
      if (lastQueue) {
        setSelectedQueueId(lastQueue.id);
      }
    }
    setPrevQueuesCount(queues.length);
  }
  const selectedQueue = queues.find(q => q.id === selectedQueueId) || queues[0];

  const [name, setName] = useState(selectedQueue?.name || 'Main Download Queue');
  const [startTime, setStartTime] = useState(selectedQueue?.startTime || '02:00');
  const [endTime, setEndTime] = useState(selectedQueue?.endTime || '08:00');
  const [days, setDays] = useState<number[]>(selectedQueue?.days || [1, 2, 3, 4, 5]);
  const [isScheduled, setIsScheduled] = useState<boolean>(selectedQueue?.scheduled || false);
  const [maxActive, setMaxActive] = useState<number>(1);
  const [limitSpeed, setLimitSpeed] = useState<boolean>(selectedQueue?.limitSpeed || false);
  const [speedLimitKbs, setSpeedLimitKbs] = useState<number>(selectedQueue?.speedLimitKbs || 2048);
  const [oneTimeLimit, setOneTimeLimit] = useState<boolean>(selectedQueue?.oneTimeLimit || false);
  const [shutdownOnComplete, setShutdownOnComplete] = useState<boolean>(selectedQueue?.shutdownOnComplete || false);
  const [hangupOnComplete, setHangupOnComplete] = useState<boolean>(selectedQueue?.hangupOnComplete || false);
  const [retryCount, setRetryCount] = useState<number>(selectedQueue?.retryCount || 10);
  const [exitOnComplete, setExitOnComplete] = useState<boolean>(false);
  const [playChime, setPlayChime] = useState<boolean>(true);
  const [enableWebhook, setEnableWebhook] = useState<boolean>(false);
  const [webhookUrl, setWebhookUrl] = useState<string>('https://api.my-server.com/dl-webhook');
  const [retryDelay, setRetryDelay] = useState<number>(10);
  const [smartScheduleType, setSmartScheduleType] = useState<'once' | 'daily' | 'weekly'>('daily');

  const [activeTab, setActiveTab] = useState<TabId>('files');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Load the form when switching queues, adjusting state during render.
  // The auto-save effect below then fires once with the freshly synced values,
  // which is an idempotent write back to the same queue.
  const [prevSelectedQueueId, setPrevSelectedQueueId] = useState(selectedQueueId);
  if (prevSelectedQueueId !== selectedQueueId && selectedQueue) {
    setPrevSelectedQueueId(selectedQueueId);
    setName(selectedQueue.name);
    setStartTime(selectedQueue.startTime || '02:00');
    setEndTime(selectedQueue.endTime || '08:00');
    setDays(selectedQueue.days || [1, 2, 3, 4, 5]);
    setMaxActive(1);
    setIsScheduled(selectedQueue.scheduled || false);
    setLimitSpeed(selectedQueue.limitSpeed || false);
    setSpeedLimitKbs(selectedQueue.speedLimitKbs || 2048);
    setOneTimeLimit(selectedQueue.oneTimeLimit || false);
    setShutdownOnComplete(selectedQueue.shutdownOnComplete || false);
    setHangupOnComplete(selectedQueue.hangupOnComplete || false);
    setRetryCount(selectedQueue.retryCount || 10);
  }

  React.useEffect(() => {
    updateQueue(selectedQueueId, {
      name, scheduled: isScheduled, startTime, endTime, days,
      limitSpeed, speedLimitKbs, oneTimeLimit,
      shutdownOnComplete, hangupOnComplete, retryCount
    }, true);
  }, [name, isScheduled, startTime, endTime, days, limitSpeed, speedLimitKbs, oneTimeLimit, shutdownOnComplete, hangupOnComplete, retryCount, selectedQueueId]);

  const queueTasks = tasks.filter(t => t.queueId === selectedQueueId);
  const orderedQueueTasks = [...queueTasks].sort((a, b) => {
    const indexA = selectedQueue.downloadOrder?.indexOf(a.id) ?? -1;
    const indexB = selectedQueue.downloadOrder?.indexOf(b.id) ?? -1;
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  const filteredTasks = orderedQueueTasks.filter(t => 
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    t.url.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const toggleDay = (dayNum: number) => {
    if (days.includes(dayNum)) {
      setDays(days.filter(d => d !== dayNum));
    } else {
      setDays([...days, dayNum].sort());
    }
  };

  const handleSaveSettings = () => {
    updateQueue(selectedQueueId, {
      name, scheduled: isScheduled, startTime, endTime, days,
      limitSpeed, speedLimitKbs, oneTimeLimit,
      shutdownOnComplete, hangupOnComplete, retryCount
    });
    addToast('success', 'Download Queue Updated', `Queue [${name}] settings were saved.`);
  };

  const handleStartQueue = () => {
    const queuedAndPaused = queueTasks.filter(t => t.status === 'queued' || t.status === 'paused');
    const toStart = queuedAndPaused.slice(0, maxActive);
    if (toStart.length === 0) {
      addToast('info', 'Start Queue', 'No paused or queued downloads are available in this queue.');
      return;
    }
    toStart.forEach(t => resumeTask(t.id));
    addToast('success', 'Queue Started', `Queue [${name}] was activated.`);
  };

  const handleStopQueue = () => {
    const activeTasks = queueTasks.filter(t => t.status === 'downloading');
    if (activeTasks.length === 0) {
      addToast('info', 'Pause Queue', 'No active downloads are running in this queue.');
      return;
    }
    activeTasks.forEach(t => pauseTask(t.id));
    addToast('warning', 'Queue Paused', `Queue [${name}] downloads were paused.`);
  };

  const handleMoveUp = (taskId: string) => {
    const currentOrder = orderedQueueTasks.map(t => t.id);
    const index = currentOrder.indexOf(taskId);
    if (index > 0) {
      const newOrder = [...currentOrder];
      const temp = newOrder[index];
      newOrder[index] = newOrder[index - 1];
      newOrder[index - 1] = temp;
      updateQueue(selectedQueueId, { downloadOrder: newOrder });
      addToast('success', 'Download Priority', 'File moved up in the queue.');
    }
  };

  const handleMoveDown = (taskId: string) => {
    const currentOrder = orderedQueueTasks.map(t => t.id);
    const index = currentOrder.indexOf(taskId);
    if (index !== -1 && index < currentOrder.length - 1) {
      const newOrder = [...currentOrder];
      const temp = newOrder[index];
      newOrder[index] = newOrder[index + 1];
      newOrder[index + 1] = temp;
      updateQueue(selectedQueueId, { downloadOrder: newOrder });
      addToast('success', 'Download Priority', 'File moved down in the queue.');
    }
  };

  const [newQueueName, setNewQueueName] = useState('');
  const handleCreateQueue = () => {
    if (!newQueueName.trim()) return;
    addQueue(newQueueName);
    setNewQueueName('');
  };

  return (
    <div className={`flex flex-col h-[75vh] min-h-[550px] max-h-[700px] ${'text-left'}`} dir={'ltr'}>
      {/* 1. TOP HEADER SECTION */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4 gap-3">
        <div className="space-y-0.5">
          <h2 className="text-base font-extrabold text-slate-100 flex items-center gap-2">
            <Clock className="w-5 h-5 text-amber-500" />
            {t('sched_title')}
          </h2>
          <p className="text-[11px] text-[var(--text-secondary)]">
            {t('sched_desc')}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
          <div className="flex items-center gap-2">
            <label className="text-xs font-bold text-[var(--text-secondary)] whitespace-nowrap">{t('sched_select_queue')}</label>
            <div className="flex items-center gap-1.5">
              <select 
                value={selectedQueueId} 
                onChange={(e) => setSelectedQueueId(e.target.value)}
                className="bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] focus:border-[var(--accent-primary)] rounded-md px-2 py-1 text-[11px] font-semibold focus:outline-none text-slate-200 cursor-pointer h-7"
              >
                {queues.map(q => (
                  <option key={q.id} value={q.id}>{q.name}</option>
                ))}
              </select>
              {selectedQueueId !== 'main' && (
                <>
                  {queueToDeleteId === selectedQueueId ? (
                    <div className="flex items-center gap-1 bg-rose-500/10 border border-rose-500/30 p-1 rounded-lg">
                      <span className="text-[10px] font-bold text-rose-400 px-1">{"Confirm?"}</span>
                      <button type="button" onClick={() => { deleteQueue(selectedQueueId); setSelectedQueueId('main'); setQueueToDeleteId(null); }}
                        className="px-2 py-0.5 bg-rose-500 hover:bg-rose-600 text-white rounded text-[10px] font-bold cursor-pointer">{"Delete"}</button>
                      <button type="button" onClick={() => setQueueToDeleteId(null)}
                        className="px-2 py-0.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-[var(--text-primary)] rounded text-[10px] font-bold cursor-pointer">{"Cancel"}</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setQueueToDeleteId(selectedQueueId)}
                      className="p-1 hover:bg-red-500/20 text-red-500 border border-red-500/30 rounded-md cursor-pointer flex items-center justify-center shrink-0 h-7 w-7"
                      title={"Delete this list permanently"}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <input type="text" placeholder={t('sched_new_name')} value={newQueueName}
              onChange={(e) => setNewQueueName(e.target.value)}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] focus:border-[var(--accent-primary)] rounded-md px-2 py-1 text-[11px] text-[var(--text-primary)] focus:outline-none focus:ring-0 font-semibold w-24 sm:w-28 transition-all h-7"
            />
            <button onClick={handleCreateQueue} type="button" title={t('sched_create_btn')}
              className="flex items-center justify-center gap-1 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white border border-[var(--accent-border)] rounded-md px-2 py-1 h-7 text-[11px] font-semibold transition-all shrink-0 cursor-pointer shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{'Add'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. SIDEBAR + CONTENT */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden gap-4" dir="ltr">
        <SchedulerSidebar activeTab={activeTab} onChange={setActiveTab} fileCount={filteredTasks.length} />

        <div className="flex-1 overflow-y-auto pr-1 pl-1 scrollbar-thin flex flex-col min-h-0" dir={'ltr'}>
          {activeTab === 'files' && (
            <SchedulerFilesTab
              filteredTasks={filteredTasks}
              name={name}
              isScheduled={isScheduled}
              startTime={startTime}
              endTime={endTime}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              taskToRemoveId={taskToRemoveId}
              onRemoveRequest={setTaskToRemoveId}
              onRemoveConfirm={(id) => { removeTaskFromQueue(id); setTaskToRemoveId(null); }}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
            />
          )}

          {activeTab !== 'files' && (
            <div className="flex-1 flex flex-col justify-between min-h-0">
              <div className="max-w-2xl mx-auto w-full space-y-4 overflow-y-auto pr-1 pl-1 flex-1 pb-4">
                {activeTab === 'basic' && (
                  <SchedulerBasicTab
                    name={name} onNameChange={setName}
                    smartScheduleType={smartScheduleType} onScheduleTypeChange={setSmartScheduleType}
                    isScheduled={isScheduled} onScheduledChange={setIsScheduled}
                    startTime={startTime} onStartTimeChange={setStartTime}
                    endTime={endTime} onEndTimeChange={setEndTime}
                    days={days} onToggleDay={toggleDay}
                    maxActive={maxActive} onMaxActiveChange={setMaxActive}
                  />
                )}
                {activeTab === 'speed' && (
                  <SchedulerSpeedTab
                    limitSpeed={limitSpeed} onLimitSpeedChange={setLimitSpeed}
                    speedLimitKbs={speedLimitKbs} onSpeedLimitChange={setSpeedLimitKbs}
                    oneTimeLimit={oneTimeLimit} onOneTimeLimitChange={setOneTimeLimit}
                  />
                )}
                {activeTab === 'actions' && (
                  <SchedulerActionsTab
                    shutdownOnComplete={shutdownOnComplete} onShutdownChange={setShutdownOnComplete}
                    hangupOnComplete={hangupOnComplete} onHangupChange={setHangupOnComplete}
                    exitOnComplete={exitOnComplete} onExitChange={setExitOnComplete}
                    playChime={playChime} onChimeChange={setPlayChime}
                    enableWebhook={enableWebhook} onWebhookEnableChange={setEnableWebhook}
                    webhookUrl={webhookUrl} onWebhookUrlChange={setWebhookUrl}
                  />
                )}
                {activeTab === 'retries' && (
                  <SchedulerRetriesTab
                    retryCount={retryCount} onRetryCountChange={setRetryCount}
                    retryDelay={retryDelay} onRetryDelayChange={setRetryDelay}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 3. MULTI-ACTION CONTROLS FOOTER */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between border-t border-[var(--border-color)] pt-3 mt-4 shrink-0">
        <div className="flex gap-2">
          {activeTab === 'files' ? (
            <div className="text-[10px] text-[var(--text-muted)] font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
              <span>{t('sched_num_files', { count: filteredTasks.length })}</span>
            </div>
          ) : (
            <div className="text-[10px] text-[var(--text-muted)] font-semibold flex items-center gap-1.5 leading-normal">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>{'Timers and speed scheduler run in the background.'}</span>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          {activeTab === 'files' ? (
            <>
              <Button type="button" onClick={handleStopQueue} variant="secondary" size="md" icon={Pause}>
                {t('sched_stop_queue')}
              </Button>
              <Button type="button" onClick={handleStartQueue} variant="primary" size="md" icon={Play}>
                {t('sched_start_queue')}
              </Button>
              <DialogButton onClick={closeDialog} variant="secondary" size="md">{'Close'}</DialogButton>
            </>
          ) : (
            <DialogButton onClick={closeDialog} variant="primary" size="md">{'Close'}</DialogButton>
          )}
        </div>
      </div>
    </div>
  );
};
