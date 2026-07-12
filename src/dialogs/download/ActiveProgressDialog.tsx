/* src/dialogs/download/ActiveProgressDialog.tsx */
import React, { useState } from 'react';
import { useAppStore } from '../../state/appStore';
import type { DownloadItem } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';
import { formatSpeed, formatElapsed } from '../../utils/formatUtils';

export const ActiveProgressDialog: React.FC = () => {
  const {
    dialog,
    closeDialog,
    tasks,
    pauseTask,
    resumeTask,
    settings,
    updateSettings,
    minimizeActiveProgressToTaskbar,
    t,
  } = useAppStore();
  const taskFromPayload = dialog.payload as DownloadItem | null | undefined;
  const task =
    (taskFromPayload ? tasks.find((t) => t.id === taskFromPayload.id) || taskFromPayload : null) ||
    tasks.find((t) => t.status === 'downloading');

  const [activeTab, setActiveTab] = useState<'status' | 'speed' | 'options'>('status');
  const [showPartInfo, setShowPartInfo] = useState(false);
  const speedLimitEnabled = settings.connection.speedLimiter.enabled;
  const speedLimitValue = settings.connection.speedLimiter.maxSpeedKbs;
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [disconnectOnComplete, setDisconnectOnComplete] = useState(false);
  const [exitOnComplete, setExitOnComplete] = useState(false);
  const [shutdownOnComplete, setShutdownOnComplete] = useState(false);
  const [shutdownAction, setShutdownAction] = useState('Shutdown computer');
  const [forceCloseProcesses, setForceCloseProcesses] = useState(false);

  if (!task) {
    return null;
  }

  const progressPercent = task.sizeBytes > 0 ? Math.round((task.downloadedBytes / task.sizeBytes) * 100) : 0;

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

  return (
    <div
      className="space-y-3 font-sans text-xs text-[var(--text-primary)] select-none pb-1"
      style={{ direction: 'ltr' }}
    >
      <div className="flex border-b border-[var(--border-color)] select-none pl-1" style={{ direction: 'ltr' }}>
        <button
          onClick={() => {
            setActiveTab('status');
          }}
          className={tabClass('status')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          {t('progress_status_tab')}
        </button>
        <button
          onClick={() => {
            setActiveTab('speed');
          }}
          className={tabClass('speed')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          {t('progress_speed_tab')}
        </button>
        <button
          onClick={() => {
            setActiveTab('options');
          }}
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
                {task.status === 'downloading' ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">{t('progress_time_left')}</div>
              <div className="col-span-9 text-[var(--info)] font-semibold">
                {task.status === 'downloading' ? formatElapsed(task.timeLeftSeconds) : t('progress_not_running')}
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
                {task.status === 'downloading' ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
              </span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={speedLimitEnabled}
                onChange={(e) => {
                  handleToggleSpeedLimit(e.target.checked);
                }}
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
                  onChange={(e) => {
                    handleSpeedLimitValueChange(e.target.value);
                  }}
                  disabled={!speedLimitEnabled}
                  className="w-20 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-primary)] font-mono text-center text-xs py-0.5 px-2 focus:outline-none focus:border-[var(--accent-primary)] disabled:opacity-40 disabled:bg-[var(--bg-hover)] disabled:cursor-not-allowed"
                />
                <span className="text-[11px] text-[var(--text-secondary)]">KB/s</span>
              </div>
            </div>
            <button
              onClick={() => {
                setActiveTab('status');
              }}
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
                onChange={(e) => {
                  setNotifyOnComplete(e.target.checked);
                }}
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
                  onChange={(e) => {
                    setDisconnectOnComplete(e.target.checked);
                  }}
                  disabled={notifyOnComplete}
                  className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                />
                <span className="text-[var(--text-secondary)]">{t('progress_disconnect_complete')}</span>
              </label>
              <label className="col-span-12 flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={exitOnComplete}
                  onChange={(e) => {
                    setExitOnComplete(e.target.checked);
                  }}
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
                    onChange={(e) => {
                      setShutdownOnComplete(e.target.checked);
                    }}
                    disabled={notifyOnComplete}
                    className="w-3.5 h-3.5 rounded border-[var(--border-color)] bg-[var(--bg-input)] text-[var(--accent-primary)] focus:ring-0 cursor-pointer"
                  />
                  <span className="text-[var(--text-secondary)] whitespace-nowrap">{t('progress_power_action')}</span>
                </label>
                <select
                  value={shutdownAction}
                  onChange={(e) => {
                    setShutdownAction(e.target.value);
                  }}
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
                    onChange={(e) => {
                      setForceCloseProcesses(e.target.checked);
                    }}
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

      <div className="w-full h-5.5 bg-[var(--bg-input)] border border-[var(--border-color)] p-[2px] rounded-lg overflow-hidden relative shadow-inner">
        <div
          className="bg-[var(--accent-primary)] h-full transition-all duration-300 rounded-md relative shadow-[0_0_8px_var(--accent-glow)] flex items-center justify-center"
          style={{ width: `${String(progressPercent)}%` }}
        >
          {progressPercent >= 5 && (
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)] font-mono">
              {progressPercent}%
            </span>
          )}
        </div>
        {progressPercent < 5 && (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[var(--text-primary)] font-mono">
            {progressPercent}%
          </span>
        )}
      </div>

      <div className="flex items-center justify-between pt-1" style={{ direction: 'ltr' }}>
        <button
          onClick={() => {
            setShowPartInfo(!showPartInfo);
          }}
          className="px-4 py-1.5 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] active:scale-95 text-[var(--text-primary)] border border-[var(--border-color)] text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer flex items-center justify-center min-w-[140px]"
        >
          {showPartInfo ? t('progress_hide_details') : t('progress_show_details')}
        </button>

        <div className="flex items-center gap-2">
          {task.status === 'downloading' ? (
            <button
              onClick={() => {
                pauseTask(task.id);
              }}
              className="px-6 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
            >
              {t('topbar_stop')}
            </button>
          ) : task.status === 'paused' || task.status === 'error' ? (
            <button
              onClick={() => {
                resumeTask(task.id);
              }}
              className="px-6 py-1.5 bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
            >
              {t('progress_resume_btn')}
            </button>
          ) : (
            <div className="px-6 py-1.5 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-muted)] text-[11px] font-bold select-none min-w-[80px] text-center rounded-lg">
              {t('progress_finished')}
            </div>
          )}

          <button
            onClick={() => {
              if (task.status === 'downloading') {
                minimizeActiveProgressToTaskbar(task);
                return;
              }
              closeDialog();
            }}
            className="px-5 py-1.5 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] active:scale-95 text-[var(--text-primary)] border border-[var(--border-color)] text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
          >
            {t('progress_close')}
          </button>
        </div>
      </div>

      {showPartInfo && (
        <div className="pt-2.5 space-y-2 animate-in slide-in-from-top-2 duration-200">
          <div className="text-center font-bold text-[var(--text-secondary)] font-sans text-[11px]">
            {t('progress_connection_segments')}
          </div>
          <div
            className="w-full h-4 bg-[var(--bg-input)] border border-[var(--border-color)] flex rounded-lg overflow-hidden select-none"
            style={{ direction: 'ltr' }}
          >
            {task.segments.map((seg) => (
              <div
                key={seg.id}
                className="h-full flex-1 border-r border-[var(--border-color)]/40 last:border-r-0 relative bg-[var(--bg-input)]"
              >
                <div
                  className="bg-[var(--accent-primary)] opacity-85 h-full absolute top-0 left-0 transition-all duration-300"
                  style={{ width: `${String(seg.progress * 100)}%` }}
                />
                {seg.active && seg.progress < 1 && (
                  <div
                    className="w-[1.5px] bg-[var(--danger)] h-full absolute top-0 animate-pulse"
                    style={{ left: `${String(seg.progress * 100)}%` }}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="border border-[var(--border-color)] bg-[var(--bg-surface)] rounded-lg overflow-hidden max-h-40 overflow-y-auto overflow-x-hidden">
            <table
              className="w-full text-left border-collapse text-[11px] font-sans text-[var(--text-primary)] select-none"
              style={{ direction: 'ltr' }}
            >
              <thead>
                <tr className="bg-[var(--bg-sidebar)] text-[var(--text-secondary)] border-b border-[var(--border-color)] font-bold text-[10px] uppercase">
                  <th className="py-1 px-3 text-center border-r border-[var(--border-color)] w-12 font-mono">{t('progress_seg_number')}</th>
                  <th className="py-1 px-3 border-r border-[var(--border-color)] w-36">{t('progress_seg_downloaded')}</th>
                  <th className="py-1 px-3 text-left">{t('progress_seg_state')}</th>
                </tr>
              </thead>
              <tbody>
                {task.segments.map((seg) => {
                  const segTotal = seg.totalBytes || Math.round(task.sizeBytes / (task.segments.length || 8));
                  // Prefer the real per-segment byte count; the progress field is
                  // a 0..1 fraction, so only fall back to it when bytes are absent.
                  const segDownloaded = seg.downloadedBytes || Math.round(seg.progress * segTotal);
                  return (
                    <tr
                      key={seg.id}
                      className="border-b border-[var(--border-color)]/40 hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <td className="py-1 px-3 text-center border-r border-[var(--border-color)] text-[var(--text-secondary)] font-bold font-mono">
                        {seg.id}
                      </td>
                      <td className="py-1 px-3 border-r border-[var(--border-color)] text-[var(--text-primary)] font-medium font-mono">
                        {formatBytes(segDownloaded)}
                      </td>
                      <td className="py-1 px-3 text-left pr-4 font-sans font-medium text-[var(--text-secondary)]">
                        {seg.progress >= 1 ? t('progress_complete') : seg.active ? t('progress_receiving') : t('progress_idle')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
