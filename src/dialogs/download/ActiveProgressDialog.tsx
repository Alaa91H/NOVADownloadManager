/* src/dialogs/download/ActiveProgressDialog.tsx */
import React, { useState } from 'react';
import { useAppStore } from '../../state/appStore';
import { DownloadItem } from '../../types/desktop-ui.types';
import { formatBytes } from '../../initialData';

export const ActiveProgressDialog: React.FC = () => {
  const { dialog, closeDialog, tasks, pauseTask, resumeTask, settings, updateSettings, t } = useAppStore();
  const taskFromPayload = dialog.payload as DownloadItem;
  const task = tasks.find((t) => t.id === taskFromPayload.id) || taskFromPayload;

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

  const formatSpeed = (bytesPerSec: number) => `${formatBytes(bytesPerSec)}/s`;

  const formatTime = (seconds: number) => {
    if (!seconds || seconds <= 0) return 'Unknown';
    if (seconds < 60) return `${String(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    if (minutes < 60) return `${String(minutes)}m ${String(remaining)}s`;
    const hours = Math.floor(minutes / 60);
    return `${String(hours)}h ${String(minutes % 60)}m`;
  };

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
          Status
        </button>
        <button
          onClick={() => {
            setActiveTab('speed');
          }}
          className={tabClass('speed')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          Speed Limit
        </button>
        <button
          onClick={() => {
            setActiveTab('options');
          }}
          className={tabClass('options')}
          style={{ borderRadius: '4px 4px 0 0' }}
        >
          Completion
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
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">Status:</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium capitalize">{task.status}</div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">File size:</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium">{formatBytes(task.sizeBytes)}</div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">Downloaded:</div>
              <div className="col-span-9 text-[var(--text-primary)] font-medium">
                {formatBytes(task.downloadedBytes)} ({progressPercent}%)
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">Transfer rate:</div>
              <div className="col-span-9 text-[var(--accent-primary)] font-bold">
                {task.status === 'downloading' ? formatSpeed(task.speedBytesPerSec) : '0 B/s'}
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">Time left:</div>
              <div className="col-span-9 text-sky-400 font-semibold">
                {task.status === 'downloading' ? formatTime(task.timeLeftSeconds) : 'Not running'}
              </div>
              <div className="col-span-3 text-[var(--text-secondary)] font-semibold">Resume:</div>
              <div className="col-span-9 text-[var(--accent-primary)] font-bold">
                {task.resumable ? 'Supported' : 'Not supported'}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'speed' && (
          <div className="space-y-3.5 animate-in fade-in duration-150">
            <div className="flex justify-between items-center text-xs">
              <span className="text-[var(--text-secondary)] font-semibold">Transfer rate:</span>
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
              <span className="text-xs text-[var(--text-primary)]">Use global speed limit</span>
            </label>
            <div className="space-y-1">
              <span className="text-[11px] text-[var(--text-secondary)] block">Maximum speed:</span>
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
              Hide Tab
            </button>
          </div>
        )}

        {activeTab === 'options' && (
          <div className="space-y-2 animate-in fade-in duration-150">
            <div className="flex justify-between items-center text-xs text-[var(--text-secondary)]">
              <span className="font-semibold shrink-0">Save to:</span>
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
              <span className="text-xs text-[var(--text-primary)]">Notify when complete</span>
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
                <span className="text-[var(--text-secondary)]">Disconnect when complete</span>
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
                <span className="text-[var(--text-secondary)]">Exit NOVA when complete</span>
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
                  <span className="text-[var(--text-secondary)] whitespace-nowrap">Power action when complete</span>
                </label>
                <select
                  value={shutdownAction}
                  onChange={(e) => {
                    setShutdownAction(e.target.value);
                  }}
                  disabled={notifyOnComplete || !shutdownOnComplete}
                  className="bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-primary)] text-[10px] md:text-xs px-2 py-0.5 rounded focus:outline-none focus:border-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="Shutdown computer">Shutdown computer</option>
                  <option value="Restart computer">Restart computer</option>
                  <option value="Sleep">Sleep</option>
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
                  <span className="text-[var(--text-secondary)]">Force close apps</span>
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
          {showPartInfo ? 'Hide Details <<' : 'Show Details >>'}
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
              Resume
            </button>
          ) : (
            <div className="px-6 py-1.5 bg-[var(--bg-input)] border border-[var(--border-color)] text-[var(--text-muted)] text-[11px] font-bold select-none min-w-[80px] text-center rounded-lg">
              Finished
            </div>
          )}

          <button
            onClick={closeDialog}
            className="px-5 py-1.5 bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] active:scale-95 text-[var(--text-primary)] border border-[var(--border-color)] text-[11px] font-bold rounded-lg shadow-sm transition-all cursor-pointer min-w-[80px]"
          >
            Close
          </button>
        </div>
      </div>

      {showPartInfo && (
        <div className="pt-2.5 space-y-2 animate-in slide-in-from-top-2 duration-200">
          <div className="text-center font-bold text-[var(--text-secondary)] font-sans text-[11px]">
            Connection segments
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
                  style={{ width: `${String(seg.progress)}%` }}
                />
                {seg.active && seg.progress < 100 && (
                  <div
                    className="w-[1.5px] bg-rose-500 h-full absolute top-0 animate-pulse"
                    style={{ left: `${String(seg.progress)}%` }}
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
                  <th className="py-1 px-3 text-center border-r border-[var(--border-color)] w-12 font-mono">N.</th>
                  <th className="py-1 px-3 border-r border-[var(--border-color)] w-36">Downloaded</th>
                  <th className="py-1 px-3 text-left">State</th>
                </tr>
              </thead>
              <tbody>
                {task.segments.map((seg) => {
                  const segTotal = seg.totalBytes || Math.round(task.sizeBytes / (task.segments.length || 8));
                  const segDownloaded = Math.round((seg.progress / 100) * segTotal);
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
                        {seg.progress === 100 ? 'Complete' : seg.active ? 'Receiving data' : 'Idle'}
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
