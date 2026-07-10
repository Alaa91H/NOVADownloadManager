/* src/dialogs/settings/sections/DiagnosticsAndSystem.tsx */
import React, { useState, useEffect } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField } from '../../../components/primitives';
import { Activity, Database, RefreshCw, Terminal, AlertTriangle, Cpu, Shield, Zap, Globe } from 'lucide-react';
import { useAppStore } from '../../../state/appStore';
import { novaClient } from '../../../api/novaClient';
import { useEngineCapabilities } from '../../../capabilities/EngineCapabilityContext';

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
}) => {
  const { t, bridge } = useAppStore();
  const subTab = activeSubTab || 'bridge';
  const engineCapabilities = useEngineCapabilities();

  const [showCapDetails, setShowCapDetails] = useState(false);

  const [diagChecking, setDiagChecking] = useState(false);
  const [diagResults, setDiagResults] = useState<
    Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail' | 'idle' }>
  >([
    { id: 'health', label: t('settings_diag_health'), status: 'idle' },
    { id: 'direct', label: t('settings_diag_direct'), status: 'idle' },
    { id: 'media', label: t('settings_diag_media'), status: 'idle' },
    { id: 'downloads', label: t('settings_diag_downloads'), status: 'idle' },
    { id: 'diagnostics', label: t('settings_diag_system'), status: 'idle' },
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
      onAddToast(
        health.status === 'connected' ? 'success' : 'warning',
        t('settings_toast_ping'),
        `NOVA responded in ${String(latency)}ms with status: ${health.status}.`,
      );
    } catch (error) {
      onAddToast(
        'error',
        t('settings_toast_ping_failed'),
        error instanceof Error ? error.message : t('settings_toast_no_response'),
      );
    } finally {
      setPinging(false);
    }
  };

  const handleRunDiagnostics = async () => {
    setDiagChecking(true);
    setDiagResults((prev) => prev.map((r) => ({ ...r, status: 'idle' })));

    const setCheckStatus = (id: string, status: 'pass' | 'warn' | 'fail') => {
      setDiagResults((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
    };

    let anyFailure: boolean;
    let anyWarning = false;

    try {
      const health = await novaClient.health();
      setCheckStatus('health', health.status === 'connected' ? 'pass' : 'warn');
      anyWarning = health.status !== 'connected';

      const directReady = health.engines.curl.available;
      const mediaReady = health.engines.ytdlp.available;
      setCheckStatus('direct', directReady ? 'pass' : 'fail');
      setCheckStatus('media', mediaReady ? 'pass' : 'warn');
      anyFailure = !directReady;
      anyWarning = anyWarning || !mediaReady;
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
      onAddToast('error', t('settings_toast_diag_complete'), t('settings_toast_diag_unavail'));
    } else if (anyWarning) {
      onAddToast('warning', t('settings_toast_diag_complete'), t('settings_toast_diag_degraded'));
    } else {
      onAddToast('success', t('settings_toast_diag_complete'), t('settings_toast_diag_all_ok'));
    }
  };

  const handleExportSettings = () => {
    const jsonString = JSON.stringify(settings, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', url);
    downloadAnchor.setAttribute('download', `nova_settings_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(url);
    onAddToast('success', t('settings_toast_exported'), t('settings_toast_exported_msg'));
  };

  const handleImportSettings = () => {
    onAddToast('warning', t('settings_toast_import_unavail'), t('settings_toast_import_unavail_msg'));
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
            <h3 className="text-xs font-extrabold text-emerald-400">{t('settings_service_bridge')}</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">{t('settings_bridge_service')}</span>
              <span className="text-xs font-mono text-emerald-400">{bridge.status}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">{t('settings_bridge_pid')}</span>
              <span className="text-xs font-mono">{bridge.pid || '-'}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">{t('settings_bridge_version')}</span>
              <span className="text-xs font-mono">{bridge.version || '-'}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-slate-400 block font-bold">{t('settings_bridge_http')}</span>
              <span className="text-xs font-mono">127.0.0.1:{settings.extra.daemonPort || '3199'}</span>
            </div>
          </div>
          <FormRow label={t('settings_auto_reconnect')}>
            <Switch
              checked={settings.extra.autoReconnectDaemon}
              onChange={(v) => {
                updateSetting('extra', 'autoReconnectDaemon', v);
              }}
            />
          </FormRow>
          <FormRow label={t('settings_enable_sse')}>
            <Switch
              checked={settings.extra.enableSse}
              onChange={(v) => {
                updateSetting('extra', 'enableSse', v);
              }}
            />
          </FormRow>
          <button
            type="button"
            onClick={() => {
              void handleRunPing();
            }}
            disabled={pinging}
            className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded text-xs font-bold hover:bg-emerald-500/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
          >
            {pinging && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {t('settings_test_response')}
          </button>
          {pingLatency != null && <p className="text-[11px] text-emerald-400 font-mono">Response: {pingLatency}ms</p>}
        </div>
      )}

      {subTab === 'diagnostics' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Terminal className="w-4 h-4 text-blue-500" />
            <h3 className="text-xs font-extrabold text-blue-400">{t('settings_diagnostics_checks')}</h3>
          </div>
          <button
            type="button"
            onClick={() => {
              void handleRunDiagnostics();
            }}
            disabled={diagChecking}
            className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded text-xs font-bold hover:bg-blue-500/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
          >
            {diagChecking && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {t('settings_run_diagnostics')}
          </button>
          <div className="space-y-2">
            {diagResults.map((result) => (
              <div
                key={result.id}
                className="flex items-center justify-between bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-2.5"
              >
                <span className="text-xs text-[var(--text-primary)] font-semibold">{result.label}</span>
                <span
                  className={`border px-2 py-0.5 rounded text-[9px] font-bold uppercase ${statusClass(result.status)}`}
                >
                  {result.status === 'idle' ? t('settings_diag_pending') : result.status}
                </span>
              </div>
            ))}
          </div>

          {/* ── Engine Capability Breakdown ── */}
          <div className="border-t border-[var(--border-color)]/40 pt-3 mt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-500" />
                <h3 className="text-xs font-extrabold text-cyan-400">Engine Capabilities</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCapDetails(!showCapDetails)}
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
              >
                {showCapDetails ? '▾ Collapse' : '▸ Expand'}
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              <div className={`border rounded-lg p-2 text-center ${engineCapabilities.directReady ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
                <Zap className={`w-3.5 h-3.5 mx-auto mb-1 ${engineCapabilities.directReady ? 'text-emerald-400' : 'text-red-400'}`} />
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">libcurl</span>
                <span className={`text-[10px] font-mono font-bold ${engineCapabilities.directReady ? 'text-emerald-400' : 'text-red-400'}`}>
                  {engineCapabilities.directReady ? 'Active' : 'Unavailable'}
                </span>
              </div>
              <div className={`border rounded-lg p-2 text-center ${engineCapabilities.mediaReady ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/10 border-amber-500/20'}`}>
                <Globe className={`w-3.5 h-3.5 mx-auto mb-1 ${engineCapabilities.mediaReady ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">Media Engine</span>
                <span className={`text-[10px] font-mono font-bold ${engineCapabilities.mediaReady ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {engineCapabilities.mediaReady ? 'Active' : 'Unavailable'}
                </span>
              </div>
              <div className={`border rounded-lg p-2 text-center ${engineCapabilities.ffmpegReady ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-amber-500/10 border-amber-500/20'}`}>
                <Shield className={`w-3.5 h-3.5 mx-auto mb-1 ${engineCapabilities.ffmpegReady ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">FFmpeg</span>
                <span className={`text-[10px] font-mono font-bold ${engineCapabilities.ffmpegReady ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {engineCapabilities.ffmpegReady ? 'Active' : 'Unavailable'}
                </span>
              </div>
              <div className="border border-[var(--border-color)] rounded-lg p-2 text-center bg-[var(--bg-hover)]/30">
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">Direct Options</span>
                <span className="text-[10px] font-mono font-bold text-cyan-400">
                  {engineCapabilities.directOptionKeys.size}
                </span>
              </div>
            </div>

            {showCapDetails && (
              <div className="mt-3 space-y-3 animate-in fade-in duration-150">
                {/* Protocols */}
                <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    Direct Protocols ({engineCapabilities.directProtocols.length})
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {engineCapabilities.directProtocols.sort().map((proto) => (
                      <span
                        key={proto}
                        className="px-1.5 py-0.5 bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[9px] font-mono font-bold rounded"
                      >
                        {proto}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Supported Options */}
                <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    Direct Option Keys ({engineCapabilities.directOptionKeys.size} supported, {engineCapabilities.unsupportedDirectOptionKeys.size} unsupported)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(engineCapabilities.directOptionKeys).sort().map((key) => (
                      <span
                        key={key}
                        className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[8px] font-mono rounded"
                      >
                        {key}
                      </span>
                    ))}
                    {Array.from(engineCapabilities.unsupportedDirectOptionKeys).sort().map((key) => (
                      <span
                        key={key}
                        className="px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 text-red-400/50 text-[8px] font-mono rounded line-through"
                      >
                        {key}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Media Options */}
                <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    Media Option Keys ({engineCapabilities.mediaOptionKeys.size} supported)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(engineCapabilities.mediaOptionKeys).sort().slice(0, 40).map((key) => (
                      <span
                        key={key}
                        className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[8px] font-mono rounded"
                      >
                        {key}
                      </span>
                    ))}
                    {engineCapabilities.mediaOptionKeys.size > 40 && (
                      <span className="px-1.5 py-0.5 bg-slate-500/10 text-slate-400 text-[8px] font-mono rounded">
                        +{engineCapabilities.mediaOptionKeys.size - 40} more
                      </span>
                    )}
                  </div>
                </div>

                {/* Routing */}
                <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
                  <span className="text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-wider block mb-2">
                    Routing
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[10px] font-mono">
                    <div>
                      <span className="text-[var(--text-muted)]">HTTP/HTTPS/FTP:</span>
                      <span className="text-cyan-400 ml-1 font-bold">{engineCapabilities.directEngineId}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">Web Media:</span>
                      <span className="text-amber-400 ml-1 font-bold">{engineCapabilities.mediaEngineId}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">Post-Processing:</span>
                      <span className="text-purple-400 ml-1 font-bold">{engineCapabilities.postProcessorId}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === 'backup' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Database className="w-4 h-4 text-amber-500" />
            <h3 className="text-xs font-extrabold text-amber-400">{t('settings_backup_restore')}</h3>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">{t('settings_backup_desc')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleExportSettings}
              className="px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded text-xs font-bold hover:bg-amber-500/20 transition-all cursor-pointer"
            >
              {t('settings_export')}
            </button>
            <button
              type="button"
              onClick={handleImportSettings}
              className="px-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border-color)] text-slate-300 rounded text-xs font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer"
            >
              {t('settings_import')}
            </button>
          </div>
          <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 space-y-2">
            <p className="flex items-center gap-2 text-red-400 font-bold text-xs">
              <AlertTriangle className="w-4 h-4" /> {t('settings_critical_reset')}
            </p>
            <p className="text-[11px] text-slate-400">{t('settings_factory_desc')}</p>
            <button
              type="button"
              onClick={onFactoryReset}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-bold transition-all cursor-pointer"
            >
              {t('settings_factory_reset')}
            </button>
          </div>
        </div>
      )}

      {subTab === 'advanced' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Terminal className="w-4 h-4 text-indigo-500" />
            <h3 className="text-xs font-extrabold text-indigo-400">{t('settings_advanced_ports')}</h3>
          </div>
          <div className="grid grid-cols-1 gap-3">
            <TextField
              label={t('settings_service_port')}
              value={settings.extra.daemonPort}
              onChange={(e) => {
                updateSetting('extra', 'daemonPort', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('settings_bind_address')}
              value={settings.extra.daemonBindAddress}
              onChange={(e) => {
                updateSetting('extra', 'daemonBindAddress', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
          <FormRow label={t('settings_experimental')}>
            <Switch
              checked={settings.extra.experimentalFeatures}
              onChange={(v) => {
                updateSetting('extra', 'experimentalFeatures', v);
              }}
            />
          </FormRow>
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)]/50 pb-1 mb-1 mt-3">
            {t('settings_default_headers')}
          </span>
          <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400">
            <span>{t('settings_header_key')}</span>
            <span>{t('settings_header_value')}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-xs font-mono"
              placeholder="X-NOVA-Client"
            />
            <input
              className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-xs font-mono"
              placeholder="desktop"
            />
          </div>
        </div>
      )}
    </div>
  );
};
