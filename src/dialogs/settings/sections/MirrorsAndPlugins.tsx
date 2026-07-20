/* src/dialogs/settings/sections/MirrorsAndPlugins.tsx */
import React, { useState } from 'react';
import { Layers, Power, PowerOff, RefreshCw, Trash2, AlertCircle, Plus, Zap } from 'lucide-react';
import { useToastActions, useEngineActions, useTaskData } from '../../../store/selectors';
import { useEngineMirrors, useEnginePlugins } from '../../../store/selectors';
import { novaClient } from '../../../api/novaClient';

interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  enabled: boolean;
  error?: string | null;
}

function asPlugin(entry: unknown): PluginEntry | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const m = (entry as Record<string, unknown>).manifest as Record<string, unknown> | undefined;
  const st = (entry as Record<string, unknown>).state as Record<string, unknown> | undefined;
  const id = typeof (entry as Record<string, unknown>).id === 'string' ? (entry as Record<string, unknown>).id : m?.id;
  if (typeof id !== 'string') return null;
  return {
    id,
    name: typeof m?.name === 'string' ? m.name : id,
    version: typeof m?.version === 'string' ? m.version : '',
    description: typeof m?.description === 'string' ? m.description : '',
    author: typeof m?.author === 'string' ? m.author : '',
    enabled: Boolean(st?.enabled),
    error: typeof st?.error === 'string' ? st.error : null,
  };
}

