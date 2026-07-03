/* src/components/SchedulerPanel.tsx */
import React, { useState } from 'react';
import { 
  Clock, Play, Pause, ArrowUp, ArrowDown, Settings, Save, AlertCircle, Plus, Trash2, 
  Calendar, ShieldAlert, Sliders, Bell, Server, Shield, Volume2, Globe, Search, RefreshCw, CheckCircle2, Folder
} from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { Queue, DownloadItem } from '../types/desktop-ui.types';
import { Button, DialogButton } from './primitives';
import { SpeedLimitInput } from './SpeedLimitInput';

// Parse a 24-hour string (e.g. "14:35") into { hour12: number, minute: number, ampm: 'AM' | 'PM' }
const parseTimeTo12Hour = (timeStr: string) => {
  if (!timeStr) return { hour12: 12, minute: 0, ampm: 'AM' as const };
  const [hour24, min] = timeStr.split(':').map(Number);
  const ampm: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute: min || 0, ampm };
};

// Format { hour12, minute, ampm } back into 24-hour string (e.g. "14:35")
const formatTimeTo24Hour = (hour12: number, minute: number, ampm: 'AM' | 'PM') => {
  let hour24 = hour12;
  if (ampm === 'PM' && hour12 < 12) hour24 += 12;
  if (ampm === 'AM' && hour12 === 12) hour24 = 0;
  const hourStr = String(hour24).padStart(2, '0');
  const minStr = String(minute).padStart(2, '0');
  return `${hourStr}:${minStr}`;
};

interface TimePickerProps {
  label: string;
  value: string; // "HH:MM"
  onChange: (newValue: string) => void;
}

