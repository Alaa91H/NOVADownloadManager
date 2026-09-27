export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  source: string;
  message: string;
  data?: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_BUFFER_SIZE = 2000;

class Logger {
  private enabled = false;
  private minLevel: LogLevel = 'info';
  private buffer: LogEntry[] = [];
  private listeners: Array<(entry: LogEntry) => void> = [];

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  setMinLevel(level: LogLevel) {
    this.minLevel = level;
  }

  isEnabled() {
    return this.enabled;
  }

  getBuffer(): readonly LogEntry[] {
    return this.buffer;
  }

  getBufferSlice(level?: LogLevel, source?: string, limit = 200): LogEntry[] {
    let entries = this.buffer;
    if (level) {
      const minP = LEVEL_PRIORITY[level];
      entries = entries.filter((e) => LEVEL_PRIORITY[e.level] >= minP);
    }
    if (source) {
      const s = source.toLowerCase();
      entries = entries.filter((e) => e.source.toLowerCase().includes(s));
    }
    return entries.slice(-limit);
  }

  clearBuffer() {
    this.buffer = [];
  }

  onEntry(cb: (entry: LogEntry) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private push(entry: LogEntry) {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // listener error — ignore
      }
    }
  }

  debug(source: string, message: string, data?: unknown) {
    if (!this.enabled || !this.shouldLog('debug')) return;
    const entry: LogEntry = { timestamp: Date.now(), level: 'debug', source, message, data };
    this.push(entry);
    if (data !== undefined) {
      // eslint-disable-next-line no-console
      console.debug(`[${source}] ${message}`, data);
    } else {
      // eslint-disable-next-line no-console
      console.debug(`[${source}] ${message}`);
    }
  }

  info(source: string, message: string, data?: unknown) {
    if (!this.enabled || !this.shouldLog('info')) return;
    const entry: LogEntry = { timestamp: Date.now(), level: 'info', source, message, data };
    this.push(entry);
    if (data !== undefined) {
      // eslint-disable-next-line no-console
      console.info(`[${source}] ${message}`, data);
    } else {
      // eslint-disable-next-line no-console
      console.info(`[${source}] ${message}`);
    }
  }

  warn(source: string, message: string, data?: unknown) {
    if (!this.enabled || !this.shouldLog('warn')) return;
    const entry: LogEntry = { timestamp: Date.now(), level: 'warn', source, message, data };
    this.push(entry);
    if (data !== undefined) {
      console.warn(`[${source}] ${message}`, data);
    } else {
      console.warn(`[${source}] ${message}`);
    }
  }

  error(source: string, message: string, data?: unknown) {
    if (!this.enabled || !this.shouldLog('error')) return;
    const entry: LogEntry = { timestamp: Date.now(), level: 'error', source, message, data };
    this.push(entry);
    if (data !== undefined) {
      console.error(`[${source}] ${message}`, data);
    } else {
      console.error(`[${source}] ${message}`);
    }
  }
}

export const logger = new Logger();

export function formatLogTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function levelColor(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return 'text-[var(--text-muted)]';
    case 'info':
      return 'text-[var(--info)]';
    case 'warn':
      return 'text-[var(--warning)]';
    case 'error':
      return 'text-[var(--danger)]';
  }
}

export function levelBadgeBg(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return 'bg-[var(--bg-hover)]';
    case 'info':
      return 'bg-[var(--info)]/10 border-[var(--info)]/30';
    case 'warn':
      return 'bg-[var(--warning)]/10 border-[var(--warning)]/30';
    case 'error':
      return 'bg-[var(--danger)]/10 border-[var(--danger)]/30';
  }
}

export function exportLogsAsJson(entries: LogEntry[], filters: { level: string; source: string }): string {
  const exportData = {
    exportedAt: new Date().toISOString(),
    application: 'NOVA Download Manager',
    totalEntries: entries.length,
    filters,
    entries: entries.map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      level: e.level,
      source: e.source,
      message: e.message,
      data: e.data,
    })),
  };
  return JSON.stringify(exportData, null, 2);
}

export function exportLogsAsText(entries: LogEntry[], filters: { level: string; source: string }): string {
  const lines = [
    'NOVA Download Manager - Application Logs',
    `Exported: ${new Date().toISOString()}`,
    `Total entries: ${String(entries.length)}`,
    `Filter: level=${filters.level}, source=${filters.source}`,
    '',
    '='.repeat(120),
    '',
    ...entries.map(
      (e) => `[${formatLogTimestamp(e.timestamp)}] [${e.level.toUpperCase().padEnd(5)}] [${e.source}] ${e.message}`,
    ),
  ];
  return lines.join('\n');
}

export function downloadAsFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
