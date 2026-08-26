/* src/dialogs/settings/sections/LoggingSettings.tsx */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch } from '../../../components/primitives';
import { ScrollText, Download, FileText, RefreshCw, FileSearch, GitBranch } from 'lucide-react';
import {
  logger,
  formatLogTimestamp,
  levelColor,
  levelBadgeBg,
  downloadAsFile,
  exportLogsAsJson,
  exportLogsAsText,
  type LogLevel,
} from '../../../utils/logger';
import {
  novaClient,
  type BackendLogEntry,
  type BackendLogFileResponse,
  type BackendTaskSummary,
  type BackendTaskTrace,
} from '../../../api/novaClient';
import { useI18n } from '../../../store/selectors';
import { tauriClient } from '../../../api/tauriClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

type LogSource = 'frontend' | 'backend';

/** Map a daemon level string (TRACE/DEBUG/INFO/WARN/ERROR) onto the UI palette. */
function toUiLevel(level: string): LogLevel {
  switch (level.toLowerCase()) {
    case 'trace':
    case 'debug':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}

/** RFC 3339 UTC timestamp → `HH:mm:ss` for compact display. */
function formatBackendTimestamp(ts: string): string {
  const m = ts.match(/T(\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : ts;
}

function renderContext(entry: BackendLogEntry): string {
  if (!entry.context || entry.context.length === 0) return '';
  return entry.context.map((c) => `${c.key}=${c.value}`).join(' ');
}

/** Epoch millis → `HH:mm:ss.mmm` (UTC) for trace timelines. */
function formatBackendMs(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const mmm = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export const LoggingSettings: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const t = useI18n();
  const [source, setSource] = useState<LogSource>('frontend');
  const [logs, setLogs] = useState(() => logger.getBufferSlice(undefined, undefined, 300));
  const [backendLogs, setBackendLogs] = useState<BackendLogEntry[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [backendLevel, setBackendLevel] = useState('');
  const [filterLevel, setFilterLevel] = useState<LogLevel | ''>('');
  const [filterSource, setFilterSource] = useState('');
  const [searchText, setSearchText] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const [logFile, setLogFile] = useState<BackendLogFileResponse | null>(null);
  const [logFileName, setLogFileName] = useState('');
  const [grepText, setGrepText] = useState('');
  const [fileContext, setFileContext] = useState(3);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const [taskSummaries, setTaskSummaries] = useState<BackendTaskSummary[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState('');
  const [taskTrace, setTaskTrace] = useState<BackendTaskTrace | null>(null);

  const refreshLogs = useCallback(() => {
    const filtered = logger.getBufferSlice(filterLevel || undefined, filterSource || undefined, 500);
    setLogs(filtered);
  }, [filterLevel, filterSource]);

  const refreshBackendLogs = useCallback(async () => {
    try {
      const data = await novaClient.getLogs(500, filterLevel || undefined);
      setBackendLogs(data.entries);
      setBackendLevel(data.level);
      setBackendError(null);
    } catch (err) {
      setBackendError(err instanceof Error ? err.message : 'daemon unreachable');
    }
  }, [filterLevel]);

  useEffect(() => {
    const interval = setInterval(refreshLogs, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [refreshLogs]);

  useEffect(() => {
    if (source !== 'backend') return;
    const first = setTimeout(() => void refreshBackendLogs(), 0);
    const interval = setInterval(() => void refreshBackendLogs(), 2000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [source, refreshBackendLogs]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, backendLogs, autoScroll]);

  useEffect(() => {
    const loggingEnabled = settings.advanced.loggingEnabled;
    logger.setEnabled(loggingEnabled);
    const logLevel = settings.advanced.logLevel;
    logger.setMinLevel(logLevel);
  }, [settings.advanced.loggingEnabled, settings.advanced.logLevel]);

  // Mirror the user-facing log level to the daemon so the rotating file and
  // `/api/logs` share the same verbosity.
  useEffect(() => {
    novaClient.setLogLevel(settings.advanced.logLevel).catch(() => {
      // daemon not reachable — keep frontend-only logging
    });
  }, [settings.advanced.logLevel]);

  const loadLogFile = useCallback(async () => {
    if (source !== 'backend') return;
    setFileLoading(true);
    setFileError(null);
    try {
      const data = await novaClient.getLogFile({
        file: logFileName || undefined,
        lines: 300,
        grep: grepText.trim() || undefined,
        context: fileContext,
        maxMatches: 150,
      });
      setLogFile(data);
    } catch (err) {
      setFileError(err instanceof Error ? err.message : 'could not read log file');
    } finally {
      setFileLoading(false);
    }
  }, [source, logFileName, grepText, fileContext]);

  useEffect(() => {
    if (source !== 'backend') return;
    const first = setTimeout(() => void loadLogFile(), 0);
    return () => {
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, logFileName]);

  const refreshTaskSummaries = useCallback(async () => {
    try {
      const data = await novaClient.getLogTasks();
      setTaskSummaries(data.tasks);
      setTasksError(null);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : 'could not load task summaries');
    }
  }, []);

  useEffect(() => {
    if (source !== 'backend') return;
    const first = setTimeout(() => void refreshTaskSummaries(), 0);
    const interval = setInterval(() => void refreshTaskSummaries(), 2000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [source, refreshTaskSummaries]);

  const loadTaskTrace = useCallback(async (taskId: string) => {
    if (!taskId) {
      setTaskTrace(null);
      return;
    }
    try {
      const data = await novaClient.getTaskTrace(taskId, 2000);
      setTaskTrace(data.trace);
    } catch (err) {
      setTaskTrace(null);
      setTasksError(err instanceof Error ? err.message : 'could not load task trace');
    }
  }, []);

  useEffect(() => {
    if (source !== 'backend') return;
    const first = setTimeout(() => void loadTaskTrace(selectedTask), 0);
    return () => {
      clearTimeout(first);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, selectedTask]);

  const filteredBackendLogs = searchText
    ? backendLogs.filter(
        (e) =>
          e.message.toLowerCase().includes(searchText.toLowerCase()) ||
          renderContext(e).toLowerCase().includes(searchText.toLowerCase()),
      )
    : backendLogs;

  const filteredLogs = searchText
    ? logs.filter((e) => e.message.toLowerCase().includes(searchText.toLowerCase()))
    : logs;

  const toggleExpand = (idx: number) => {
    setExpandedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Save the log content through the native save dialog (defaulting to the
  // desktop), writing via the Rust command when running inside Tauri, and
  // falling back to a browser download when the native dialog is unavailable
  // or yields no selection — so the export buttons never silently no-op.
  const saveLogFile = async (
    content: string,
    filename: string,
    mimeType: string,
    filters: Array<{ name: string; extensions: string[] }>,
  ) => {
    try {
      const desktopDir = await tauriClient.getDesktopDir();
      if (desktopDir) {
        const sep = desktopDir.includes('\\') ? '\\' : '/';
        const chosen = await tauriClient.showSaveFilePicker(`${desktopDir}${sep}${filename}`, filters);
        if (chosen) {
          const ok = await tauriClient.saveTextFile(chosen, content);
          if (ok) {
            onAddToast('success', t('settings_logging_saved_title'), t('settings_logging_saved_msg'));
          } else {
            onAddToast('error', t('settings_logging_save_error'), t('settings_logging_save_error_msg'));
          }
          return;
        }
        // Native dialog returned no selection (cancelled or unavailable).
        // Fall through to the browser download so the export always completes.
      }
    } catch {
      /* fall through to browser download */
    }
    downloadAsFile(content, filename, mimeType);
    onAddToast('success', t('settings_logging_saved_title'), t('settings_logging_saved_msg'));
  };

  const handleExportLogs = () => {
    const data =
      source === 'backend'
        ? filteredBackendLogs.map((e) => ({
            timestamp: new Date(e.timestamp).getTime() || Date.now(),
            level: toUiLevel(e.level),
            source: e.target,
            message: `${e.message} ${renderContext(e)}`,
            data: undefined,
          }))
        : logger.getBufferSlice(filterLevel || undefined, filterSource || undefined, 5000);
    const content = exportLogsAsJson(data, { level: filterLevel || 'all', source: filterSource || 'all' });
    const filename = `nova_logs_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.json`;
    void saveLogFile(content, filename, 'application/json', [{ name: 'JSON', extensions: ['json'] }]);
  };

  const handleExportTextLogs = () => {
    const data =
      source === 'backend'
        ? filteredBackendLogs.map((e) => ({
            timestamp: new Date(e.timestamp).getTime() || Date.now(),
            level: toUiLevel(e.level),
            source: e.target,
            message: `${e.message} ${renderContext(e)}`,
            data: undefined,
          }))
        : logger.getBufferSlice(filterLevel || undefined, filterSource || undefined, 5000);
    const content = exportLogsAsText(data, { level: filterLevel || 'all', source: filterSource || 'all' });
    const filename = `nova_logs_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    void saveLogFile(content, filename, 'text/plain', [{ name: 'Text', extensions: ['txt'] }]);
  };

  const handleClearLogs = () => {
    if (source === 'backend') {
      void refreshBackendLogs();
    } else {
      logger.clearBuffer();
      setLogs([]);
    }
  };

  const TRUNCATE_LENGTH = 120;

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-3 animate-in fade-in duration-150">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <ScrollText className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-xs font-extrabold text-[var(--info)]">{t('settings_logging_title')}</h3>
        </div>

        <FormRow label={t('settings_logging_enable')}>
          <Switch
            checked={settings.advanced.loggingEnabled}
            onChange={(v) => {
              updateSetting('advanced', 'loggingEnabled', v);
              logger.setEnabled(v);
            }}
          />
        </FormRow>

        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed -mt-1">{t('settings_logging_desc')}</p>

        {settings.advanced.loggingEnabled && (
          <div className="space-y-2 animate-in fade-in duration-150">
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as LogSource);
                }}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-bold text-[var(--text-primary)] cursor-pointer"
              >
                <option value="frontend">{t('settings_logging_source_ui')}</option>
                <option value="backend">{t('settings_logging_source_daemon')}</option>
              </select>
              <select
                value={filterLevel}
                onChange={(e) => {
                  setFilterLevel(e.target.value as LogLevel | '');
                }}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-bold text-[var(--text-primary)] cursor-pointer"
              >
                <option value="">{t('settings_logging_all_levels')}</option>
                <option value="debug">{t('settings_logging_level_debug')}</option>
                <option value="info">{t('settings_logging_level_info')}</option>
                <option value="warn">{t('settings_logging_level_warn')}</option>
                <option value="error">{t('settings_logging_level_error')}</option>
              </select>
              <input
                value={filterSource}
                onChange={(e) => {
                  setFilterSource(e.target.value);
                }}
                placeholder={t('settings_logging_filter_source')}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] w-32"
                style={{ direction: 'ltr' }}
              />
              <input
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                }}
                placeholder={t('settings_logging_search_placeholder')}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] w-36"
                style={{ direction: 'ltr' }}
              />
              <button
                type="button"
                onClick={handleClearLogs}
                className="px-2 py-1 text-[10px] font-bold text-[var(--danger)] bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded hover:opacity-80 cursor-pointer"
              >
                {t('settings_logging_clear')}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (source === 'backend') {
                    void refreshBackendLogs();
                  } else {
                    refreshLogs();
                  }
                }}
                className="px-2 py-1 text-[10px] font-bold text-[var(--text-secondary)] bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:opacity-80 cursor-pointer flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                {t('settings_logging_refresh')}
              </button>
              <label className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] font-bold cursor-pointer ml-auto">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => {
                    setAutoScroll(e.target.checked);
                  }}
                  className="accent-[var(--accent-primary)]"
                />
                {t('settings_logging_autoscroll')}
              </label>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={handleExportLogs}
                className="px-2 py-1 text-[10px] font-bold text-[var(--info)] bg-[var(--info)]/10 border border-[var(--info)]/30 rounded hover:opacity-80 cursor-pointer flex items-center gap-1"
              >
                <Download className="w-3 h-3" />
                {t('settings_logging_export_json')}
              </button>
              <button
                type="button"
                onClick={handleExportTextLogs}
                className="px-2 py-1 text-[10px] font-bold text-[var(--info)] bg-[var(--info)]/10 border border-[var(--info)]/30 rounded hover:opacity-80 cursor-pointer flex items-center gap-1"
              >
                <FileText className="w-3 h-3" />
                {t('settings_logging_save_txt')}
              </button>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-bold">
              <span>
                {source === 'backend'
                  ? t('settings_logging_entries', { count: filteredBackendLogs.length })
                  : t('settings_logging_entries', { count: filteredLogs.length })}
              </span>
              <span className="text-[var(--border-color)]">|</span>
              {source === 'backend' ? (
                <>
                  <span>
                    {t('settings_logging_daemon_level', { level: backendLevel || t('settings_logging_unknown') })}
                  </span>
                  <span className="text-[var(--border-color)]">|</span>
                  <span>{t('settings_logging_buffer')}: 5000 max</span>
                </>
              ) : (
                <span>{t('settings_logging_buffer')}: 2000 max</span>
              )}
            </div>

            <div
              ref={scrollRef}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg overflow-auto font-mono text-[10px] leading-tight"
              style={{ height: '320px' }}
            >
              {source === 'backend' && backendError && (
                <div className="p-2 text-[10px] text-[var(--danger)] border-b border-[var(--danger-border)] bg-[var(--danger-bg)]">
                  {t('settings_logging_daemon_unavailable', { error: backendError })}
                </div>
              )}
              {source === 'backend' && filteredBackendLogs.length === 0 && !backendError && (
                <div className="p-4 text-center text-[var(--text-muted)] italic">{t('settings_logging_empty')}</div>
              )}
              {source === 'backend' &&
                filteredBackendLogs.map((entry, idx) => {
                  const full = `${entry.message} ${renderContext(entry)}`;
                  const isExpanded = expandedMessages.has(idx);
                  const needsTruncation = full.length > TRUNCATE_LENGTH;
                  const displayMessage = needsTruncation && !isExpanded ? full.slice(0, TRUNCATE_LENGTH) + '...' : full;

                  return (
                    <div
                      key={`backend-${String(idx)}`}
                      className={`px-2 py-0.5 hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)]/30 flex gap-2 ${needsTruncation ? 'cursor-pointer' : ''}`}
                      onClick={() => {
                        if (needsTruncation) toggleExpand(idx);
                      }}
                    >
                      <span className="text-[var(--text-muted)] shrink-0 w-[75px]">
                        {formatBackendTimestamp(entry.timestamp)}
                      </span>
                      <span
                        className={`shrink-0 w-[42px] font-bold uppercase ${levelColor(toUiLevel(entry.level))} border rounded px-1 text-center ${levelBadgeBg(toUiLevel(entry.level))}`}
                      >
                        {entry.level}
                      </span>
                      <span className="text-[var(--accent-primary)] shrink-0 w-[150px] truncate" title={entry.target}>
                        {entry.target}
                      </span>
                      <span className="text-[var(--text-muted)] shrink-0 w-[90px] truncate" title={entry.thread}>
                        {entry.thread}
                      </span>
                      <span className="text-[var(--text-primary)] flex-1 min-w-0 break-all">{displayMessage}</span>
                      {needsTruncation && (
                        <span className="text-[var(--text-muted)] shrink-0 text-[9px] self-center">
                          {isExpanded ? '[-]' : '[+]'}
                        </span>
                      )}
                    </div>
                  );
                })}

              {source === 'frontend' && filteredLogs.length === 0 && (
                <div className="p-4 text-center text-[var(--text-muted)] italic">{t('settings_logging_empty')}</div>
              )}
              {source === 'frontend' &&
                filteredLogs.map((entry, idx) => {
                  const isExpanded = expandedMessages.has(idx);
                  const needsTruncation = entry.message.length > TRUNCATE_LENGTH;
                  const displayMessage =
                    needsTruncation && !isExpanded ? entry.message.slice(0, TRUNCATE_LENGTH) + '...' : entry.message;

                  return (
                    <div
                      key={`frontend-${String(entry.timestamp)}-${String(idx)}`}
                      className={`px-2 py-0.5 hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)]/30 flex gap-2 ${needsTruncation ? 'cursor-pointer' : ''}`}
                      onClick={() => {
                        if (needsTruncation) toggleExpand(idx);
                      }}
                    >
                      <span className="text-[var(--text-muted)] shrink-0 w-[85px]">
                        {formatLogTimestamp(entry.timestamp)}
                      </span>
                      <span
                        className={`shrink-0 w-[40px] font-bold uppercase ${levelColor(entry.level)} border rounded px-1 text-center ${levelBadgeBg(entry.level)}`}
                      >
                        {entry.level}
                      </span>
                      <span className="text-[var(--accent-primary)] shrink-0 w-[120px] truncate">{entry.source}</span>
                      <span className="text-[var(--text-primary)] flex-1 min-w-0 break-all">{displayMessage}</span>
                      {needsTruncation && (
                        <span className="text-[var(--text-muted)] shrink-0 text-[9px] self-center">
                          {isExpanded ? '[-]' : '[+]'}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>

            {source === 'backend' && (
              <>
                <div className="space-y-2 border-t border-[var(--border-color)] pt-2 mt-2">
                  <div className="flex items-center gap-2">
                    <FileSearch className="w-4 h-4 text-[var(--info)]" />
                    <h4 className="text-[10px] font-extrabold text-[var(--info)]">
                      {t('settings_logging_files_daemon')}
                    </h4>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={logFileName}
                      onChange={(e) => {
                        setLogFileName(e.target.value);
                      }}
                      className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-bold text-[var(--text-primary)] cursor-pointer max-w-[220px]"
                    >
                      {!logFile || logFile.files.length === 0 ? (
                        <option value="">nova.log</option>
                      ) : (
                        logFile.files.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))
                      )}
                    </select>
                    <input
                      value={grepText}
                      onChange={(e) => {
                        setGrepText(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void loadLogFile();
                      }}
                      placeholder={t('settings_logging_grep_placeholder')}
                      className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] w-44"
                      style={{ direction: 'ltr' }}
                    />
                    <select
                      value={fileContext}
                      onChange={(e) => {
                        setFileContext(Number(e.target.value));
                      }}
                      className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-bold text-[var(--text-primary)] cursor-pointer"
                    >
                      <option value={0}>{t('settings_logging_context_lines', { count: 0 })}</option>
                      <option value={2}>{t('settings_logging_context_lines', { count: 2 })}</option>
                      <option value={3}>{t('settings_logging_context_lines', { count: 3 })}</option>
                      <option value={5}>{t('settings_logging_context_lines', { count: 5 })}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void loadLogFile()}
                      disabled={fileLoading}
                      className="px-2 py-1 text-[10px] font-bold text-[var(--text-secondary)] bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:opacity-80 cursor-pointer flex items-center gap-1 disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${fileLoading ? 'animate-spin' : ''}`} />
                      {grepText.trim() ? t('settings_logging_search') : t('settings_logging_refresh')}
                    </button>
                  </div>

                  {fileError && (
                    <div className="text-[10px] text-[var(--danger)] bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded px-2 py-1">
                      {fileError}
                    </div>
                  )}

                  {logFile && (
                    <>
                      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-bold flex-wrap">
                        <span className="font-mono" style={{ direction: 'ltr' }}>
                          {logFile.path}
                        </span>
                        <span>|</span>
                        <span>{t('settings_logging_lines', { count: logFile.totalLines })}</span>
                        {grepText.trim() && (
                          <>
                            <span>|</span>
                            <span>
                              {t('settings_logging_matches', { count: logFile.matches.length })}
                              {logFile.truncatedMatches > 0
                                ? ` ${t('settings_logging_more', { count: logFile.truncatedMatches })}`
                                : ''}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg overflow-auto font-mono text-[10px] leading-tight p-2">
                        {grepText.trim() ? (
                          logFile.matches.length === 0 ? (
                            <div className="text-center text-[var(--text-muted)] italic py-4">
                              {t('settings_logging_no_matches', { query: grepText.trim() })}
                            </div>
                          ) : (
                            logFile.matches.map((m, i) => (
                              <div key={i} className="mb-2">
                                <div className="text-[var(--info)] font-bold">
                                  ── {m.file}:{m.line} ──
                                </div>
                                {m.before.map((b, j) => (
                                  <div key={`b-${String(j)}`} className="text-[var(--text-muted)]">
                                    {b}
                                  </div>
                                ))}
                                <div className="text-[var(--danger)] bg-[var(--danger-bg)]">{m.text}</div>
                                {m.after.map((a, j) => (
                                  <div key={`a-${String(j)}`} className="text-[var(--text-muted)]">
                                    {a}
                                  </div>
                                ))}
                              </div>
                            ))
                          )
                        ) : logFile.tail.length === 0 ? (
                          <div className="text-center text-[var(--text-muted)] italic py-4">
                            {t('settings_logging_file_empty')}
                          </div>
                        ) : (
                          logFile.tail.map((line, i) => (
                            <div key={i} className="whitespace-pre-wrap break-all">
                              {line}
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="space-y-2 border-t border-[var(--border-color)] pt-2 mt-2">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-[var(--info)]" />
                    <h4 className="text-[10px] font-extrabold text-[var(--info)]">
                      {t('settings_logging_task_trace')}
                    </h4>
                  </div>
                  {tasksError && (
                    <div className="text-[10px] text-[var(--danger)] bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded px-2 py-1">
                      {tasksError}
                    </div>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <select
                      value={selectedTask}
                      onChange={(e) => {
                        setSelectedTask(e.target.value);
                      }}
                      className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-bold text-[var(--text-primary)] cursor-pointer max-w-[260px]"
                    >
                      <option value="">— {t('settings_logging_select_task')} —</option>
                      {taskSummaries.map((s) => (
                        <option key={s.taskId} value={s.taskId}>
                          {s.taskId} · {s.entries} entries{s.errors > 0 ? ` · ${String(s.errors)} ERR` : ''}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void loadTaskTrace(selectedTask)}
                      className="px-2 py-1 text-[10px] font-bold text-[var(--text-secondary)] bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:opacity-80 cursor-pointer flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" />
                      {t('settings_logging_reload')}
                    </button>
                  </div>
                  {taskTrace && (
                    <>
                      <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-bold flex-wrap">
                        <span className="text-[var(--accent-primary)] font-mono">{taskTrace.taskId}</span>
                        <span>|</span>
                        <span>{t('settings_logging_entries', { count: taskTrace.entries.length })}</span>
                        {taskTrace.errors.length > 0 && (
                          <span className="text-[var(--danger)]">
                            {t('settings_logging_errors', { count: taskTrace.errors.length })}
                          </span>
                        )}
                        <span>|</span>
                        <span>
                          {t('settings_logging_span', { count: (taskTrace.lastMs - taskTrace.firstMs).toFixed(0) })}
                        </span>
                        <span>|</span>
                        <span>{taskTrace.threads.join(', ')}</span>
                      </div>
                      {taskTrace.errorPath && (
                        <div className="text-[10px] text-[var(--danger)] bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded px-2 py-1 font-mono break-all">
                          [ERROR-PATH] {taskTrace.errorPath.message}
                        </div>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        {taskTrace.phases.map((p) => (
                          <span
                            key={p.phase}
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                              p.phase === 'error-path'
                                ? 'text-[var(--danger)] border-[var(--danger-border)] bg-[var(--danger-bg)]'
                                : 'text-[var(--info)] border-[var(--border-color)] bg-[var(--bg-hover)]'
                            }`}
                          >
                            {p.phase} ×{p.entries} · {(p.lastMs - p.firstMs).toFixed(0)}ms
                          </span>
                        ))}
                      </div>
                      <div className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg overflow-auto font-mono text-[10px] leading-tight p-2 max-h-56">
                        {taskTrace.entries.length === 0 ? (
                          <div className="text-center text-[var(--text-muted)] italic py-4">
                            {t('settings_logging_no_entries')}
                          </div>
                        ) : (
                          taskTrace.entries.map((e, i) => {
                            const isError = e.level.toLowerCase() === 'error';
                            const isErrorPath = e.message.includes('[ERROR-PATH]');
                            return (
                              <div
                                key={i}
                                className={`flex gap-2 px-1 py-0.5 border-b border-[var(--border-color)]/30 ${
                                  isErrorPath ? 'bg-[var(--danger-bg)]' : isError ? 'bg-[var(--danger-bg)]/40' : ''
                                }`}
                              >
                                <span
                                  className="text-[var(--text-muted)] shrink-0 w-[80px]"
                                  style={{ direction: 'ltr' }}
                                >
                                  {formatBackendMs(e.timestampMs ?? 0)}
                                </span>
                                <span
                                  className="text-[var(--text-muted)] shrink-0 w-[60px]"
                                  style={{ direction: 'ltr' }}
                                >
                                  +{(e.timestampMs ?? 0) - (taskTrace.firstMs || 0)}ms
                                </span>
                                <span
                                  className={`shrink-0 w-[40px] font-bold uppercase ${levelColor(toUiLevel(e.level))} border rounded px-1 text-center ${levelBadgeBg(toUiLevel(e.level))}`}
                                >
                                  {e.level}
                                </span>
                                <span
                                  className="text-[var(--accent-primary)] shrink-0 w-[120px] truncate"
                                  title={e.target}
                                >
                                  {e.target}
                                </span>
                                <span className="text-[var(--text-primary)] flex-1 min-w-0 break-all">{e.message}</span>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
