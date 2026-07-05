/* src/components/StatusBar.tsx */
import React, { useState } from 'react';
import { useAppStore } from '../state/appStore';
import { formatBytes, formatSpeed } from '../initialData';
import { Bell, BellOff, Gauge, Shield, Download, Activity, Check, AlertTriangle } from 'lucide-react';

export const StatusBar: React.FC = () => {
  const {
    tasks,
    settings,
    updateSettings,
    addToast,
    openDialog,
    isNotificationsMuted,
    setIsNotificationsMuted,
    isDegradedMode,
    activeProgressMinimizedToTaskbar,
    minimizedProgressTask,
  } = useAppStore();

  const minimizedRealTask = minimizedProgressTask
    ? tasks.find((t) => t.id === minimizedProgressTask.id) || minimizedProgressTask
    : null;

  const minimizedProgressPercent =
    minimizedRealTask && minimizedRealTask.sizeBytes > 0
      ? Math.round((minimizedRealTask.downloadedBytes / minimizedRealTask.sizeBytes) * 100)
      : 0;

  const [speedMenuVisible, setSpeedMenuVisible] = useState(false);
  const [speedMenuCoords, setSpeedMenuCoords] = useState({ x: 0, y: 0 });
  const [manualSpeedInput, setManualSpeedInput] = useState('');
  const [manualSpeedUnit, setManualSpeedUnit] = useState<'KB' | 'MB'>('KB');
  const [showManualInput, setShowManualInput] = useState(false);

  const handleSpeedClick = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const menuWidth = 260;
    const viewportWidth = window.innerWidth;
    const nextLeft = Math.min(Math.max(10, rect.left), Math.max(10, viewportWidth - menuWidth - 10));
    setSpeedMenuCoords({
      x: nextLeft,
      y: rect.top,
    });
    setSpeedMenuVisible((prev) => !prev);
    setShowManualInput(false);
  };

  // 1. Calculate active download counts, total counts, downloaded size and speed
  const downloadingTasks = tasks.filter((t) => t.status === 'downloading');
  const activeCount = downloadingTasks.length;
  const totalCount = tasks.length;

  const totalSpeed = downloadingTasks.reduce((acc, t) => acc + t.speedBytesPerSec, 0);

  const totalDownloaded = tasks.reduce((acc, t) => acc + t.downloadedBytes, 0);
  const totalSize = tasks.reduce((acc, t) => acc + t.sizeBytes, 0);

  // 2. Check if browser extension integration is connected (at least one browser integration enabled)
  const isExtensionConnected = Object.values(settings.general.integrateWithBrowsers).some((val) => val);

  return (
    <footer
      className="bg-[var(--bg-sidebar)] border-t border-[var(--border-color)] h-9 px-2 flex items-center justify-between gap-1 text-[11px] font-semibold text-[var(--text-secondary)] select-none shrink-0"
      style={{ direction: 'ltr' }}
    >
      {/* Right side: Real-time speed, counts, and sizes */}
      <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-none">
        {/* Total Speed */}
        <div className="flex items-center gap-1.5" title="Total speed of all active downloads">
          <Activity className="w-3.5 h-3.5 text-emerald-500 animate-pulse shrink-0" />
          <span className="text-[10px] text-[var(--text-primary)] font-mono font-bold">{formatSpeed(totalSpeed)}</span>
        </div>

        <div className="h-4 w-px bg-[var(--border-color)]" />

        {/* Downloading and Total Count */}
        <div className="flex items-center gap-1.5" title="Active and total downloads">
          <Download className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span>
            Active: <strong className="text-[var(--text-primary)] font-mono">{activeCount}</strong>
            <span className="text-[var(--text-muted)] mx-1">/</span>
            Total: <strong className="text-[var(--text-primary)] font-mono">{totalCount}</strong>
          </span>
        </div>

        <div className="h-4 w-px bg-[var(--border-color)] hidden md:block" />

        {/* Total Downloaded Size */}
        <div className="items-center gap-1.5 hidden md:flex" title="Downloaded data size">
          <span className="text-[var(--text-muted)]">Downloaded:</span>
          <span className="text-[10px] font-mono font-bold text-[var(--text-primary)]">
            {formatBytes(totalDownloaded)}
          </span>
          <span className="text-[var(--text-muted)]">of</span>
          <span className="text-[10px] font-mono font-bold text-[var(--text-muted)]">{formatBytes(totalSize)}</span>
        </div>
      </div>

      {/* Left side: Integrated Actions (Notification, speed limiter, extension integration) */}
      <div className="flex items-center gap-1 shrink-0">
        {isDegradedMode && (
          <button
            onClick={() => {
              addToast(
                'warning',
                'Degraded Mode',
                'Download engines are not fully ready. Some features may be unavailable.',
              );
            }}
            className="p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center text-amber-500 animate-pulse"
            title="Daemon is in degraded mode – click for details"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
          </button>
        )}

        {activeProgressMinimizedToTaskbar && minimizedRealTask && (
          <button
            onClick={() => {
              openDialog('activeProgress', minimizedRealTask);
            }}
            className="flex items-center gap-2 px-2.5 h-6 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded cursor-pointer transition-all duration-200 text-[10px] font-bold shadow-sm max-w-[200px] mr-2"
            title="NOVA Download Manager - Progress window (click to restore)"
            dir="ltr"
          >
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse shrink-0" />
            <span className="truncate max-w-[100px]">{minimizedRealTask.name}</span>
            <span className="text-white font-mono">{minimizedProgressPercent}%</span>
          </button>
        )}

        {/* 1. Browser Integration Shield */}
        <button
          onClick={() => {
            openDialog('browserIntegration');
          }}
          className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center ${
            isExtensionConnected ? 'text-emerald-500 hover:text-emerald-400' : 'text-rose-500 hover:text-rose-400'
          }`}
          title="Browser integration settings"
        >
          <Shield className="w-3.5 h-3.5" />
        </button>

        {/* 2. Speed Limiter Inline Widget */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleSpeedClick}
            className={`p-1.5 rounded-lg cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--bg-hover)] ${
              settings.connection.speedLimiter.enabled
                ? 'text-amber-500 drop-shadow-[0_0_4px_rgba(245,158,11,0.3)] font-bold'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Speed limiter settings"
          >
            <Gauge className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 3. Notification Bell */}
        <button
          onClick={() => {
            setIsNotificationsMuted(!isNotificationsMuted);
            if (isNotificationsMuted) {
              addToast('info', 'Notifications', 'Notifications enabled.');
            } else {
              addToast('warning', 'Notifications', 'Notifications muted.');
            }
          }}
          className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer relative flex items-center justify-center ${
            isNotificationsMuted
              ? 'text-rose-500 hover:text-rose-400'
              : 'text-[var(--text-secondary)] hover:text-amber-500'
          }`}
          title={
            isNotificationsMuted
              ? 'Notifications are muted (click to enable)'
              : 'Notifications are active (click to mute)'
          }
        >
          {isNotificationsMuted ? (
            <BellOff className="w-3.5 h-3.5" />
          ) : (
            <>
              <Bell className="w-3.5 h-3.5" />
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-rose-500 rounded-full" />
            </>
          )}
        </button>
      </div>

      {speedMenuVisible && (
        <>
          {/* Context Menu Backdrop */}
          <div
            className="fixed inset-0 z-[100] cursor-default"
            onClick={() => {
              setSpeedMenuVisible(false);
            }}
          />
          {/* Context Menu Dropup */}
          <div
            style={{
              position: 'fixed',
              bottom: '42px',
              left: `${String(speedMenuCoords.x)}px`,
              maxWidth: 'min(92vw, 260px)',
            }}
            className="z-[101] min-w-[190px] w-[260px] max-w-[min(92vw,260px)] bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg shadow-2xl py-1 text-left animate-in fade-in slide-in-from-bottom-2 duration-100 font-bold"
            dir="ltr"
          >
            <div className="px-3 py-1.5 text-[10px] text-[var(--text-secondary)] border-b border-[var(--border-color)] font-extrabold text-center break-words">
              Speed Limit
              {settings.connection.speedLimiter.enabled && (
                <div className="text-amber-500 font-bold mt-0.5 text-[10px] leading-tight break-words">
                  Current: {formatSpeed(settings.connection.speedLimiter.maxSpeedKbs * 1024)}
                </div>
              )}
            </div>

            <button
              onClick={() => {
                const updated = { ...settings };
                updated.connection.speedLimiter.enabled = !updated.connection.speedLimiter.enabled;
                updateSettings(updated);
                setSpeedMenuVisible(false);
              }}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between cursor-pointer font-bold"
            >
              <div className="flex items-center gap-2">
                <Gauge className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>Enable Speed Limiter</span>
              </div>
              {settings.connection.speedLimiter.enabled && <Check className="w-3.5 h-3.5 text-emerald-500" />}
            </button>

            <div className="h-px bg-[var(--border-color)] my-1" />

            {[
              { label: '500 KB/s', value: 500 },
              { label: '1 MB/s', value: 1024 },
              { label: '2 MB/s', value: 2048 },
              { label: '5 MB/s', value: 5120 },
              { label: '10 MB/s', value: 10240 },
              { label: '20 MB/s', value: 20480 },
            ].map((preset) => {
              const isActive =
                settings.connection.speedLimiter.enabled &&
                settings.connection.speedLimiter.maxSpeedKbs === preset.value;
              return (
                <button
                  key={preset.value}
                  onClick={() => {
                    const updated = { ...settings };
                    updated.connection.speedLimiter.enabled = true;
                    updated.connection.speedLimiter.maxSpeedKbs = preset.value;
                    updateSettings(updated);
                    setSpeedMenuVisible(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between cursor-pointer font-bold font-mono"
                >
                  <span>{preset.label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                </button>
              );
            })}

            <div className="h-px bg-[var(--border-color)] my-1" />

            <button
              onClick={() => {
                const nextShow = !showManualInput;
                setShowManualInput(nextShow);
                if (nextShow) {
                  const curKbs = settings.connection.speedLimiter.maxSpeedKbs || 0;
                  if (curKbs > 0 && curKbs % 1024 === 0) {
                    setManualSpeedInput(String(curKbs / 1024));
                    setManualSpeedUnit('MB');
                  } else {
                    setManualSpeedInput(String(curKbs || ''));
                    setManualSpeedUnit('KB');
                  }
                }
              }}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between cursor-pointer font-bold"
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                <span>Set custom speed...</span>
              </div>
            </button>

            {showManualInput && (
              <div className="px-3 py-2 flex flex-col gap-2 border-t border-[var(--border-color)] mt-1 animate-in slide-in-from-top-1 duration-100">
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    value={manualSpeedInput}
                    onChange={(e) => {
                      setManualSpeedInput(e.target.value);
                    }}
                    placeholder={manualSpeedUnit === 'KB' ? 'Speed KB/s' : 'Speed MB/s'}
                    className="w-full bg-[var(--bg-surface)] border border-[var(--border-color)] rounded px-2 py-1 text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent-primary)] min-w-[70px]"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = parseFloat(manualSpeedInput);
                        if (!isNaN(val) && val > 0) {
                          const speedKbs = manualSpeedUnit === 'MB' ? Math.round(val * 1024) : Math.round(val);
                          const updated = { ...settings };
                          updated.connection.speedLimiter.enabled = true;
                          updated.connection.speedLimiter.maxSpeedKbs = speedKbs;
                          updateSettings(updated);
                        }
                        setShowManualInput(false);
                        setSpeedMenuVisible(false);
                      }
                    }}
                  />

                  {/* Unit toggle buttons */}
                  <div className="flex rounded border border-[var(--border-color)] overflow-hidden shrink-0 h-[26px]">
                    <button
                      type="button"
                      onClick={() => {
                        setManualSpeedUnit('KB');
                      }}
                      className={`px-2 text-[9px] font-bold cursor-pointer transition-colors ${
                        manualSpeedUnit === 'KB'
                          ? 'bg-[var(--accent-primary)] text-white'
                          : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      KB
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setManualSpeedUnit('MB');
                      }}
                      className={`px-2 text-[9px] font-bold cursor-pointer transition-colors border-r border-[var(--border-color)]/20 ${
                        manualSpeedUnit === 'MB'
                          ? 'bg-[var(--accent-primary)] text-white'
                          : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      MB
                    </button>
                  </div>
                </div>

                <div className="flex justify-end gap-1.5">
                  <button
                    onClick={() => {
                      setShowManualInput(false);
                    }}
                    className="px-2.5 py-1 text-[10px] font-bold rounded text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      const val = parseFloat(manualSpeedInput);
                      if (!isNaN(val) && val > 0) {
                        const speedKbs = manualSpeedUnit === 'MB' ? Math.round(val * 1024) : Math.round(val);
                        const updated = { ...settings };
                        updated.connection.speedLimiter.enabled = true;
                        updated.connection.speedLimiter.maxSpeedKbs = speedKbs;
                        updateSettings(updated);
                      }
                      setShowManualInput(false);
                      setSpeedMenuVisible(false);
                    }}
                    className="bg-[var(--accent-primary)] text-white font-bold text-[10px] px-2.5 py-1 rounded hover:opacity-90 transition-opacity cursor-pointer shrink-0"
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </footer>
  );
};
