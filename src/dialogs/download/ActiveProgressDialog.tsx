/* src/dialogs/download/ActiveProgressDialog.tsx */
import React, { useState, useMemo } from 'react';
import { useAppStore } from '../../state/appStore';
import type { DownloadItem, DownloadSegment } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';
import { formatSpeed, formatElapsed } from '../../utils/formatUtils';

const SEGMENT_COLORS = [
  'from-blue-500 to-blue-400',
  'from-emerald-500 to-emerald-400',
  'from-violet-500 to-violet-400',
  'from-amber-500 to-amber-400',
  'from-rose-500 to-rose-400',
  'from-cyan-500 to-cyan-400',
  'from-fuchsia-500 to-fuchsia-400',
  'from-lime-500 to-lime-400',
  'from-sky-500 to-sky-400',
  'from-orange-500 to-orange-400',
  'from-teal-500 to-teal-400',
  'from-indigo-500 to-indigo-400',
  'from-pink-500 to-pink-400',
  'from-red-500 to-red-400',
  'from-yellow-500 to-yellow-400',
  'from-slate-500 to-slate-400',
  'from-purple-500 to-purple-400',
  'from-zinc-500 to-zinc-400',
  'from-stone-500 to-stone-400',
  'from-neutral-500 to-neutral-400',
  'from-sky-600 to-cyan-400',
  'from-rose-600 to-pink-400',
  'from-emerald-600 to-teal-400',
  'from-violet-600 to-purple-400',
  'from-amber-600 to-yellow-400',
  'from-red-600 to-orange-400',
  'from-blue-600 to-indigo-400',
  'from-green-600 to-lime-400',
  'from-fuchsia-600 to-pink-400',
  'from-orange-600 to-red-400',
  'from-cyan-600 to-blue-400',
  'from-indigo-600 to-violet-400',
];

const SEGMENT_BG_COLORS = [
  'bg-blue-500/20',
  'bg-emerald-500/20',
  'bg-violet-500/20',
  'bg-amber-500/20',
  'bg-rose-500/20',
  'bg-cyan-500/20',
  'bg-fuchsia-500/20',
  'bg-lime-500/20',
  'bg-sky-500/20',
  'bg-orange-500/20',
  'bg-teal-500/20',
  'bg-indigo-500/20',
  'bg-pink-500/20',
  'bg-red-500/20',
  'bg-yellow-500/20',
  'bg-slate-500/20',
  'bg-purple-500/20',
  'bg-zinc-500/20',
  'bg-stone-500/20',
  'bg-neutral-500/20',
  'bg-sky-600/20',
  'bg-rose-600/20',
  'bg-emerald-600/20',
  'bg-violet-600/20',
  'bg-amber-600/20',
  'bg-red-600/20',
  'bg-blue-600/20',
  'bg-green-600/20',
  'bg-fuchsia-600/20',
  'bg-orange-600/20',
  'bg-cyan-600/20',
  'bg-indigo-600/20',
];

const SEGMENT_TEXT_COLORS = [
  'text-blue-400',
  'text-emerald-400',
  'text-violet-400',
  'text-amber-400',
  'text-rose-400',
  'text-cyan-400',
  'text-fuchsia-400',
  'text-lime-400',
  'text-sky-400',
  'text-orange-400',
  'text-teal-400',
  'text-indigo-400',
  'text-pink-400',
  'text-red-400',
  'text-yellow-400',
  'text-slate-400',
  'text-purple-400',
  'text-zinc-400',
  'text-stone-400',
  'text-neutral-400',
  'text-sky-500',
  'text-rose-500',
  'text-emerald-500',
  'text-violet-500',
  'text-amber-500',
  'text-red-500',
  'text-blue-500',
  'text-green-500',
  'text-fuchsia-500',
  'text-orange-500',
  'text-cyan-500',
  'text-indigo-500',
];

const getSegmentColor = (index: number) => SEGMENT_COLORS[index % SEGMENT_COLORS.length];
const getSegmentBg = (index: number) => SEGMENT_BG_COLORS[index % SEGMENT_BG_COLORS.length];
const getSegmentText = (index: number) => SEGMENT_TEXT_COLORS[index % SEGMENT_TEXT_COLORS.length];

