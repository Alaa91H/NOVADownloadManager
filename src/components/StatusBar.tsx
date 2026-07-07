/* src/components/StatusBar.tsx */
import React, { useState } from 'react';
import { useAppStore } from '../state/appStore';
import { formatBytes, formatSpeed } from '../initialData';
import {
  Bell,
  BellOff,
  Gauge,
  Shield,
  Download,
  Activity,
  Check,
  AlertTriangle,
  Send,
  Server,
  Clipboard,
  Wifi,
  Video,
} from 'lucide-react';
import { novaClient } from '../api/novaClient';
import { useEngineCapabilities } from '../capabilities/EngineCapabilityContext';

export const StatusBar: React.FC = () => {
  const {
    tasks,
    selectedTaskId,
    settings,
    updateSettings,
    addToast,
    openDialog,
    isNotificationsMuted,
    setIsNotificationsMuted,
    isDegradedMode,
    activeProgressMinimizedToTaskbar,
    minimizedProgressTask,
    t,
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
  const [telegramMenuVisible, setTelegramMenuVisible] = useState(false);
  const [telegramMenuCoords, setTelegramMenuCoords] = useState({ x: 0, y: 0 });

  const caps = useEngineCapabilities();

  const statusVisible = (id: keyof typeof settings.ui.statusBar) => settings.ui.statusBar[id].visible;

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
  const isTelegramConfigured =
    settings.extra.tgEnabled && !!settings.extra.tgBotToken.trim() && !!settings.extra.tgChatId.trim();
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : null;

  const handleTelegramContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 240;
    setTelegramMenuCoords({
      x: Math.min(Math.max(10, e.clientX), Math.max(10, window.innerWidth - menuWidth - 10)),
      y: e.clientY,
    });
    setTelegramMenuVisible(true);
  };

  const toggleTelegramEnabled = () => {
    const updated = structuredClone(settings);
    updated.extra.tgEnabled = !updated.extra.tgEnabled;
    updateSettings(updated);
    setTelegramMenuVisible(false);
  };

  const testTelegram = async () => {
    try {
      await novaClient.updateTelegramConfig({
        enabled: settings.extra.tgEnabled,
        token: settings.extra.tgBotToken,
        chatId: parseInt(settings.extra.tgChatId) || 0,
        apiBase: settings.extra.tgApiBase,
        fileUploadLimitMb: settings.extra.tgFileUploadLimitMb,
      });
      const result = await novaClient.testTelegram();
      addToast(
        result.ok ? 'success' : 'error',
        t('settings_toast_telegram_test'),
        result.ok ? t('settings_toast_telegram_ok') : result.error || t('settings_toast_telegram_fail'),
      );
    } catch (error) {
      addToast(
        'error',
        t('settings_toast_telegram_test'),
        error instanceof Error ? error.message : t('settings_toast_telegram_fail'),
      );
    } finally {
      setTelegramMenuVisible(false);
    }
  };

  const sendSelectedFile = async () => {
    if (!selectedTask || selectedTask.status !== 'completed' || !selectedTask.savePath) {
      addToast('warning', t('telegram_send_file_title'), t('telegram_send_file_no_file'));
      setTelegramMenuVisible(false);
      return;
    }
    try {
      const result = await novaClient.sendTelegramFile({
        path: selectedTask.savePath,
        caption: `NOVA: ${selectedTask.name}`,
      });
      addToast(
        result.ok ? 'success' : 'error',
        t('telegram_send_file_title'),
        result.ok ? t('telegram_send_file_ok') : result.error || t('telegram_send_file_failed'),
      );
    } catch (error) {
      addToast(
        'error',
        t('telegram_send_file_title'),
        error instanceof Error ? error.message : t('telegram_send_file_failed'),
      );
    } finally {
      setTelegramMenuVisible(false);
    }
  };

  return (
    <footer
      className="bg-[var(--bg-sidebar)] border-t border-[var(--border-color)] h-9 px-2 flex items-center justify-between gap-1 text-[11px] font-semibold text-[var(--text-secondary)] select-none shrink-0"
      style={{ direction: 'ltr' }}
    >
      {/* Right side: Real-time speed, counts, and sizes */}
      <div className="flex items-center gap-2 min-w-0 overflow-x-auto scrollbar-none">
        {/* Total Speed */}
        {statusVisible('speed') && (
          <div className="flex items-center gap-1.5" title={t('statusbar_speed_tip')}>
            <Activity className="w-3.5 h-3.5 text-emerald-500 animate-pulse shrink-0" />
            <span className="text-[10px] text-[var(--text-primary)] font-mono font-bold">
              {formatSpeed(totalSpeed)}
            </span>
          </div>
        )}

        {statusVisible('speed') && statusVisible('counts') && <div className="h-4 w-px bg-[var(--border-color)]" />}

        {/* Downloading and Total Count */}
        {statusVisible('counts') && (
          <div className="flex items-center gap-1.5" title={t('statusbar_counts_tip')}>
            <Download className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>
              {t('statusbar_active')} <strong className="text-[var(--text-primary)] font-mono">{activeCount}</strong>
              <span className="text-[var(--text-muted)] mx-1">/</span>
              {t('statusbar_total')} <strong className="text-[var(--text-primary)] font-mono">{totalCount}</strong>
            </span>
          </div>
        )}

        {statusVisible('downloaded') && <div className="h-4 w-px bg-[var(--border-color)] hidden md:block" />}

        {/* Total Downloaded Size */}
        {statusVisible('downloaded') && (
          <div className="items-center gap-1.5 hidden md:flex" title={t('statusbar_downloaded_tip')}>
            <span className="text-[var(--text-muted)]">{t('statusbar_downloaded')}</span>
            <span className="text-[10px] font-mono font-bold text-[var(--text-primary)]">
              {formatBytes(totalDownloaded)}
            </span>
            <span className="text-[var(--text-muted)]">{t('statusbar_of')}</span>
            <span className="text-[10px] font-mono font-bold text-[var(--text-muted)]">{formatBytes(totalSize)}</span>
          </div>
        )}
      </div>

      {/* Left side: Integrated Actions (Notification, speed limiter, extension integration) */}
      <div className="flex items-center gap-1 shrink-0">
        {statusVisible('daemon') && (
          <button
            onClick={() => {
              addToast(
                isDegradedMode ? 'warning' : 'info',
                isDegradedMode ? t('statusbar_degraded_title') : t('statusbar_daemon_title'),
                isDegradedMode ? t('statusbar_degraded_desc') : t('statusbar_daemon_ok'),
              );
            }}
            className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center ${
              isDegradedMode ? 'text-amber-500 animate-pulse' : 'text-emerald-500 hover:text-emerald-400'
            }`}
            title={isDegradedMode ? t('statusbar_degraded_tip') : t('statusbar_daemon_tip')}
          >
            <Server className="w-3.5 h-3.5" />
          </button>
        )}

        {!statusVisible('daemon') && isDegradedMode && (
          <button
            onClick={() => {
              addToast('warning', t('statusbar_degraded_title'), t('statusbar_degraded_desc'));
            }}
            className="p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center text-amber-500 animate-pulse"
            title={t('statusbar_degraded_tip')}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
          </button>
        )}

        {!caps.loading && (
          <div className="flex items-center gap-0.5 ml-1">
            <button
              onClick={() => {
                addToast(caps.directReady ? 'success' : 'warning', 'Direct Engine', caps.directReady ? 'Ready' : caps.directBlockedReason() || 'Unavailable');
              }}
              className={`p-1 rounded transition-all cursor-pointer flex items-center justify-center ${
                caps.directReady ? 'text-emerald-500' : 'text-rose-500'
              }`}
              title={caps.directReady ? 'Direct download engine ready' : caps.directBlockedReason() || 'Direct download engine unavailable'}
            >
              <Wifi className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                addToast(caps.mediaReady ? 'success' : 'warning', 'Media Engine', caps.mediaReady ? 'Ready' : caps.mediaBlockedReason() || 'Unavailable');
              }}
              className={`p-1 rounded transition-all cursor-pointer flex items-center justify-center ${
                caps.mediaReady ? 'text-emerald-500' : 'text-rose-500'
              }`}
              title={caps.mediaReady ? 'Media download engine ready' : caps.mediaBlockedReason() || 'Media download engine unavailable'}
            >
              <Video className="w-3 h-3" />
            </button>
            {caps.ffmpegReady && (
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full" title="FFmpeg ready" />
            )}
            {!caps.ffmpegReady && caps.mediaReady && (
              <span className="w-1.5 h-1.5 bg-rose-500 rounded-full" title="FFmpeg not available" />
            )}
          </div>
        )}

        {activeProgressMinimizedToTaskbar && minimizedRealTask && (
          <button
            onClick={() => {
              openDialog('activeProgress', minimizedRealTask);
            }}
            className="flex items-center gap-2 px-2.5 h-6 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded cursor-pointer transition-all duration-200 text-[10px] font-bold shadow-sm max-w-[200px] mr-2"
            title={t('statusbar_restore_progress_tip')}
            dir="ltr"
          >
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse shrink-0" />
            <span className="truncate max-w-[100px]">{minimizedRealTask.name}</span>
            <span className="text-white font-mono">{minimizedProgressPercent}%</span>
          </button>
        )}

        {/* 1. Browser Integration Shield */}
        {statusVisible('browser') && (
          <button
            onClick={() => {
              openDialog('browserIntegration');
            }}
            className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center ${
              isExtensionConnected ? 'text-emerald-500 hover:text-emerald-400' : 'text-rose-500 hover:text-rose-400'
            }`}
            title={t('nav_browser_integration')}
          >
            <Shield className="w-3.5 h-3.5" />
          </button>
        )}

        {statusVisible('telegram') && (
          <button
            onClick={() => {
              openDialog('settings', { tab: 'integrations_automation', subTab: 'telegram' });
            }}
            onContextMenu={handleTelegramContextMenu}
            className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center ${
              isTelegramConfigured ? 'text-emerald-500 hover:text-emerald-400' : 'text-rose-500 hover:text-rose-400'
            }`}
            title={isTelegramConfigured ? t('statusbar_telegram_connected') : t('statusbar_telegram_disconnected')}
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        )}

        {statusVisible('clipboard') && (
          <button
            onClick={() => {
              const updated = structuredClone(settings);
              updated.general.monitorClipboard = !updated.general.monitorClipboard;
              updateSettings(updated);
            }}
            className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer flex items-center justify-center ${
              settings.general.monitorClipboard
                ? 'text-emerald-500 hover:text-emerald-400'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title={settings.general.monitorClipboard ? t('statusbar_clipboard_on') : t('statusbar_clipboard_off')}
          >
            <Clipboard className="w-3.5 h-3.5" />
          </button>
        )}

        {/* 2. Speed Limiter Inline Widget */}
        {statusVisible('speedLimiter') && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleSpeedClick}
              className={`p-1.5 rounded-lg cursor-pointer transition-all flex items-center justify-center hover:bg-[var(--bg-hover)] ${
                settings.connection.speedLimiter.enabled
                  ? 'text-amber-500 drop-shadow-[0_0_4px_rgba(245,158,11,0.3)] font-bold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={t('speed_limiter')}
            >
              <Gauge className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* 3. Notification Bell */}
        {statusVisible('notifications') && (
          <button
            onClick={() => {
              setIsNotificationsMuted(!isNotificationsMuted);
              if (isNotificationsMuted) {
                addToast('info', t('statusbar_notifications_title'), t('statusbar_notifications_on'));
              } else {
                addToast('warning', t('statusbar_notifications_title'), t('statusbar_notifications_off'));
              }
            }}
            className={`p-1.5 hover:bg-[var(--bg-hover)] rounded transition-all cursor-pointer relative flex items-center justify-center ${
              isNotificationsMuted
                ? 'text-rose-500 hover:text-rose-400'
                : 'text-[var(--text-secondary)] hover:text-amber-500'
            }`}
            title={
              isNotificationsMuted ? t('statusbar_notifications_muted_tip') : t('statusbar_notifications_active_tip')
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
        )}
      </div>

      {telegramMenuVisible && (
        <>
          <div
            className="fixed inset-0 z-[100] cursor-default"
            onClick={() => {
              setTelegramMenuVisible(false);
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: `${String(telegramMenuCoords.x)}px`,
              bottom: `${String(Math.max(42, window.innerHeight - telegramMenuCoords.y + 8))}px`,
              maxWidth: 'min(92vw, 240px)',
            }}
            className="z-[101] min-w-[210px] w-[240px] bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] rounded-lg shadow-2xl py-1 text-left animate-in fade-in slide-in-from-bottom-2 duration-100 font-bold"
            dir="ltr"
          >
            <div className="px-3 py-1.5 text-[10px] text-[var(--text-secondary)] border-b border-[var(--border-color)] font-extrabold">
              {t('statusbar_telegram_menu')}
            </div>
            <button
              onClick={toggleTelegramEnabled}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between cursor-pointer font-bold"
            >
              <span>{settings.extra.tgEnabled ? t('statusbar_telegram_disable') : t('statusbar_telegram_enable')}</span>
              {settings.extra.tgEnabled && <Check className="w-3.5 h-3.5 text-emerald-500" />}
            </button>
            <button
              onClick={() => {
                void testTelegram();
              }}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer font-bold"
            >
              {t('settings_tg_send_test')}
            </button>
            <button
              onClick={() => {
                void sendSelectedFile();
              }}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!selectedTask || selectedTask.status !== 'completed' || !selectedTask.savePath}
            >
              {t('telegram_send_selected_file')}
            </button>
            <button
              onClick={() => {
                setTelegramMenuVisible(false);
                openDialog('settings', { tab: 'integrations_automation', subTab: 'telegram' });
              }}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer font-bold"
            >
              {t('nav_settings')}
            </button>
          </div>
        </>
      )}

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
              {t('statusbar_speed_limit')}
              {settings.connection.speedLimiter.enabled && (
                <div className="text-amber-500 font-bold mt-0.5 text-[10px] leading-tight break-words">
                  {t('statusbar_speed_current')} {formatSpeed(settings.connection.speedLimiter.maxSpeedKbs * 1024)}
                </div>
              )}
            </div>

            <button
              onClick={() => {
                const updated = structuredClone(settings);
                updated.connection.speedLimiter.enabled = !updated.connection.speedLimiter.enabled;
                updateSettings(updated);
                setSpeedMenuVisible(false);
              }}
              className="w-full text-left px-4 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-between cursor-pointer font-bold"
            >
              <div className="flex items-center gap-2">
                <Gauge className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span>{t('statusbar_enable_limiter')}</span>
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
                    const updated = structuredClone(settings);
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
                <span>{t('statusbar_custom_speed')}</span>
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
                    placeholder={manualSpeedUnit === 'KB' ? t('statusbar_speed_kb_ph') : t('statusbar_speed_mb_ph')}
                    className="w-full bg-[var(--bg-surface)] border border-[var(--border-color)] rounded px-2 py-1 text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent-primary)] min-w-[70px]"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = parseFloat(manualSpeedInput);
                        if (!isNaN(val) && val > 0) {
                          const speedKbs = manualSpeedUnit === 'MB' ? Math.round(val * 1024) : Math.round(val);
                          const updated = structuredClone(settings);
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
                    {t('btn_cancel')}
                  </button>
                  <button
                    onClick={() => {
                      const val = parseFloat(manualSpeedInput);
                      if (!isNaN(val) && val > 0) {
                        const speedKbs = manualSpeedUnit === 'MB' ? Math.round(val * 1024) : Math.round(val);
                        const updated = structuredClone(settings);
                        updated.connection.speedLimiter.enabled = true;
                        updated.connection.speedLimiter.maxSpeedKbs = speedKbs;
                        updateSettings(updated);
                      }
                      setShowManualInput(false);
                      setSpeedMenuVisible(false);
                    }}
                    className="bg-[var(--accent-primary)] text-white font-bold text-[10px] px-2.5 py-1 rounded hover:opacity-90 transition-opacity cursor-pointer shrink-0"
                  >
                    {t('statusbar_apply')}
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
