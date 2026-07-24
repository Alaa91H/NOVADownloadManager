/* src/dialogs/settings/sections/DiagnosticsAndSystem.tsx */
import React, { useState, useRef } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField, SelectField } from '../../../components/primitives';
import {
  Activity,
  Database,
  RefreshCw,
  Terminal,
  AlertTriangle,
  Cpu,
  Shield,
  Zap,
  Globe,
  Plus,
  Trash2,
} from 'lucide-react';
import { useBridgeData, useSettingsActions, useI18n } from '../../../store/selectors';
import { novaClient } from '../../../api/novaClient';
import { useEngineCapabilities } from '../../../capabilities/EngineCapabilityContext';

import { extractErrorMessage } from '../../../utils/formatUtils';
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
  const t = useI18n();
  const bridge = useBridgeData();
  const { updateSettings } = useSettingsActions();
  const subTab = activeSubTab || 'bridge';
  const engineCapabilities = useEngineCapabilities();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showCapDetails, setShowCapDetails] = useState(true);
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([
    { key: 'X-NOVA-Client', value: 'desktop' },
  ]);
  const [headerKeyInput, setHeaderKeyInput] = useState('');
  const [headerValueInput, setHeaderValueInput] = useState('');

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
      onAddToast('error', t('settings_toast_ping_failed'), extractErrorMessage(error, t('settings_toast_no_response')));
    } finally {
      setPinging(false);
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
    fileInputRef.current?.click();
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as Partial<AppSettings>;
        const merged = { ...settings, ...parsed };
        updateSettings(merged, true);
        onAddToast('success', t('settings_import_success'), t('settings_import_success_msg'));
      } catch {
        onAddToast('error', t('settings_import_error'), t('settings_import_error_msg'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const addHeader = () => {
    const k = headerKeyInput.trim();
    if (!k) return;
    setHeaders((prev) => [...prev, { key: k, value: headerValueInput.trim() }]);
    setHeaderKeyInput('');
    setHeaderValueInput('');
  };

  const removeHeader = (idx: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {subTab === 'bridge' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Activity className="w-4 h-4 text-[var(--success)]" />
            <h3 className="text-xs font-extrabold text-[var(--success)]">{t('settings_service_bridge')}</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-[var(--text-muted)] block font-bold">
                {t('settings_bridge_service')}
              </span>
              <span className="text-xs font-mono text-[var(--success)]">{bridge.status}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-[var(--text-muted)] block font-bold">{t('settings_bridge_pid')}</span>
              <span className="text-xs font-mono">{bridge.pid || '-'}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-[var(--text-muted)] block font-bold">
                {t('settings_bridge_version')}
              </span>
              <span className="text-xs font-mono">{bridge.version || '-'}</span>
            </div>
            <div className="bg-[var(--bg-hover)]/30 border border-[var(--border-color)] rounded-lg p-3">
              <span className="text-[10px] text-[var(--text-muted)] block font-bold">{t('settings_bridge_http')}</span>
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
            className="px-3 py-1.5 bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] rounded text-xs font-bold hover:bg-[var(--success-bg)] transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
          >
            {pinging && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {t('settings_test_response')}
          </button>
          {pingLatency != null && (
            <p className="text-[11px] text-[var(--success)] font-mono">Response: {pingLatency}ms</p>
          )}
        </div>
      )}

      {subTab === 'diagnostics' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          {/* -- Engine Capability Breakdown -- */}
          <div className="border-t border-[var(--border-color)]/40 pt-3 mt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-cyan-500" />
                <h3 className="text-xs font-extrabold text-cyan-400">Engine Capabilities</h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowCapDetails(!showCapDetails);
                }}
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
              >
                {showCapDetails ? '? Collapse' : '? Expand'}
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              <div
                className={`border rounded-lg p-2 text-center ${engineCapabilities.directReady ? 'bg-[var(--success-bg)] border-[var(--success-border)]' : 'bg-[var(--danger-bg)] border-[var(--danger-border)]'}`}
              >
                <Zap
                  className={`w-3.5 h-3.5 mx-auto mb-1 ${engineCapabilities.directReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}
                />
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">libcurl</span>
                <span
                  className={`text-[10px] font-mono font-bold ${engineCapabilities.directReady ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}
                >
                  {engineCapabilities.directReady ? 'Active' : 'Unavailable'}
                </span>
              </div>
              <div
                className={`border rounded-lg p-2 text-center ${engineCapabilities.mediaReady ? 'bg-[var(--success-bg)] border-[var(--success-border)]' : 'bg-[var(--warning-bg)] border-[var(--warning-border)]'}`}
              >
                <Globe
                  className={`w-3.5 h-3.5 mx-auto mb-1 ${engineCapabilities.mediaReady ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}
                />
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">Media Engine</span>
                <span
                  className={`text-[10px] font-mono font-bold ${engineCapabilities.mediaReady ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}
                >
                  {engineCapabilities.mediaReady ? 'Active' : 'Unavailable'}
                </span>
              </div>
              <div
                className={`border rounded-lg p-2 text-center ${engineCapabilities.ffmpegReady ? 'bg-[var(--success-bg)] border-[var(--success-border)]' : 'bg-[var(--warning-bg)] border-[var(--warning-border)]'}`}
              >
                <Shield
                  className={`w-3.5 h-3.5 mx-auto mb-1 ${engineCapabilities.ffmpegReady ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}
                />
                <span className="text-[9px] font-bold text-[var(--text-secondary)] block">FFmpeg</span>
                <span
                  className={`text-[10px] font-mono font-bold ${engineCapabilities.ffmpegReady ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}
                >
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
                    Direct Option Keys ({engineCapabilities.directOptionKeys.size} supported,{' '}
                    {engineCapabilities.unsupportedDirectOptionKeys.size} unsupported)
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(engineCapabilities.directOptionKeys)
                      .sort()
                      .map((key) => (
                        <span
                          key={key}
                          className="px-1.5 py-0.5 bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] text-[8px] font-mono rounded"
                        >
                          {key}
                        </span>
                      ))}
                    {Array.from(engineCapabilities.unsupportedDirectOptionKeys)
                      .sort()
                      .map((key) => (
                        <span
                          key={key}
                          className="px-1.5 py-0.5 bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger)]/50 text-[8px] font-mono rounded line-through"
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
                    {Array.from(engineCapabilities.mediaOptionKeys)
                      .sort()
                      .slice(0, 40)
                      .map((key) => (
                        <span
                          key={key}
                          className="px-1.5 py-0.5 bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning)] text-[8px] font-mono rounded"
                        >
                          {key}
                        </span>
                      ))}
                    {engineCapabilities.mediaOptionKeys.size > 40 && (
                      <span className="px-1.5 py-0.5 bg-[var(--bg-hover)] text-[var(--text-muted)] text-[8px] font-mono rounded">
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
                      <span className="text-[var(--warning)] ml-1 font-bold">{engineCapabilities.mediaEngineId}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text-muted)]">Post-Processing:</span>
                      <span className="text-[var(--accent-primary)] ml-1 font-bold">
                        {engineCapabilities.postProcessorId}
                      </span>
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
            <Database className="w-4 h-4 text-[var(--warning)]" />
            <h3 className="text-xs font-extrabold text-[var(--warning)]">{t('settings_backup_restore')}</h3>
          </div>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{t('settings_backup_desc')}</p>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFileChange} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleExportSettings}
              className="px-3 py-1.5 bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning)] rounded text-xs font-bold hover:bg-[var(--warning-bg)] transition-all cursor-pointer"
            >
              {t('settings_export')}
            </button>
            <button
              type="button"
              onClick={handleImportSettings}
              className="px-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-primary)] rounded text-xs font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer"
            >
              {t('settings_import')}
            </button>
          </div>
          <div className="bg-[var(--danger-bg)] border border-[var(--danger-border)] rounded-lg p-3 space-y-2">
            <p className="flex items-center gap-2 text-[var(--danger)] font-bold text-xs">
              <AlertTriangle className="w-4 h-4" /> {t('settings_critical_reset')}
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">{t('settings_factory_desc')}</p>
            <button
              type="button"
              onClick={onFactoryReset}
              className="px-3 py-1.5 bg-[var(--danger)] hover:bg-[var(--danger-hover)] text-white rounded text-xs font-bold transition-all cursor-pointer"
            >
              {t('settings_factory_reset')}
            </button>
          </div>
        </div>
      )}

      {subTab === 'advanced' && (
        <div className="space-y-4 animate-in fade-in duration-150">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
            <Terminal className="w-4 h-4 text-[var(--info)]" />
            <h3 className="text-xs font-extrabold text-[var(--info)]">{t('settings_advanced_ports')}</h3>
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

          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
            <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)]/50 pb-1 mb-1">
              {t('set_net_protocols_title')}
            </span>
            <SelectField
              label={t('settings_advanced_log_level')}
              value={settings.advanced.logLevel}
              onChange={(e) => {
                updateSetting('advanced', 'logLevel', e.target.value);
              }}
              options={[
                { value: 'info', label: t('settings_log_info') },
                { value: 'debug', label: t('settings_log_debug') },
                { value: 'error', label: t('settings_log_error') },
              ]}
            />
            <SelectField
              label={t('settings_browser_intercept_keys')}
              value={settings.advanced.browserInterceptKeys}
              onChange={(e) => {
                updateSetting('advanced', 'browserInterceptKeys', e.target.value);
              }}
              options={[
                { value: 'Alt', label: t('settings_intercept_alt') },
                { value: 'Ctrl', label: t('settings_intercept_ctrl') },
                { value: 'Shift', label: t('settings_intercept_shift') },
                { value: 'Alt+Ctrl', label: t('settings_intercept_alt_ctrl') },
              ]}
            />
          </div>

          <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
            <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)]/50 pb-1 mb-1">
              {t('settings_default_headers')}
            </span>
            {headers.length === 0 && (
              <p className="text-[10px] text-[var(--text-muted)] italic">{t('settings_default_headers_empty')}</p>
            )}
            {headers.map((h, idx) => (
              <div key={`${h.key}-${String(idx)}`} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <span
                  className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1.5 text-xs font-mono truncate text-[var(--text-primary)]"
                  title={h.key}
                >
                  {h.key}
                </span>
                <span
                  className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1.5 text-xs font-mono truncate text-[var(--text-primary)]"
                  title={h.value}
                >
                  {h.value}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeHeader(idx);
                  }}
                  className="p-1.5 rounded border border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors cursor-pointer shrink-0"
                  title={t('settings_default_headers_remove')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
              <input
                value={headerKeyInput}
                onChange={(e) => {
                  setHeaderKeyInput(e.target.value);
                }}
                placeholder={t('settings_header_key')}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1.5 text-xs font-mono text-left focus:border-[var(--accent-primary)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                style={{ direction: 'ltr' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addHeader();
                }}
              />
              <input
                value={headerValueInput}
                onChange={(e) => {
                  setHeaderValueInput(e.target.value);
                }}
                placeholder={t('settings_header_value')}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1.5 text-xs font-mono text-left focus:border-[var(--accent-primary)] focus:outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                style={{ direction: 'ltr' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addHeader();
                }}
              />
              <button
                type="button"
                onClick={addHeader}
                className="p-1.5 rounded border border-[var(--accent-border)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/20 transition-colors cursor-pointer shrink-0"
                title={t('settings_default_headers_add')}
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