const SegmentCard: React.FC<{
  seg: DownloadSegment;
  index: number;
  segTotal: number;
  segDownloaded: number;
  isActive: boolean;
  t: (key: string) => string;
}> = React.memo(({ seg, index, segTotal, segDownloaded, isActive, t }) => {
  const segPercent = segTotal > 0 ? Math.round((segDownloaded / segTotal) * 100) : 0;
  const colorClass = getSegmentText(index);
  const bgClass = getSegmentBg(index);
  const gradientClass = getSegmentColor(index);

  return (
    <div
      className={`relative group border rounded-lg overflow-hidden transition-all duration-300 ${
        isActive
          ? `border-[var(--border-color)] bg-[var(--bg-surface-elevated)] shadow-md`
          : seg.progress >= 1
            ? 'border-green-500/30 bg-green-500/5'
            : 'border-[var(--border-color)] bg-[var(--bg-input)] opacity-70'
      }`}
    >
      {isActive && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.02] to-transparent animate-[shimmer_3s_ease-in-out_infinite]" />
      )}

      <div className="relative flex items-center gap-3 px-3 py-2.5">
        <div className="flex flex-col items-center justify-center min-w-[40px]">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-bold font-mono ${
              isActive ? bgClass : 'bg-[var(--bg-input)]'
            } ${isActive ? colorClass : 'text-[var(--text-secondary)]'}`}
          >
            {seg.id}
          </div>
          {isActive && seg.progress < 1 && (
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)] mt-1 animate-pulse" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className={`text-[11px] font-bold ${isActive ? colorClass : 'text-[var(--text-secondary)]'}`}>
              {seg.progress >= 1 ? t('progress_complete') : seg.active ? t('progress_receiving') : t('progress_idle')}
            </span>
            <span className="text-[10px] font-mono text-[var(--text-muted)]">
              {formatBytes(segDownloaded)} <span className="text-[var(--text-secondary)]/50">{t('progress_seg_of')}</span> {formatBytes(segTotal)}
            </span>
          </div>

          <div className="relative h-2 w-full bg-[var(--bg-input)] rounded-full overflow-hidden border border-[var(--border-color)]/50">
            {isActive && seg.progress < 1 ? (
              <div
                className={`absolute top-0 bottom-0 left-0 bg-gradient-to-r ${gradientClass} rounded-full transition-all duration-300 shadow-[0_0_6px_rgba(var(--accent-primary-rgb,59,130,246),0.4)]`}
                style={{ width: `${String(segPercent)}%` }}
              />
            ) : (
              <div
                className={`absolute top-0 bottom-0 left-0 rounded-full transition-all duration-300 ${
                  seg.progress >= 1 ? 'bg-emerald-500/70' : 'bg-[var(--text-secondary)]/30'
                }`}
                style={{ width: `${String(segPercent)}%` }}
              />
            )}
            {isActive && seg.progress < 1 && segPercent > 0 && segPercent < 100 && (
              <div
                className="absolute top-0 bottom-0 w-[2px] bg-white/80 animate-pulse"
                style={{ left: `${String(segPercent)}%` }}
              />
            )}
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] font-mono text-[var(--text-muted)]">{segPercent}%</span>
            {isActive && seg.speed > 0 && (
              <span className={`text-[10px] font-mono font-bold ${colorClass}`}>
                {formatSpeed(seg.speed)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
SegmentCard.displayName = 'SegmentCard';

export const ActiveProgressDialog: React.FC<{ taskId?: string }> = ({ taskId }) => {
  const { dialog, tasks, pauseTask, resumeTask, settings, updateSettings, t } = useAppStore();
  const taskFromPayload = dialog.payload as DownloadItem | null | undefined;
  // An explicit taskId (detached window) wins; otherwise fall back to the
  // dialog payload, then to any actively downloading task.
  const task =
    (taskId ? tasks.find((tt) => tt.id === taskId) : null) ||
    (taskFromPayload ? tasks.find((tt) => tt.id === taskFromPayload.id) || taskFromPayload : null) ||
    tasks.find((tt) => tt.status === 'downloading');

  const [activeTab, setActiveTab] = useState<'status' | 'speed' | 'options'>('status');
  // Collapsed by default so the dialog opens compact; the toggle reveals the
  // tabs, details and per-segment cards.
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const speedLimitEnabled = settings.connection.speedLimiter.enabled;
  const speedLimitValue = settings.connection.speedLimiter.maxSpeedKbs;
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [disconnectOnComplete, setDisconnectOnComplete] = useState(false);
  const [exitOnComplete, setExitOnComplete] = useState(false);
  const [shutdownOnComplete, setShutdownOnComplete] = useState(false);
  const [shutdownAction, setShutdownAction] = useState('Shutdown computer');
  const [forceCloseProcesses, setForceCloseProcesses] = useState(false);

  const progressPercent = task ? (task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0) : 0;

  const activeSegments = useMemo(
    () => (task ? task.segments.filter((s) => s.active && s.progress < 1) : []),
    [task],
  );
  const completedSegments = useMemo(
    () => (task ? task.segments.filter((s) => s.progress >= 1) : []),
    [task],
  );
  const totalActiveSpeed = useMemo(
    () => (task ? task.segments.reduce((sum, s) => sum + (s.active ? s.speed : 0), 0) : 0),
    [task],
  );

  if (!task) {
    return null;
  }

  const handleToggleSpeedLimit = (checked: boolean) => {
    updateSettings(
      {
        ...settings,
        connection: {
          ...settings.connection,
          speedLimiter: {
            ...settings.connection.speedLimiter,
            enabled: checked,
            maxSpeedKbs: speedLimitValue,
          },
        },
      },
      true,
    );
  };

  const handleSpeedLimitValueChange = (val: string) => {
    const num = parseInt(val, 10) || 10;
    updateSettings(
      {
        ...settings,
        connection: {
          ...settings.connection,
          speedLimiter: {
            ...settings.connection.speedLimiter,
            maxSpeedKbs: num,
          },
        },
      },
      true,
    );
  };

  const tabClass = (tab: typeof activeTab) =>
    `px-4 py-1 text-[11px] font-bold border-t border-l border-r transition-all duration-150 cursor-pointer ${
      activeTab === tab
        ? 'bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] border-[var(--border-color)] pt-1 pb-1.5 -mb-[1px] z-10'
        : 'bg-[var(--bg-input)] text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] pb-1'
    }`;

  const isDownloading = task.status === 'downloading';

  return (
    <div
      className="space-y-2 font-sans text-xs text-[var(--text-primary)] select-none pb-1"
      style={{ direction: 'ltr' }}
    >
      {/* Segmented Progress Bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[var(--text-secondary)]">{t('progress_overall_progress')}</span>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold font-mono text-[var(--accent-primary)]">{progressPercent}%</span>
            <button
              type="button"
              onClick={() => {
                setDetailsCollapsed((v) => !v);
              }}
              className="px-1.5 h-4 flex items-center justify-center rounded text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer leading-none"
              title={detailsCollapsed ? t('progress_show_details') : t('progress_hide_details')}
            >
              {detailsCollapsed ? '▸' : '▾'}
            </button>
          </div>
        </div>
        <div
          className="w-full h-6 bg-[var(--bg-input)] border border-[var(--border-color)] flex rounded-lg overflow-hidden select-none shadow-inner"
          style={{ direction: 'ltr' }}
        >
          {task.segments.map((seg, idx) => {
            const segPercent = Math.round(seg.progress * 100);
            const gradientClass = getSegmentColor(idx);
            return (
              <div
                key={seg.id}
                className="h-full flex-1 border-r border-[var(--border-color)]/30 last:border-r-0 relative bg-[var(--bg-input)]"
                title={`${t('progress_seg_number')} ${String(seg.id)}: ${String(segPercent)}%`}
              >
                {segPercent > 0 && (
                  <div
                    className={`h-full absolute top-0 left-0 transition-all duration-300 ${
                      seg.active && seg.progress < 1
                        ? `bg-gradient-to-r ${gradientClass} opacity-90`
                        : seg.progress >= 1
                          ? 'bg-emerald-500/60'
                          : 'bg-[var(--text-secondary)]/25'
                    }`}
                    style={{ width: `${String(segPercent)}%` }}
                  />
                )}
                {seg.active && seg.progress < 1 && segPercent > 0 && segPercent < 100 && (
                  <div
                    className="w-[1.5px] bg-white/70 h-full absolute top-0 animate-pulse"
                    style={{ left: `${String(segPercent)}%` }}
                  />
                )}
                {isDownloading && seg.active && seg.progress < 1 && (
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent animate-[shimmer_2s_ease-in-out_infinite]" />
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-[var(--accent-primary)] opacity-90" />
            {t('progress_receiving')} ({activeSegments.length})
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-emerald-500/60" />
            {t('progress_complete')} ({completedSegments.length})
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-[var(--text-secondary)]/25" />
            {t('progress_idle')} ({task.segments.length - activeSegments.length - completedSegments.length})
          </span>
        </div>
      </div>

      {/* Live Stats Bar */}
      {isDownloading && (
        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[10px] font-bold text-emerald-400">{t('progress_active_connections')}</span>
          </div>
          <div className="h-3 w-px bg-[var(--border-color)]" />
          <span className="text-[10px] font-mono font-bold text-[var(--accent-primary)]">
            {activeSegments.length}/{task.segments.length}
          </span>
          <div className="h-3 w-px bg-[var(--border-color)]" />
          <span className="text-[10px] font-mono text-[var(--text-primary)]">
            {formatSpeed(totalActiveSpeed > 0 ? totalActiveSpeed : task.speedBytesPerSec)}
          </span>
          <div className="h-3 w-px bg-[var(--border-color)]" />
          <span className="text-[10px] font-mono text-[var(--info)]">
            {t('progress_eta')}: {formatElapsed(task.timeLeftSeconds)}
          </span>
        </div>
      )}

      {!detailsCollapsed && (
        <>
      <div className="flex border-b border-[var(--border-color)] select-none pl-1" style={{ direction: 'ltr' }}>
        <button
          onClick={() => { setActiveTab('status'); }}
          className={tabClass('status')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          {t('progress_status_tab')}
        </button>
        <button
          onClick={() => { setActiveTab('speed'); }}
          className={tabClass('speed')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          {t('progress_speed_tab')}
        </button>
        <button
          onClick={() => { setActiveTab('options'); }}
          className={tabClass('options')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          {t('progress_options_tab')}
        </button>
      </div>

      <div
        className="border border-[var(--border-color)] bg-[var(--bg-surface-elevated)] p-3 text-left rounded-b-md"
        style={{ minHeight: '170px' }}
      >
        {activeTab === 'status' && (
          <div className="space-y-2.5 animate-in fade-in duration-150">
            <div
              className="text-left font-mono text-[11px] text-[var(--text-secondary)] bg-[var(--bg-input)] p-2 border border-[var(--border-color)] rounded select-all truncate"
              style={{ direction: 'ltr' }}
            >
              {task.url}
            </div>
            <div className="h-[1px] bg-[var(--border-color)]" />
            <div className="grid grid-cols-12 gap-y-2 text-[11px] md:text-xs">
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_status')}</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium capitalize">{task.status}</div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_file_size')}</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium">{formatBytes(task.sizeBytes)}</div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_downloaded')}</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium">
                {formatBytes(task.downloadedBytes)} ({progressPercent}%)
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_transfer_rate')}</div>
              <div className="col-span-9 text-[var(--accent-primary)] font-bold">
                {isDownloading ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_time_left')}</div>
              <div className="col-span-9 text-[var(--info)] font-semibold">
                {isDownloading ? formatElapsed(task.timeLeftSeconds) : t('progress_not_running')}
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_elapsed')}</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium">
                {formatElapsed(task.elapsedSeconds)}
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_resume')}</div>
              <div className="col-span-9 text-[var(--accent-primary)] font-bold">
                {task.resumable ? t('task_supported') : t('task_not_supported')}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'speed' && (
          <div className="space-y-3.5 animate-in fade-in duration-150">
            <div className="flex justify-between items-center text-xs">
              <span className="text-[var(--text-secondary)] font-semibold">{t('progress_transfer_rate')}</span>
              <span className="text-[var(--accent-primary)] font-bold">
                {isDownloading ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
              </span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={speedLimitEnabled}
                onChange={(e) => { handleToggleSpeedLimit(e.target.checked); }}
                className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
              />
              <span className="text-xs text-[var(--text-primary)]">{t('progress_use_global_speed_limit')}</span>
            </label>
            <div className="space-y-1">
              <span className="text-[11px] text-[var(--text-secondary)] block">{t('progress_max_speed')}</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={speedLimitValue}
                  onChange={(e) => { handleSpeedLimitValueChange(e.target.value); }}
                  disabled={!speedLimitEnabled}
                  className="w-20 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-primary)] font-mono text-center text-xs py-0.5 px-2 focus:outline-none focus:border-[var(--accent-primary)] disabled:opacity-40 disabled:bg-[var(--bg-hover)] disabled:cursor-not-allowed"
                />
                <span className="text-[11px] text-[var(--text-secondary)]">KB/s</span>
              </div>
            </div>
            <button
              onClick={() => { setActiveTab('status'); }}
              className="px-3.5 py-1 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] active:scale-95 border border-[var(--border-color)] text-[var(--text-primary)] text-[11px] font-sans font-bold shadow-sm transition-all cursor-pointer rounded-lg"
            >
              {t('progress_hide_tab')}
            </button>
          </div>
        )}

        {activeTab === 'options' && (
          <div className="space-y-2 animate-in fade-in duration-150">
            <div className="flex justify-between items-center text-xs text-[var(--text-secondary)]">
              <span className="font-semibold shrink-0">{t('progress_save_to')}</span>
              <span className="text-[var(--text-primary)] font-mono truncate ml-2 select-all w-full text-left">
                {task.savePath}
              </span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none pt-0.5">
              <input
                type="checkbox"
                checked={notifyOnComplete}
                onChange={(e) => { setNotifyOnComplete(e.target.checked); }}
                className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
              />
              <span className="text-xs text-[var(--text-primary)]">{t('progress_notify_complete')}</span>
            </label>
            <div
              className={`grid grid-cols-12 gap-y-1.5 text-[11px] ${notifyOnComplete ? 'opacity-40 pointer-events-none' : ''}`}
            >
              <label className="col-span-12 flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={disconnectOnComplete}
                  onChange={(e) => { setDisconnectOnComplete(e.target.checked); }}
                  disabled={notifyOnComplete}
                  className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                />
                <span className="text-[var(--text-secondary)]">{t('progress_disconnect_complete')}</span>
              </label>
              <label className="col-span-12 flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={exitOnComplete}
                  onChange={(e) => { setExitOnComplete(e.target.checked); }}
                  disabled={notifyOnComplete}
                  className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                />
                <span className="text-[var(--text-secondary)]">{t('progress_exit_complete')}</span>
              </label>
              <div className="col-span-12 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={shutdownOnComplete}
                    onChange={(e) => { setShutdownOnComplete(e.target.checked); }}
                    disabled={notifyOnComplete}
                    className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                  />
                  <span className="text-[var(--text-secondary)] whitespace-nowrap">{t('progress_power_action')}</span>
                </label>
                <select
                  value={shutdownAction}
                  onChange={(e) => { setShutdownAction(e.target.value); }}
                  disabled={notifyOnComplete || !shutdownOnComplete}
                  className="bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-primary)] text-[10px] md:text-xs px-2 py-0.5 rounded focus:outline-none focus:border-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="Shutdown computer">{t('progress_shutdown')}</option>
                  <option value="Restart computer">{t('progress_restart')}</option>
                  <option value="Sleep">{t('progress_sleep')}</option>
                </select>
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={forceCloseProcesses}
                    onChange={(e) => { setForceCloseProcesses(e.target.checked); }}
                    disabled={notifyOnComplete || !shutdownOnComplete}
                    className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                  />
                  <span className="text-[var(--text-secondary)]">{t('progress_force_close')}</span>
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Segment Distribution Cards */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold text-[var(--text-secondary)]">
            {t('progress_segment_distribution')}
          </span>
          <span className="text-[10px] font-mono text-[var(--text-muted)]">
            {task.segments.length} {t('progress_seg_of')} {task.connections || task.segments.length}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5 max-h-52 overflow-y-auto overflow-x-hidden pr-1 scrollbar-thin">
          {task.segments.map((seg, idx) => {
            const segTotal = seg.totalBytes || Math.round(task.sizeBytes / (task.segments.length || 8));
            const segDownloaded = seg.downloadedBytes || Math.round(seg.progress * segTotal);
            return (
              <SegmentCard
                key={seg.id}
                seg={seg}
                index={idx}
                segTotal={segTotal}
                segDownloaded={segDownloaded}
                isActive={seg.active && seg.progress < 1}
                t={t}
              />
            );
          })}
        </div>
      </div>
        </>
      )}

      <div className="flex items-center justify-between pt-1" style={{ direction: 'ltr' }}>
        <div className="flex items-center gap-2">
          {isDownloading ? (
            <button
              onClick={() => { pauseTask(task.id); }}
              className="px-6 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
            >
              {t('topbar_stop')}
            </button>
          ) : task.status === 'paused' || task.status === 'error' ? (
            <button
              onClick={() => { resumeTask(task.id); }}
              className="px-6 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
            >
              {t('progress_resume_btn')}
            </button>
          ) : (
            <div className="px-6 py-1.5 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-muted)] text-[11px] font-bold select-none min-w-[80px] text-center rounded-lg">
              {t('progress_finished')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
