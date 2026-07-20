import React, { useEffect, useState, useCallback } from 'react';
import {
  Download,
  RefreshCw,
  Check,
  AlertTriangle,
  Settings,
  Terminal,
  Wrench,
  ExternalLink,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import { useExternalToolsStore } from '../../../store/externalToolsStore';
import type { ExternalToolState } from '../../../store/externalToolsStore';

const statusIcon = (status: string) => {
  switch (status) {
    case 'Installed':
      return <Check className="w-3.5 h-3.5 text-emerald-400" />;
    case 'Update Available':
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />;
    case 'Not Installed':
      return <Download className="w-3.5 h-3.5 text-zinc-500" />;
    case 'Broken':
    case 'Incompatible':
      return <AlertTriangle className="w-3.5 h-3.5 text-red-400" />;
    default:
      return <Settings className="w-3.5 h-3.5 text-zinc-500" />;
  }
};

const statusColor = (status: string) => {
  switch (status) {
    case 'Installed':
      return 'text-emerald-400';
    case 'Update Available':
      return 'text-amber-400';
    case 'Not Installed':
      return 'text-zinc-500';
    case 'Broken':
    case 'Incompatible':
      return 'text-red-400';
    default:
      return 'text-zinc-500';
  }
};

const ToolCard: React.FC<{ tool: ExternalToolState; onRefresh: () => void }> = ({ tool, onRefresh: _onRefresh }) => {
  const { discoverTool, checkForUpdates, updateTool, setCustomPath, uninstallTool } = useExternalToolsStore();
  const [showPathInput, setShowPathInput] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(tool.path || '');
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const handleDiscover = useCallback(async () => {
    setActionLoading(true);
    await discoverTool(tool.id);
    setActionLoading(false);
  }, [tool.id, discoverTool]);

  const handleCheckUpdates = useCallback(async () => {
    setActionLoading(true);
    await checkForUpdates(tool.id);
    setActionLoading(false);
  }, [tool.id, checkForUpdates]);

  const handleUpdate = useCallback(async () => {
    setActionLoading(true);
    await updateTool(tool.id);
    setActionLoading(false);
  }, [tool.id, updateTool]);

  const handleSetPath = useCallback(async () => {
    if (!customPathValue.trim()) return;
    setActionLoading(true);
    try {
      await setCustomPath(tool.id, customPathValue.trim());
      setShowPathInput(false);
    } catch {
      // error handled by store
    }
    setActionLoading(false);
  }, [tool.id, customPathValue, setCustomPath]);

  const handleUninstall = useCallback(async () => {
    setActionLoading(true);
    await uninstallTool(tool.id);
    setShowUninstallConfirm(false);
    setActionLoading(false);
  }, [tool.id, uninstallTool]);

  const toolIcon = tool.id === 'ffmpeg' ? Wrench : Terminal;

  return (
    <div className="border border-[var(--border-color)] rounded-lg bg-[var(--bg-card)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {React.createElement(toolIcon, { className: 'w-5 h-5 text-[var(--accent-primary)]' })}
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">{tool.name}</h3>
            <p className="text-[10px] text-[var(--text-muted)]">{tool.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {statusIcon(tool.status)}
          <span className={`text-[11px] font-semibold ${statusColor(tool.status)}`}>{tool.status}</span>
        </div>
      </div>

      {tool.version && (
        <div className="flex items-center gap-4 text-[10px] text-[var(--text-secondary)]">
          <span>
            Version: <span className="font-mono text-[var(--text-primary)]">{tool.version}</span>
          </span>
          {tool.latestVersion && (
            <span>
              Latest: <span className="font-mono text-[var(--text-primary)]">{tool.latestVersion}</span>
            </span>
          )}
        </div>
      )}

      {tool.path && (
        <div className="text-[10px] text-[var(--text-muted)] truncate" title={tool.path}>
          Path: <span className="font-mono text-[var(--text-secondary)]">{tool.path}</span>
          {tool.customPath && (
            <span className="ml-1 px-1 py-0.5 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] rounded text-[9px] font-bold">
              Custom
            </span>
          )}
        </div>
      )}

      {tool.capabilities.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            Capabilities
          </span>
          <div className="flex flex-wrap gap-1">
            {tool.capabilities.map((cap) => (
              <span
                key={cap.id}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium ${
                  cap.available
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-zinc-500/10 text-zinc-500 border border-zinc-500/20'
                }`}
              >
                {cap.available ? '✓' : '○'} {cap.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {tool.error && (
        <div className="text-[10px] text-red-400 bg-red-500/5 border border-red-500/20 rounded px-2 py-1.5">
          {tool.error}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 pt-1">
        <button
          type="button"
          onClick={() => {
            void handleDiscover();
          }}
          disabled={actionLoading}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:bg-[var(--accent-primary)]/10 hover:border-[var(--accent-border)] transition-all disabled:opacity-50"
        >
          {actionLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Detect
        </button>
        <button
          type="button"
          onClick={() => {
            void handleCheckUpdates();
          }}
          disabled={actionLoading}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:bg-[var(--accent-primary)]/10 hover:border-[var(--accent-border)] transition-all disabled:opacity-50"
        >
          Check for Updates
        </button>
        {tool.updateAvailable && (
          <button
            type="button"
            onClick={() => {
              void handleUpdate();
            }}
            disabled={actionLoading}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded hover:bg-emerald-500/20 transition-all disabled:opacity-50"
          >
            Update
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setShowPathInput(!showPathInput);
            setCustomPathValue(tool.path || '');
          }}
          className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:bg-[var(--accent-primary)]/10 hover:border-[var(--accent-border)] transition-all"
        >
          <FolderOpen className="w-3 h-3" /> Change Path
        </button>
        {!showUninstallConfirm && tool.status !== 'Not Installed' && (
          <button
            type="button"
            onClick={() => {
              setShowUninstallConfirm(true);
            }}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-red-500/5 text-red-400 border border-red-500/20 rounded hover:bg-red-500/15 transition-all"
          >
            <Trash2 className="w-3 h-3" /> Uninstall
          </button>
        )}
      </div>

      {showPathInput && (
        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={customPathValue}
            onChange={(e) => {
              setCustomPathValue(e.target.value);
            }}
            placeholder={`/usr/bin/${tool.id}`}
            className="flex-1 px-2 py-1 text-[11px] font-mono bg-[var(--bg-hover)] border border-[var(--border-color)] rounded focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] text-[var(--text-primary)]"
          />
          <button
            type="button"
            onClick={() => {
              void handleSetPath();
            }}
            disabled={actionLoading || !customPathValue.trim()}
            className="px-2 py-1 text-[10px] font-semibold bg-[var(--accent-primary)] text-white rounded hover:opacity-90 disabled:opacity-50 transition-all"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => {
              setShowPathInput(false);
            }}
            className="px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-all"
          >
            Cancel
          </button>
        </div>
      )}

      {showUninstallConfirm && (
        <div className="bg-red-500/5 border border-red-500/20 rounded p-3 space-y-2">
          <p className="text-[11px] text-[var(--text-secondary)]">
            {tool.installedByApp
              ? `Remove ${tool.name}? This will uninstall the managed installation.`
              : `${tool.name} was installed outside the application. The application cannot safely remove it automatically.`}
          </p>
          <div className="flex gap-1.5">
            {tool.installedByApp && (
              <button
                type="button"
                onClick={() => {
                  void handleUninstall();
                }}
                disabled={actionLoading}
                className="px-2 py-1 text-[10px] font-semibold bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 transition-all"
              >
                {actionLoading ? 'Removing...' : 'Uninstall'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setShowUninstallConfirm(false);
              }}
              className="px-2 py-1 text-[10px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {tool.sourceUrl && (
        <a
          href={tool.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[10px] text-[var(--accent-primary)] hover:underline"
        >
          {tool.sourceName || 'Official Source'} <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
};

export const ExternalToolsSettings: React.FC = () => {
  const { tools, loading, fetchTools } = useExternalToolsStore();

  useEffect(() => {
    if (tools.length === 0) {
      void fetchTools();
    }
  }, [tools.length, fetchTools]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-bold text-[var(--text-primary)] mb-1">External Tools</h2>
        <p className="text-[11px] text-[var(--text-muted)]">
          Manage external tools like FFmpeg and yt-dlp. These tools are discovered from your system and provide
          additional capabilities.
        </p>
      </div>

      {loading && tools.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-[var(--text-muted)]">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-xs">Loading external tools...</span>
        </div>
      ) : (
        <div className="space-y-3">
          {tools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              onRefresh={() => {
                void fetchTools();
              }}
            />
          ))}
          {tools.length === 0 && (
            <div className="text-xs text-[var(--text-muted)] py-4 text-center">
              No external tools registered. Click Detect to scan for tools.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