export const MirrorsAndPlugins: React.FC = () => {
  const { addToast } = useToastActions();
  const actions = useEngineActions();
  const mirrors = useEngineMirrors();
  const plugins = useEnginePlugins();
  const tasks = useTaskData();

  const [newMirrorTaskId, setNewMirrorTaskId] = useState('');
  const [newMirrorUrl, setNewMirrorUrl] = useState('');
  const [newMirrorPriority, setNewMirrorPriority] = useState('0');
  const [busy, setBusy] = useState(false);

  const downloadingTasks = tasks.filter(
    (t) => t.status === 'downloading' || t.status === 'paused' || t.status === 'queued',
  );

  const handleAddMirror = async () => {
    if (!newMirrorTaskId || !newMirrorUrl.trim()) {
      addToast('error', 'Missing data', 'Select a task and enter a mirror URL.');
      return;
    }
    const priority = Number(newMirrorPriority);
    setBusy(true);
    try {
      await actions.addMirror(newMirrorTaskId, newMirrorUrl.trim(), Number.isFinite(priority) ? priority : 0);
      addToast('success', 'Mirror added', 'The mirror was added and will be used for failover.');
      setNewMirrorUrl('');
      setNewMirrorPriority('0');
    } catch (e) {
      addToast('error', 'Mirror', e instanceof Error ? e.message : 'Could not add the mirror.');
    } finally {
      setBusy(false);
    }
  };

  const handleFailover = async (taskId: string) => {
    setBusy(true);
    try {
      const result = await novaClient.triggerMirrorFailover(taskId);
      if (result.ok) {
        addToast(
          'info',
          'Failover triggered',
          result.activeUrl ? `Now using: ${result.activeUrl}` : 'Failover triggered.',
        );
        void actions.refreshAll();
      } else {
        addToast('error', 'Failover', result.error ?? 'Could not trigger failover.');
      }
    } catch (e) {
      addToast('error', 'Failover', e instanceof Error ? e.message : 'Could not trigger failover.');
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePlugin = async (plugin: PluginEntry) => {
    setBusy(true);
    try {
      if (plugin.enabled) {
        await novaClient.disablePlugin(plugin.id);
        addToast('info', 'Plugin disabled', `${plugin.name} was disabled.`);
      } else {
        await novaClient.enablePlugin(plugin.id);
        addToast('success', 'Plugin enabled', `${plugin.name} is now active.`);
      }
      void actions.refreshAll();
    } catch (e) {
      addToast('error', 'Plugin', e instanceof Error ? e.message : 'Could not toggle the plugin.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnregister = async (pluginId: string) => {
    setBusy(true);
    try {
      await novaClient.unregisterPlugin(pluginId);
      addToast('warning', 'Plugin removed', 'The plugin was unregistered from the engine.');
      void actions.refreshAll();
    } catch (e) {
      addToast('error', 'Plugin', e instanceof Error ? e.message : 'Could not remove the plugin.');
    } finally {
      setBusy(false);
    }
  };

  const pluginList: PluginEntry[] = (plugins?.plugins ?? []).map(asPlugin).filter((p): p is PluginEntry => p !== null);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2 border-b border-[var(--border-color)]">
        <Layers className="w-4 h-4 text-[var(--accent-primary)]" />
        <h2 className="text-sm font-extrabold text-[var(--text-primary)]">Mirrors & Plugins</h2>
        <button
          onClick={() => {
            void actions.refreshAll();
          }}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Refresh"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>

      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
        Configure download mirrors (used for failover when the primary source fails) and manage engine plugins that
        extend NOVA's download, extraction, and post-processing capabilities.
      </p>

      {/* ── Mirrors ── */}
      <section className="rounded-lg border border-[var(--border-color)] p-3 space-y-3">
        <h3 className="text-xs font-bold text-[var(--text-primary)]">Download Mirrors</h3>

        {/* Add mirror form */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_auto_auto] gap-2 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">Task</span>
            <select
              value={newMirrorTaskId}
              onChange={(e) => {
                setNewMirrorTaskId(e.target.value);
              }}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-xs px-2 py-1.5 focus:border-[var(--accent-primary)] focus-visible:outline-none cursor-pointer"
            >
              <option value="">Select a task…</option>
              {downloadingTasks.slice(0, 50).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name.length > 40 ? `${t.name.slice(0, 40)}…` : t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">Mirror URL</span>
            <input
              type="url"
              value={newMirrorUrl}
              onChange={(e) => {
                setNewMirrorUrl(e.target.value);
              }}
              placeholder="https://mirror.example.com/file.zip"
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-xs px-2 py-1.5 focus:border-[var(--accent-primary)] focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)] focus-visible:outline-none"
              dir="ltr"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold text-[var(--text-secondary)]">Priority</span>
            <input
              type="number"
              min={0}
              value={newMirrorPriority}
              onChange={(e) => {
                setNewMirrorPriority(e.target.value);
              }}
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[var(--text-primary)] text-xs px-2 py-1.5 w-20 focus:border-[var(--accent-primary)] focus-visible:outline-none"
            />
          </label>
          <button
            onClick={() => {
              void handleAddMirror();
            }}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>

        {/* Existing mirrors */}
        {mirrors.length === 0 ? (
          <div className="flex items-start gap-2 text-[10px] text-[var(--text-muted)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>No mirrors configured. Mirrors enable automatic failover when the primary URL is unreachable.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {mirrors.map((entry) => (
              <div key={entry.taskId} className="rounded-md border border-[var(--border-color)]/60 p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate" title={entry.taskId}>
                    {entry.taskId}
                  </span>
                  <button
                    onClick={() => {
                      void handleFailover(entry.taskId);
                    }}
                    disabled={busy}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-md border border-[var(--accent-primary)] text-[var(--accent-primary)] hover:bg-[var(--accent-light)] transition-colors cursor-pointer disabled:opacity-50"
                    title="Switch to the next healthy mirror"
                  >
                    <Zap className="w-3 h-3" />
                    Failover
                  </button>
                </div>
                {entry.activeUrl && (
                  <div className="text-[10px] text-[var(--success)] font-mono truncate" title={entry.activeUrl}>
                    ● {entry.activeUrl}
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {entry.mirrors.map((m, i) => (
                    <span
                      key={`${m.url}-${String(i)}`}
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                        m.healthy
                          ? 'bg-[var(--success-bg)] text-[var(--success)]'
                          : 'bg-[var(--danger-bg)] text-[var(--danger)]'
                      }`}
                      title={m.url}
                    >
                      {m.url.length > 30 ? `${m.url.slice(0, 30)}…` : m.url}
                      {typeof m.priority === 'number' && m.priority > 0 ? ` ·P${String(m.priority)}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Plugins ── */}
      <section className="rounded-lg border border-[var(--border-color)] p-3 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-[var(--text-primary)]">Engine Plugins</h3>
          {plugins && (
            <span className="text-[9px] font-mono text-[var(--text-muted)]">API v{plugins.apiVersion || '?'}</span>
          )}
        </div>

        {pluginList.length === 0 ? (
          <div className="flex items-start gap-2 text-[10px] text-[var(--text-muted)]">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              No plugins registered. Plugins extend NOVA's engine with custom extractors, downloaders, or
              post-processors.
            </span>
          </div>
        ) : (
          <div className="space-y-2">
            {pluginList.map((plugin) => (
              <div
                key={plugin.id}
                className={`rounded-md border p-2.5 space-y-1.5 ${
                  plugin.enabled
                    ? 'border-[var(--success-border)] bg-[var(--success-bg)]/30'
                    : 'border-[var(--border-color)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-[var(--text-primary)] truncate">{plugin.name}</span>
                      {plugin.version && (
                        <span className="text-[9px] font-mono text-[var(--text-muted)] bg-[var(--bg-input)] px-1.5 py-0.5 rounded">
                          v{plugin.version}
                        </span>
                      )}
                    </div>
                    {plugin.description && (
                      <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{plugin.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        void handleTogglePlugin(plugin);
                      }}
                      disabled={busy}
                      className={`flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md transition-colors cursor-pointer disabled:opacity-50 ${
                        plugin.enabled
                          ? 'border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                          : 'border border-[var(--success)] text-[var(--success)] hover:bg-[var(--success-bg)]'
                      }`}
                      title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
                    >
                      {plugin.enabled ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                      {plugin.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => {
                        void handleUnregister(plugin.id);
                      }}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded-md border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors cursor-pointer disabled:opacity-50"
                      title="Unregister plugin"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                {plugin.error && (
                  <div className="text-[10px] text-[var(--danger)] bg-[var(--danger)]/10 rounded px-1.5 py-1 font-mono">
                    {plugin.error}
                  </div>
                )}
                <div className="text-[9px] text-[var(--text-muted)] font-mono">
                  id: {plugin.id}
                  {plugin.author && ` · by ${plugin.author}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
