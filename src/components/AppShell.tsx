/* src/components/AppShell.tsx */
import React, { useEffect, useState, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../state/appStore';
import { TopBar } from './TopBar';
import { TaskTable } from './TaskTable';
import { StatusBar } from './StatusBar';
import DialogRoot from '../dialogs/DialogRoot';
import { AlertCircle, CheckCircle, Info, X, RefreshCw, Minus, Square } from 'lucide-react';
import { Logo } from './Logo';
import { extractFirstHttpUrl, readClipboardText } from '../utils/clipboard';
import { getDialogForUrl } from '../utils/urlDetector';
import { ErrorBoundary } from './ErrorBoundary';

export const AppShell: React.FC = () => {
  return (
    <ErrorBoundary>
      <AppShellInner />
    </ErrorBoundary>
  );
};

const AppShellInner: React.FC = () => {
  const { toasts, removeToast, openDialog, addToast, bridge, settings, dialog } = useAppStore();

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [connectTimer, setConnectTimer] = useState(0);
  const dragCounter = useRef(0);
  const lastClipboardText = useRef('');
  const clipboardPrimed = useRef(false);
  const lastClipboardOpenedAt = useRef(0);

  // Reset the elapsed counter when leaving the connecting state, adjusting
  // during render; the effect only drives the ticking interval.
  const [prevBridgeStatus, setPrevBridgeStatus] = useState(bridge.status);
  if (prevBridgeStatus !== bridge.status) {
    setPrevBridgeStatus(bridge.status);
    if (bridge.status !== 'connecting') {
      setConnectTimer(0);
    }
  }

  useEffect(() => {
    if (bridge.status !== 'connecting') {
      return;
    }
    const interval = window.setInterval(() => {
      setConnectTimer((t) => t + 1);
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [bridge.status]);

  useEffect(() => {
    const preventUnsupportedContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-native-context-menu="true"]')) {
        return;
      }
      event.preventDefault();
    };

    window.addEventListener('contextmenu', preventUnsupportedContextMenu);
    return () => {
      window.removeEventListener('contextmenu', preventUnsupportedContextMenu);
    };
  }, []);

  useEffect(() => {
    if (!settings.general.monitorClipboard || bridge.status !== 'connected') {
      clipboardPrimed.current = false;
      lastClipboardText.current = '';
      return;
    }

    let cancelled = false;
    const pollClipboard = async () => {
      try {
        const text = (await readClipboardText()).trim();
        if (cancelled) return;

        if (!clipboardPrimed.current) {
          lastClipboardText.current = text;
          clipboardPrimed.current = true;
          return;
        }

        if (!text || text === lastClipboardText.current) return;
        lastClipboardText.current = text;

        const copiedUrl = extractFirstHttpUrl(text);
        if (!copiedUrl || dialog.active) return;

        const now = Date.now();
        if (now - lastClipboardOpenedAt.current < 1500) return;
        lastClipboardOpenedAt.current = now;
        openDialog(getDialogForUrl(copiedUrl), copiedUrl);
      } catch {
        // Clipboard access can be temporarily unavailable while another app owns it.
      }
    };

    void pollClipboard();
    const interval = window.setInterval(() => {
      void pollClipboard();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [settings.general.monitorClipboard, bridge.status, dialog.active, openDialog]);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const types = e.dataTransfer.types;
    if (types.includes('application/x-nova-column') || types.includes('application/x-nova-customize-column')) {
      return;
    }

    dragCounter.current++;
    if (e.dataTransfer.items.length > 0) {
      setIsDraggingOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const types = e.dataTransfer.types;
    if (types.includes('application/x-nova-column') || types.includes('application/x-nova-customize-column')) {
      return;
    }

    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const types = e.dataTransfer.types;
    if (types.includes('application/x-nova-column') || types.includes('application/x-nova-customize-column')) {
      return;
    }

    setIsDraggingOver(false);
    dragCounter.current = 0;

    const droppedText = e.dataTransfer.getData('text/plain');

    // Local files cannot be converted into a real remote URL.
    if (!droppedText && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      addToast(
        'warning',
        'Local file ignored',
        `"${file.name}" is already local; drop a real URL to create a download.`,
      );
      return;
    }

    if (droppedText) {
      openDialog('addDownload', droppedText.trim());
    }
  };

  const getToastIcon = (type: string) => {
    switch (type) {
      case 'success':
        return <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
      case 'warning':
        return <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />;
      default:
        return <Info className="w-4 h-4 text-blue-500 shrink-0" />;
    }
  };

  if (bridge.status === 'connecting') {
    return (
      <div className="flex flex-col items-center justify-center h-screen w-screen bg-[var(--bg-app)] text-[var(--text-primary)] gap-6">
        <Logo size={64} className="animate-pulse opacity-80" />
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-bold">NOVA Download Manager</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {connectTimer > 25
              ? 'Could not connect to the local daemon.'
              : connectTimer > 15
                ? 'Still trying to reach the local daemon...'
                : 'Connecting to daemon...'}
          </p>
          {connectTimer > 25 && (
            <button
              onClick={() => {
                setConnectTimer(0);
                window.location.reload();
              }}
              className="mt-2 px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] text-white rounded transition-all cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
        {connectTimer <= 25 && <RefreshCw className="w-5 h-5 animate-spin text-[var(--accent-primary)]" />}
      </div>
    );
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)] relative"
      dir="ltr"
    >
      {/* Visual Drag and Drop Overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-slate-950/85 backdrop-blur-md border-4 border-dashed border-[var(--accent-primary)] animate-in fade-in duration-200">
          <div className="p-8 rounded-full bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] mb-4 animate-bounce">
            <Logo size={64} />
          </div>
          <h3 className="text-xl font-bold text-white mb-2">Drop a file or URL here to start a download</h3>
          <p className="text-xs text-slate-300">NOVA will detect the file name, type, and destination automatically.</p>
        </div>
      )}

      {/* Custom Title Bar */}
      <div
        data-tauri-drag-region
        className="bg-[var(--bg-sidebar)] h-8 px-2 flex items-center justify-between text-[11px] font-semibold text-[var(--text-secondary)] select-none shrink-0"
        style={{ direction: 'ltr' }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2">
          <Logo size={16} />
          <span className="text-[11px] font-bold text-[var(--text-primary)]">NOVA Download Manager</span>
        </div>
        <div className="flex items-center h-full">
          <button
            onClick={() => {
              if (isTauri()) {
                void getCurrentWindow().minimize();
              }
            }}
            className="h-full px-3 hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center cursor-pointer"
            title="Minimize"
          >
            <Minus className="w-3 h-3 text-[var(--text-secondary)]" />
          </button>
          <button
            onClick={() => {
              if (isTauri()) {
                void getCurrentWindow().toggleMaximize();
              }
            }}
            className="h-full px-3 hover:bg-[var(--bg-hover)] transition-colors flex items-center justify-center cursor-pointer"
            title="Maximize"
          >
            <Square className="w-3 h-3 text-[var(--text-secondary)]" />
          </button>
          <button
            onClick={() => {
              if (isTauri()) {
                void getCurrentWindow().close();
              }
            }}
            className="h-full px-3 hover:bg-red-500 hover:text-white transition-colors flex items-center justify-center cursor-pointer"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* 2. Main Workspace Layout */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          {/* Top bar toolbar */}
          <TopBar />

          {/* Content Container (Grid) */}
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
            <TaskTable />
          </div>

          {/* Bottom Status Bar */}
          <StatusBar />
        </div>
      </div>

      {/* 3. Centralized Dialog router */}
      <DialogRoot />

      {/* 4. Responsive Toast Notification HUD */}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm select-none"
        style={{ direction: 'ltr' }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="glass-panel bg-[var(--bg-surface-elevated)] border border-[var(--border-color)] p-3 rounded-lg shadow-xl flex items-start gap-3 animate-in slide-in-from-right duration-200"
          >
            {getToastIcon(toast.type)}
            <div className="flex-1 space-y-0.5 text-left">
              <h5 className="text-xs font-bold text-[var(--text-primary)]">{toast.title}</h5>
              <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">{toast.message}</p>
            </div>
            <button
              onClick={() => {
                removeToast(toast.id);
              }}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-0.5 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
