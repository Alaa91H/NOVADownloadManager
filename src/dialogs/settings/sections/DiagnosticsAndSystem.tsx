/* src/dialogs/settings/sections/DiagnosticsAndSystem.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField } from '../../../components/primitives';
import { Activity, Database, RefreshCw, Terminal, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../../state/appStore';
import { novaClient } from '../../../api/novaClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
  onFactoryReset: () => void;
  activeSubTab?: 'bridge' | 'diagnostics' | 'backup' | 'advanced';
  onChangeSubTab?: (tab: 'bridge' | 'diagnostics' | 'backup' | 'advanced') => void;
}

export const DiagnosticsAndSystem: React.FC<Props> = ({
  settings,
  updateSetting,
  onAddToast,
  onFactoryReset,
  activeSubTab,
  onChangeSubTab,
}) => {
  const { bridge } = useAppStore();
  const [localSubTab, setLocalSubTab] = useState<'bridge' | 'diagnostics' | 'backup' | 'advanced'>('bridge');
  const subTab = activeSubTab || localSubTab;
  void onChangeSubTab;
  void setLocalSubTab;

  const [diagChecking, setDiagChecking] = useState(false);
  const [diagResults, setDiagResults] = useState<Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'idle' }>>([
    { id: 'health', label: 'Service health endpoint', status: 'idle' },
    { id: 'direct', label: 'Direct download engine readiness', status: 'idle' },
    { id: 'media', label: 'Media engine readiness', status: 'idle' },
    { id: 'downloads', label: 'Download list endpoint', status: 'idle' },
    { id: 'diagnostics', label: 'System diagnostics endpoint', status: 'idle' },
  ]);
  const [pinging, setPinging] = useState(false);
  const [pingLatency, setPingLatency] = useState<number | null>(null);

  const handleRunPing = async () => {
    setPinging(true);
    setPingLatency(null);
    const started = performance.now();
    try {
      const health = await novaClient.health();
      const latency = Math.max(1, Math.round(performance.now() - started));
      setPingLatency(latency);
      onAddToast(health.status === 'connected' ? 'success' : 'warning', 'Service Ping', `NOVA responded in ${latency}ms with status: ${health.status}.`);
    } catch (error) {
      onAddToast('error', 'Service Ping Failed', error instanceof Error ? error.message : 'NOVA did not respond.');
    } finally {
      setPinging(false);
    }
  };

  const handleRunDiagnostics = async () => {
    setDiagChecking(true);
    setDiagResults(prev => prev.map(r => ({ ...r, status: 'idle' })));

    const setCheckStatus = (id: string, status: 'pass' | 'warn' | 'fail') => {
      setDiagResults(prev => prev.map(r => r.id === id ? { ...r, status } : r));
    };

    let anyFailure = false;
    let anyWarning = false;

    try {
      const health = await novaClient.health();
      setCheckStatus('health', health.status === 'connected' ? 'pass' : 'warn');
      anyWarning = anyWarning || health.status !== 'connected';

      const directReady = health.engines.aria2.available && health.engines.aria2.rpcReady;
      const mediaReady = health.engines.ytdlp.available;
      setCheckStatus('direct', directReady ? 'pass' : 'fail');
      setCheckStatus('media', mediaReady ? 'pass' : 'fail');
      anyFailure = anyFailure || !directReady || !mediaReady;
    } catch {
      setCheckStatus('health', 'fail');
      setCheckStatus('direct', 'fail');
      setCheckStatus('media', 'fail');
      anyFailure = true;
    }

    try {
      await novaClient.listDownloads();
      setCheckStatus('downloads', 'pass');
    } catch {
      setCheckStatus('downloads', 'fail');
      anyFailure = true;
    }

    try {
      await novaClient.diagnostics();
      setCheckStatus('diagnostics', 'pass');
    } catch {
      setCheckStatus('diagnostics', 'fail');
      anyFailure = true;
    }

    setDiagChecking(false);
    if (anyFailure) {
      onAddToast('error', 'Diagnostics Complete', 'One or more NOVA dependencies are unavailable.');
    } else if (anyWarning) {
      onAddToast('warning', 'Diagnostics Complete', 'NOVA responded, but a dependency is degraded.');
    } else {
      onAddToast('success', 'Diagnostics Complete', 'All checked endpoints and engines are available.');
    }
  };

  const handleExportSettings = () => {
    const jsonString = `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(settings, null, 2))}`;
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', jsonString);
    downloadAnchor.setAttribute('download', `nova_settings_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    onAddToast('success', 'Settings Exported', 'NOVA settings were exported as JSON.');
  };

  const handleImportSettings = () => {
    onAddToast('warning', 'Import Unavailable', 'Settings import is not connected to a file picker yet.');
  };

  const statusClass = (status: 'pass' | 'warn' | 'fail' | 'idle') => {
    if (status === 'pass') return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400';
    if (status === 'warn') return 'bg-amber-500/10 border-amber-500/20 text-amber-400';
    if (status === 'fail') return 'bg-rose-500/10 border-rose-500/20 text-rose-400';
    return 'bg-slate-500/10 border-slate-500/20 text-slate-400';
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {subTab === 'bridge' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Activity className="w-4 h-4 text-emerald-500" />
            <h3 className="text-xs font-extrabold text-emerald-400">Service Bridge Status</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">Service</span>
              <span className="text-xs font-mono text-emerald-400">{bridge.status}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">PID</span>
              <span className="text-xs font-mono">{bridge.pid || '-'}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">Version</span>
              <span className="text-xs font-mono">{bridge.version || '-'}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">HTTP Bridge</span>
              <span className="text-xs font-mono">127.0.0.1:{settings.extra.daemonPort || '3199'}</span>
            </div>
          </div>
          <FormRow label="Reconnect to the service automatically">
            <Switch checked={settings.extra.autoReconnectDaemon} onChange={(v) => updateSetting('extra', 'autoReconnectDaemon', v)} />
          </FormRow>
          <FormRow label="Enable live server events">
            <Switch checked={settings.extra.enableSse} onChange={(v) => updateSetting('extra', 'enableSse', v)} />
          </FormRow>
          <button type="button" onClick={handleRunPing} disabled={pinging} className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded text-xs font-bold hover:bg-emerald-500/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50">
            {pinging && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            Test Service Response
          </button>
          {pingLatency != null && <p className="text-[11px] text-emerald-400 font-mono">Response: {pingLatency}ms</p>}
        </div>
      )}

      {subTab === 'diagnostics' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Terminal className="w-4 h-4 text-blue-500" />
            <h3 className="text-xs font-extrabold text-blue-400">Diagnostics Checks</h3>
          </div>
          <button type="button" onClick={handleRunDiagnostics} disabled={diagChecking} className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded text-xs font-bold hover:bg-blue-500/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50">
            {diagChecking && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            Run Full Diagnostics
          </button>
          <div className="space-y-2">
            {diagResults.map(result => (
              <div key={result.id} className="flex items-center justify-between bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-2.5">
                <span className="text-xs text-[var(--text-primary)] font-semibold">{result.label}</span>
                <span className={`border px-2 py-0.5 rounded text-[9px] font-bold uppercase ${statusClass(result.status)}`}>
                  {result.status === 'idle' ? 'Pending' : result.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {subTab === 'backup' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Database className="w-4 h-4 text-amber-500" />
            <h3 className="text-xs font-extrabold text-amber-400">Backup & Restore</h3>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Export current preferences, folders, automation settings, integration settings, and network options as JSON.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleExportSettings} className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded text-xs font-bold hover:bg-amber-500/20 transition-all cursor-pointer">
              Export Settings
            </button>
            <button type="button" onClick={handleImportSettings} className="px-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border-color)] text-slate-300 rounded text-xs font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer">
              Import Settings
            </button>
          </div>
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 space-y-2">
            <p className="flex items-center gap-2 text-red-400 font-bold text-xs"><AlertTriangle className="w-4 h-4" /> Critical Reset Zone</p>
            <p className="text-[11px] text-slate-400">Factory reset clears local settings, tokens, browser history, filters, and automation rules.</p>
            <button type="button" onClick={onFactoryReset} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-bold transition-all cursor-pointer">
              Factory Reset
            </button>
          </div>
        </div>
      )}

      {subTab === 'advanced' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Terminal className="w-4 h-4 text-indigo-500" />
            <h3 className="text-xs font-extrabold text-indigo-400">Advanced Ports & Headers</h3>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <TextField label="Service Port" value={settings.extra.daemonPort} onChange={(e) => updateSetting('extra', 'daemonPort', e.target.value)} style={{ direction: 'ltr', textAlign: 'left' }} />
            <TextField label="Bind Address" value={settings.extra.daemonBindAddress} onChange={(e) => updateSetting('extra', 'daemonBindAddress', e.target.value)} style={{ direction: 'ltr', textAlign: 'left' }} />
          </div>
          <FormRow label="Enable experimental features">
            <Switch checked={settings.extra.experimentalFeatures} onChange={(v) => updateSetting('extra', 'experimentalFeatures', v)} />
          </FormRow>
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)]/50 pb-1 mb-1 mt-3">Default Outgoing HTTP Headers</span>
          <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400">
            <span>Header Key</span>
            <span>Value</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-xs font-mono" placeholder="X-NOVA-Client" />
            <input className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-xs font-mono" placeholder="desktop" />
          </div>
        </div>
      )}
    </div>
  );
};