const TimePicker: React.FC<TimePickerProps> = ({ label, value, onChange }) => {
  const { hour12, minute, ampm } = parseTimeTo12Hour(value);

  const handleHourChange = (newHour: number) => {
    onChange(formatTimeTo24Hour(newHour, minute, ampm));
  };

  const handleMinuteChange = (newMin: number) => {
    onChange(formatTimeTo24Hour(hour12, newMin, ampm));
  };

  const handleAmpmChange = (newAmpm: 'AM' | 'PM') => {
    onChange(formatTimeTo24Hour(hour12, minute, newAmpm));
  };

  return (
    <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)]/50 rounded-xl p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-extrabold text-[var(--text-secondary)]">{label}</span>
        <span className="text-xs font-mono font-bold text-[var(--accent-primary)] flex items-center gap-1" dir="ltr">
          <span dir="ltr">{String(hour12).padStart(2, '0')}:{String(minute).padStart(2, '0')}</span>
          <span className="text-[10px] font-bold">{ampm}</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Hour Dropdown */}
        <div className="flex-1 flex flex-col gap-1">
          <span className="text-[9px] text-[var(--text-muted)] font-bold">Hour</span>
          <select
            value={hour12}
            onChange={(e) => handleHourChange(Number(e.target.value))}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-6 pr-2.5 py-1.5 text-xs font-bold text-[var(--text-primary)] focus:outline-none cursor-pointer"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map(h => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>

        {/* Minute Dropdown */}
        <div className="flex-1 flex flex-col gap-1">
          <span className="text-[9px] text-[var(--text-muted)] font-bold">Minute</span>
          <select
            value={minute}
            onChange={(e) => handleMinuteChange(Number(e.target.value))}
            className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-6 pr-2.5 py-1.5 text-xs font-bold text-[var(--text-primary)] focus:outline-none cursor-pointer"
          >
            {Array.from({ length: 60 }, (_, i) => i).map(m => (
              <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
            ))}
          </select>
        </div>

        {/* AM/PM toggle */}
        <div className="flex flex-col gap-1 shrink-0">
          <span className="text-[9px] text-[var(--text-muted)] font-bold text-center">Period</span>
          <div className="flex rounded-lg border border-[var(--border-color)] overflow-hidden bg-[var(--bg-input)] p-0.5">
            <button
              type="button"
              onClick={() => handleAmpmChange('AM')}
              className={`px-3 py-1 text-[10px] font-bold rounded-md cursor-pointer ${
                ampm === 'AM'
                  ? 'text-white font-extrabold bg-transparent'
                  : 'text-[var(--text-muted)] hover:text-white bg-transparent'
              }`}
            >
              AM
            </button>
            <button
              type="button"
              onClick={() => handleAmpmChange('PM')}
              className={`px-3 py-1 text-[10px] font-bold rounded-md cursor-pointer ${
                ampm === 'PM'
                  ? 'text-white font-extrabold bg-transparent'
                  : 'text-[var(--text-muted)] hover:text-white bg-transparent'
              }`}
            >
              PM
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

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

  React.useEffect(() => {
    if (queues.length > prevQueuesCount) {
      const lastQueue = queues[queues.length - 1];
      if (lastQueue) {
        setSelectedQueueId(lastQueue.id);
      }
    }
    setPrevQueuesCount(queues.length);
  }, [queues.length, prevQueuesCount]);
  const selectedQueue = queues.find(q => q.id === selectedQueueId) || queues[0];

  // Local form state for editing queue settings
  const [name, setName] = useState(selectedQueue?.name || 'Main Download Queue');
  const [startTime, setStartTime] = useState(selectedQueue?.startTime || (selectedQueue as any)?.schedule?.startTime || '02:00');
  const [endTime, setEndTime] = useState(selectedQueue?.endTime || (selectedQueue as any)?.schedule?.endTime || '08:00');
  const [days, setDays] = useState<number[]>(selectedQueue?.days || (selectedQueue as any)?.schedule?.daysOfWeek || [1, 2, 3, 4, 5]);
  const [isScheduled, setIsScheduled] = useState<boolean>(selectedQueue?.scheduled || (selectedQueue as any)?.schedule?.enabled || false);
  
  // Advanced customization state matching professional download managers
  const [maxActive, setMaxActive] = useState<number>(selectedQueue?.maxConcurrentDownloads || 1);
  const [limitSpeed, setLimitSpeed] = useState<boolean>(selectedQueue?.limitSpeed || false);
  const [speedLimitKbs, setSpeedLimitKbs] = useState<number>(selectedQueue?.speedLimitKbs || 2048);
  const [oneTimeLimit, setOneTimeLimit] = useState<boolean>(selectedQueue?.oneTimeLimit || false);
  const [shutdownOnComplete, setShutdownOnComplete] = useState<boolean>(selectedQueue?.shutdownOnComplete || false);
  const [hangupOnComplete, setHangupOnComplete] = useState<boolean>(selectedQueue?.hangupOnComplete || false);
  const [retryCount, setRetryCount] = useState<number>(selectedQueue?.retryCount || 10);
  
  // Custom world-class features
  const [exitOnComplete, setExitOnComplete] = useState<boolean>(false);
  const [playChime, setPlayChime] = useState<boolean>(true);
  const [enableWebhook, setEnableWebhook] = useState<boolean>(false);
  const [webhookUrl, setWebhookUrl] = useState<string>('https://api.my-server.com/dl-webhook');
  const [retryDelay, setRetryDelay] = useState<number>(10);
  const [smartScheduleType, setSmartScheduleType] = useState<'once' | 'daily' | 'weekly'>('daily');

  // Sidebar Tabs for grouping options
  const [activeTab, setActiveTab] = useState<'files' | 'basic' | 'speed' | 'actions' | 'retries'>('files');
  
  // Search state inside tasks lists
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Track if we are syncing so we don't save back immediately
  const isSyncing = React.useRef(false);

  // Sync state when selecting different queue
  React.useEffect(() => {
    if (selectedQueue) {
      isSyncing.current = true;
      setName(selectedQueue.name);
      setStartTime(selectedQueue.startTime || (selectedQueue as any)?.schedule?.startTime || '02:00');
      setEndTime(selectedQueue.endTime || (selectedQueue as any)?.schedule?.endTime || '08:00');
      setDays(selectedQueue.days || (selectedQueue as any)?.schedule?.daysOfWeek || [1, 2, 3, 4, 5]);
      setMaxActive(selectedQueue.maxConcurrentDownloads || 1);
      setIsScheduled(selectedQueue.scheduled || (selectedQueue as any)?.schedule?.enabled || false);
      
      setLimitSpeed(selectedQueue.limitSpeed || false);
      setSpeedLimitKbs(selectedQueue.speedLimitKbs || 2048);
      setOneTimeLimit(selectedQueue.oneTimeLimit || false);
      setShutdownOnComplete(selectedQueue.shutdownOnComplete || false);
      setHangupOnComplete(selectedQueue.hangupOnComplete || false);
      setRetryCount(selectedQueue.retryCount || 10);
      
      const timer = setTimeout(() => {
        isSyncing.current = false;
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [selectedQueueId, selectedQueue]);

  // Save settings silently and instantly to the global store on any change
  React.useEffect(() => {
    if (isSyncing.current) return;
    
    updateQueue(selectedQueueId, {
      name,
      scheduled: isScheduled,
      startTime,
      endTime,
      days,
      limitSpeed,
      speedLimitKbs,
      oneTimeLimit,
      shutdownOnComplete,
      hangupOnComplete,
      retryCount,
      schedule: {
        enabled: isScheduled,
        startTime,
        endTime,
        daysOfWeek: days
      } as any,
      maxConcurrentDownloads: maxActive
    } as any, true); // true = silent update
  }, [
    name,
    isScheduled,
    startTime,
    endTime,
    days,
    limitSpeed,
    speedLimitKbs,
    oneTimeLimit,
    shutdownOnComplete,
    hangupOnComplete,
    retryCount,
    maxActive,
    selectedQueueId
  ]);

  // Tasks belonging to this queue
  const queueTasks = tasks.filter(t => t.queueId === selectedQueueId);

  // Sorting tasks in memory based on queue's downloadOrder
  const orderedQueueTasks = [...queueTasks].sort((a, b) => {
    const indexA = selectedQueue.downloadOrder?.indexOf(a.id) ?? -1;
    const indexB = selectedQueue.downloadOrder?.indexOf(b.id) ?? -1;
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  // Filter tasks based on search
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
      name,
      scheduled: isScheduled,
      startTime,
      endTime,
      days,
      limitSpeed,
      speedLimitKbs,
      oneTimeLimit,
      shutdownOnComplete,
      hangupOnComplete,
      retryCount,
      // For full schema compliance and potential nested model bindings
      schedule: {
        enabled: isScheduled,
        startTime,
        endTime,
        daysOfWeek: days
      } as any,
      maxConcurrentDownloads: maxActive
    } as any);

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

  const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

        {/* Selector and Creator */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
          {/* Active Queue Selector */}
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
                      <span className="text-[10px] font-bold text-rose-400 px-1">
                        {"Confirm?"}
                      </span>
                      <button 
                        type="button"
                        onClick={() => {
                          deleteQueue(selectedQueueId);
                          setSelectedQueueId('main');
                          setQueueToDeleteId(null);
                        }}
                        className="px-2 py-0.5 bg-rose-500 hover:bg-rose-600 text-white rounded text-[10px] font-bold cursor-pointer"
                      >
                        {"Delete"}
                      </button>
                      <button 
                        type="button"
                        onClick={() => setQueueToDeleteId(null)}
                        className="px-2 py-0.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-[var(--text-primary)] rounded text-[10px] font-bold cursor-pointer"
                      >
                        {"Cancel"}
                      </button>
                    </div>
                  ) : (
                    <button 
                      type="button"
                      onClick={() => {
                        setQueueToDeleteId(selectedQueueId);
                      }}
                      className="p-1 hover:bg-red-500/20 text-red-500 border border-red-500/30 rounded-md cursor-pointer flex items-center justify-center shrink-0 h-7 w-7"
                      title={"Delete this list permanently"}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Create custom queue */}
          <div className="flex items-center gap-1">
              <input 
              type="text" 
              placeholder={t('sched_new_name')}
              value={newQueueName}
              onChange={(e) => setNewQueueName(e.target.value)}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] focus:border-[var(--accent-primary)] rounded-md px-2 py-1 text-[11px] text-[var(--text-primary)] focus:outline-none focus:ring-0 font-semibold w-24 sm:w-28 transition-all h-7"
            />
            <button
              onClick={handleCreateQueue}
              type="button"
              title={t('sched_create_btn')}
              className="flex items-center justify-center gap-1 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white border border-[var(--accent-border)] rounded-md px-2 py-1 h-7 text-[11px] font-semibold transition-all shrink-0 cursor-pointer shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{'Add'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 2. DYNAMIC LEFT SIDEBAR TAB BAR */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden gap-4" dir="ltr">
        
        {/* LEFT SIDEBAR TABS */}
        <div className="w-52 shrink-0 border-r border-[var(--border-color)] pr-2 overflow-y-auto scrollbar-none select-none flex flex-col gap-1">
          <button 
            type="button"
            onClick={() => setActiveTab('files')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start ${
              activeTab === 'files' 
                ? 'border-transparent text-white bg-[var(--accent-primary)]/10 font-extrabold shadow-sm' 
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/40 bg-transparent'
            }`}
          >
            <Folder className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
            <span>
              {`List Files (${filteredTasks.length})`}
            </span>
          </button>
          
          <button 
            type="button"
            onClick={() => setActiveTab('basic')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start ${
              activeTab === 'basic' 
                ? 'border-transparent text-white bg-[var(--accent-primary)]/10 font-extrabold shadow-sm' 
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/40 bg-transparent'
            }`}
          >
            <Calendar className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
            <span>{t('sched_select_days')}</span>
          </button>

          <button 
            type="button"
            onClick={() => setActiveTab('speed')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start ${
              activeTab === 'speed' 
                ? 'border-transparent text-white bg-[var(--accent-primary)]/10 font-extrabold shadow-sm' 
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/40 bg-transparent'
            }`}
          >
            <Sliders className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
            <span>{t('speed_limiter')}</span>
          </button>

          <button 
            type="button"
            onClick={() => setActiveTab('actions')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start ${
              activeTab === 'actions' 
                ? 'border-transparent text-white bg-[var(--accent-primary)]/10 font-extrabold shadow-sm' 
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/40 bg-transparent'
            }`}
          >
            <Bell className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
            <span>{'Post Actions'}</span>
          </button>

          <button 
            type="button"
            onClick={() => setActiveTab('retries')}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start ${
              activeTab === 'retries' 
                ? 'border-transparent text-white bg-[var(--accent-primary)]/10 font-extrabold shadow-sm' 
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/40 bg-transparent'
            }`}
          >
            <RefreshCw className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
            <span>{'Retries & Connection'}</span>
          </button>
        </div>

        {/* COMPONENT CANVAS - ACTIVE CONTENT */}
        <div className="flex-1 overflow-y-auto pr-1 pl-1 scrollbar-thin flex flex-col min-h-0" dir={'ltr'}>
          
          {/* TAB A: FILES IN QUEUE */}
          {activeTab === 'files' && (
            <div className="flex-1 flex flex-col min-h-0">
              
              {/* Info header */}
              <div className="p-3 border border-[var(--border-color)] bg-[var(--bg-hover)]/10 rounded-xl flex items-center justify-between gap-3 mb-3 shrink-0">
                <div className="space-y-0.5 text-right">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
                      {'Files of List:'} <span className="text-[var(--accent-primary)] font-mono">{name}</span>
                    </h3>
                    {isScheduled && (
                      <span className="text-[9px] bg-emerald-500/15 border border-emerald-500/25 text-emerald-500 font-bold px-1.5 py-0.5 rounded flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                        {`Schedule Active (${startTime} - ${endTime})`}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)] font-bold">
                    {t('sched_num_files', { count: filteredTasks.length })}
                  </span>
                </div>
              </div>

              {/* Search filter inside files */}
              <div className="px-3 py-2 bg-[var(--bg-hover)]/10 border border-[var(--border-color)] rounded-xl flex items-center gap-2 mb-3 shrink-0">
                <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                <input 
                  type="text" 
                  placeholder={t('sched_search_placeholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-transparent border-none text-xs text-[var(--text-primary)] focus:outline-none font-semibold"
                />
                {searchQuery && (
                  <button 
                    onClick={() => setSearchQuery('')}
                    className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] font-semibold"
                  >
                    {'Clear Filter'}
                  </button>
                )}
              </div>

              {/* Tasks list */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1 pl-1">
                {filteredTasks.length === 0 ? (
                  <div className="text-center py-16 text-[var(--text-muted)] space-y-2">
                    <ShieldAlert className="w-10 h-10 mx-auto opacity-30 text-[var(--accent-primary)]" />
                    <p className="font-bold text-xs text-[var(--text-secondary)]">
                      {`No downloads customized for list [${name}] currently.`}
                    </p>
                    <p className="text-[11px] text-slate-500 max-w-xs mx-auto leading-relaxed">
                      {'To assign a file to this list, edit its properties from the main table or select it when adding.'}
                    </p>
                  </div>
                ) : (
                  filteredTasks.map((task, index) => {
                    const percent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;
                    const sizeLabel = task.sizeBytes > 0 ? `${(task.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : 'Unknown';
                    return (
                      <div 
                        key={task.id}
                        className="flex items-center justify-between p-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl shadow-sm gap-4"
                      >
                        <div className="flex items-center gap-3 truncate flex-1 min-w-0">
                          <span className="w-5 h-5 flex items-center justify-center bg-[var(--bg-input)] border border-[var(--border-color)] rounded-full text-[10px] font-mono text-[var(--text-secondary)] font-bold shrink-0">
                            {index + 1}
                          </span>
                          <div className="truncate text-right flex-1 min-w-0">
                            <span className="text-xs font-bold font-mono block text-[var(--text-primary)] truncate" style={{ direction: 'ltr' }}>
                              {task.name}
                            </span>
                            <span className="text-[10px] text-[var(--text-muted)] block font-mono font-semibold truncate">
                              {`Size: ${sizeLabel} - Progress: ${percent}%`}
                            </span>
                          </div>
                        </div>

                        {/* Priority Order manipulation arrows & delete/remove buttons */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button 
                            type="button"
                            onClick={() => handleMoveUp(task.id)}
                            disabled={index === 0}
                            className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--border-color)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[var(--text-secondary)] hover:text-white cursor-pointer border-transparent"
                            title={t('sched_prio_up')}
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button 
                            type="button"
                            onClick={() => handleMoveDown(task.id)}
                            disabled={index === filteredTasks.length - 1}
                            className="p-1.5 bg-[var(--bg-input)] hover:bg-[var(--border-color)] disabled:opacity-30 disabled:cursor-not-allowed rounded-lg text-[var(--text-secondary)] hover:text-white cursor-pointer border-transparent"
                            title={t('sched_prio_down')}
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          {taskToRemoveId === task.id ? (
                            <div className="flex items-center gap-1 bg-rose-500/10 border border-rose-500/20 p-1 rounded-lg">
                              <span className="text-[9px] font-bold text-rose-400 px-1 whitespace-nowrap">
                                {"Remove?"}
                              </span>
                              <button 
                                type="button"
                                onClick={() => {
                                  removeTaskFromQueue(task.id);
                                  setTaskToRemoveId(null);
                                }}
                                className="px-1.5 py-0.5 bg-rose-500 hover:bg-rose-600 text-white rounded text-[9px] font-bold cursor-pointer"
                              >
                                {"Yes"}
                              </button>
                              <button 
                                type="button"
                                onClick={() => setTaskToRemoveId(null)}
                                className="px-1.5 py-0.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color)] text-[var(--text-primary)] rounded text-[9px] font-bold cursor-pointer"
                              >
                                {"No"}
                              </button>
                            </div>
                          ) : (
                            <button 
                              type="button"
                              onClick={() => {
                                setTaskToRemoveId(task.id);
                              }}
                              className="p-1.5 bg-[var(--bg-input)] hover:bg-red-500/10 text-red-500 hover:text-red-400 rounded-lg cursor-pointer border-transparent"
                              title={"Remove file from this list"}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* SETTINGS TABS */}
          {activeTab !== 'files' && (
            <div className="flex-1 flex flex-col justify-between min-h-0">
              <div className="max-w-2xl mx-auto w-full space-y-4 overflow-y-auto pr-1 pl-1 flex-1 pb-4">
                
                {/* TAB B: BASIC SCHEDULING */}
                {activeTab === 'basic' && (
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                        {'List name to edit:'}
                      </span>
                      <input 
                        type="text" 
                        value={name} 
                        onChange={(e) => setName(e.target.value)}
                        className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-2.5 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)] font-bold shadow-sm"
                      />
                    </div>

                    {/* Dynamic Scheduling Type Selector */}
                    <div className="space-y-1">
                      <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                        {'Schedule Type:'}
                      </span>
                      <div className="grid grid-cols-3 gap-1 bg-[var(--bg-input)] p-1 rounded-lg border border-[var(--border-color)]">
                        {(['once', 'daily', 'weekly'] as const).map(type => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setSmartScheduleType(type)}
                            className={`py-1.5 text-[10px] md:text-xs font-bold rounded-md cursor-pointer ${
                              smartScheduleType === type 
                                ? 'text-white font-extrabold bg-[var(--accent-primary)]/10' 
                                : 'text-[var(--text-muted)] hover:text-white bg-transparent'
                            }`}
                          >
                            {type === 'once' ? ('Once') : type === 'daily' ? ('Daily Recurrent') : ('Custom Days')}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
                      <div className="flex flex-col text-right">
                        <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
                          {'Enable Automatic Timer'}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {'Start and stop the list automatically based on the time below'}
                        </span>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={isScheduled} 
                        onChange={(e) => setIsScheduled(e.target.checked)}
                        className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                      />
                    </div>

                    {isScheduled && (
                      <div className="space-y-4 p-4 bg-[var(--bg-input)]/40 border border-[var(--border-color)] rounded-xl shadow-inner">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <TimePicker 
                            label={"Start Time:"} 
                            value={startTime} 
                            onChange={(val) => setStartTime(val)} 
                          />
                          <TimePicker 
                            label={"Stop Time:"} 
                            value={endTime} 
                            onChange={(val) => setEndTime(val)} 
                          />
                        </div>

                        {/* Day selectors */}
                        <div className="space-y-1.5 pt-1">
                          <span className="text-[11px] text-[var(--text-muted)] block mb-1 font-bold">
                            {'Days of the Week:'}
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {[0, 1, 2, 3, 4, 5, 6].map(d => {
                              const active = days.includes(d);
                              return (
                                <button
                                  key={d}
                                  type="button"
                                  onClick={() => toggleDay(d)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
                                    active 
                                      ? 'text-white font-extrabold bg-[var(--accent-primary)]/10 shadow-sm' 
                                      : 'text-[var(--text-muted)] hover:text-white bg-transparent'
                                  }`}
                                >
                                  {weekDays[d]}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Concurrent limit */}
                    <div className="space-y-1">
                      <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                        {'Max Concurrent Downloads:'}
                      </span>
                      <select
                        value={maxActive}
                        onChange={(e) => setMaxActive(Number(e.target.value))}
                        className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-2.5 text-xs focus:outline-none text-[var(--text-primary)] font-bold cursor-pointer shadow-sm"
                      >
                        <option value={1}>{'1 file sequentially (Recommended)'}</option>
                        <option value={2}>{'2 files concurrently'}</option>
                        <option value={3}>{'3 files concurrently'}</option>
                        <option value={4}>{'4 files concurrently'}</option>
                        <option value={6}>{'6 files concurrently'}</option>
                        <option value={10}>{'10 files concurrently (Max performance)'}</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* TAB C: SPEED LIMITER */}
                {activeTab === 'speed' && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
                      <div className="flex flex-col text-right">
                        <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
                          {t('speed_limiter')}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {'Limit speed to protect total bandwidth'}
                        </span>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={limitSpeed} 
                        onChange={(e) => setLimitSpeed(e.target.checked)}
                        className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                      />
                    </div>

                    {limitSpeed && (
                      <div className="p-4 bg-[var(--bg-input)]/40 border border-[var(--border-color)] rounded-xl space-y-4 shadow-inner">
                        <div className="space-y-2">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <span className="text-xs text-[var(--text-secondary)] font-bold">{t('set_speed_max')}</span>
                            <div dir="ltr">
                              <SpeedLimitInput 
                                maxSpeedKbs={speedLimitKbs}
                                onChange={(v) => setSpeedLimitKbs(v)}
                                compact={false}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed bg-amber-500/5 border border-amber-500/10 p-3 rounded-lg">
                          <Sliders className="w-4 h-4 text-amber-500 shrink-0" />
                          <span>
                            {'Speed limit helps you browse websites smoothly while downloading in the background.'}
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-between bg-[var(--bg-hover)]/40 p-3 rounded-lg border border-[var(--border-color)] shadow-sm">
                      <div className="flex flex-col text-right">
                        <span className="text-xs md:text-sm font-bold text-[var(--text-primary)]">
                          {t('sched_low_speed_toggle')}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {t('sched_low_speed_desc')}
                        </span>
                      </div>
                      <input 
                        type="checkbox" 
                        checked={oneTimeLimit} 
                        onChange={(e) => setOneTimeLimit(e.target.checked)}
                        className="w-4.5 h-4.5 rounded text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                      />
                    </div>
                  </div>
                )}

                {/* TAB D: POST-DOWNLOAD ACTIONS */}
                {activeTab === 'actions' && (
                  <div className="space-y-4">
                    <h3 className="text-xs font-bold text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1.5">
                      {'Actions upon completion of all downloads:'}
                    </h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
                        <div className="flex items-center gap-2.5">
                          <Server className="w-4 h-4 text-red-500" />
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-[var(--text-primary)]">{'Shutdown PC'}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">Shutdown PC</span>
                          </div>
                        </div>
                        <input 
                          type="checkbox" 
                          checked={shutdownOnComplete} 
                          onChange={(e) => setShutdownOnComplete(e.target.checked)}
                          className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
                        <div className="flex items-center gap-2.5">
                          <Shield className="w-4 h-4 text-blue-500" />
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-[var(--text-primary)]">{'Sleep Mode'}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">Sleep mode</span>
                          </div>
                        </div>
                        <input 
                          type="checkbox" 
                          checked={hangupOnComplete} 
                          onChange={(e) => setHangupOnComplete(e.target.checked)}
                          className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
                        <div className="flex items-center gap-2.5">
                          <ShieldAlert className="w-4 h-4 text-amber-500" />
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-[var(--text-primary)]">{'Exit securely'}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">Exit program securely</span>
                          </div>
                        </div>
                        <input 
                          type="checkbox" 
                          checked={exitOnComplete} 
                          onChange={(e) => setExitOnComplete(e.target.checked)}
                          className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] hover:border-[var(--accent-border)] rounded-xl cursor-pointer hover:bg-[var(--bg-hover)] shadow-sm">
                        <div className="flex items-center gap-2.5">
                          <Volume2 className="w-4 h-4 text-emerald-500" />
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-[var(--text-primary)]">{'Chime Alert'}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">Chime sound alert</span>
                          </div>
                        </div>
                        <input 
                          type="checkbox" 
                          checked={playChime} 
                          onChange={(e) => setPlayChime(e.target.checked)}
                          className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                        />
                      </label>
                    </div>

                    <div className="p-3 bg-[var(--bg-surface)] border border-[var(--border-color)] rounded-xl space-y-2.5 shadow-sm">
                      <label className="flex items-center justify-between cursor-pointer">
                        <div className="flex items-center gap-2.5">
                          <Globe className="w-4 h-4 text-violet-500" />
                          <div className="flex flex-col">
                            <span className="text-xs font-bold text-[var(--text-primary)]">{'Send HTTP Webhook'}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">Send HTTP POST payload notice</span>
                          </div>
                        </div>
                        <input 
                          type="checkbox" 
                          checked={enableWebhook} 
                          onChange={(e) => setEnableWebhook(e.target.checked)}
                          className="w-4.5 h-4.5 text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
                        />
                      </label>
                      {enableWebhook && (
                        <input 
                          type="url" 
                          value={webhookUrl}
                          onChange={(e) => setWebhookUrl(e.target.value)}
                          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs font-mono text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent-primary)]"
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* TAB E: RETRIES & ERROR CORRECTION */}
                {activeTab === 'retries' && (
                  <div className="space-y-4">
                    <h3 className="text-xs font-bold text-[var(--text-muted)] border-b border-[var(--border-color)] pb-1.5">
                      {'Retries & error correction:'}
                    </h3>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                          {'Max retry attempts per file:'}
                        </span>
                        <select
                          value={retryCount}
                          onChange={(e) => setRetryCount(Number(e.target.value))}
                          className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg pl-8 pr-3 py-2.5 text-xs focus:outline-none text-[var(--text-primary)] font-bold cursor-pointer shadow-sm"
                        >
                          <option value={1}>{'1 attempt'}</option>
                          <option value={3}>{'3 attempts'}</option>
                          <option value={5}>{'5 attempts (Default)'}</option>
                          <option value={10}>{'10 attempts (Weak networks)'}</option>
                          <option value={20}>{'20 attempts'}</option>
                          <option value={50}>{'50 attempts'}</option>
                          <option value={9999}>{'Infinite attempts (Keep reconnecting)'}</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <span className="text-[11px] font-bold text-[var(--text-secondary)]">
                          {'Wait time before retrying (seconds):'}
                        </span>
                        <div className="flex items-center gap-2">
                          <input 
                            type="number" 
                            min={1} 
                            max={120} 
                            value={retryDelay} 
                            onChange={(e) => setRetryDelay(Number(e.target.value))}
                            className="w-24 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg p-2 text-center text-xs font-mono font-bold text-[var(--text-primary)] shadow-sm"
                          />
                          <span className="text-xs text-[var(--text-muted)] font-bold">
                            {'seconds between attempts'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="p-3 bg-blue-500/5 border border-blue-500/10 text-[11px] text-[var(--text-secondary)] rounded-xl flex items-start gap-2.5 leading-relaxed shadow-sm">
                      <CheckCircle2 className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                      <div>
                        <span className="font-bold text-[var(--text-primary)] block">
                          {'Smart Link Verification:'}
                        </span>
                        {'The program intercepts HTTP error codes, updates tokens, and verifies link availability prior to restart to prevent files from being corrupted.'}
                      </div>
                    </div>
                  </div>
                )}

              </div>
            </div>
          )}

        </div>

      </div>

      {/* 3. MULTI-ACTION CONTROLS FOOTER */}
      <div className="flex flex-col sm:flex-row gap-3 items-center justify-between border-t border-[var(--border-color)] pt-3 mt-4 shrink-0">
        {/* Reset / Diagnostic controls or simple info */}
        <div className="flex gap-2">
          {activeTab === 'files' ? (
            <div className="text-[10px] text-[var(--text-muted)] font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
              <span>{t('sched_num_files', { count: filteredTasks.length })}</span>
            </div>
          ) : (
            <div className="text-[10px] text-[var(--text-muted)] font-semibold flex items-center gap-1.5 leading-normal">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
              <span>
                {'Timers and speed scheduler run in the background.'}
              </span>
            </div>
          )}
        </div>

        {/* Action Buttons: Apply, Save, Close */}
        <div className="flex gap-2">
          {activeTab === 'files' ? (
            <>
              <Button 
                type="button" 
                onClick={handleStopQueue}
                variant="secondary"
                size="md"
                icon={Pause}
              >
                {t('sched_stop_queue')}
              </Button>

              <Button 
                type="button" 
                onClick={handleStartQueue}
                variant="primary"
                size="md"
                icon={Play}
              >
                {t('sched_start_queue')}
              </Button>

              <DialogButton 
                onClick={closeDialog}
                variant="secondary"
                size="md"
              >
                {'Close'}
              </DialogButton>
            </>
          ) : (
            <DialogButton 
              onClick={closeDialog}
              variant="primary"
              size="md"
            >
              {'Close'}
            </DialogButton>
          )}
        </div>
      </div>

    </div>
  );
};
