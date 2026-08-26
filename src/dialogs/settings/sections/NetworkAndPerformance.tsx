/* src/dialogs/settings/sections/NetworkAndPerformance.tsx */
import React, { useState, useMemo } from 'react';
import { Globe, RefreshCw, ShieldCheck, Server, Network, Activity, Zap, Clock, XCircle } from 'lucide-react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Checkbox, FormRow, SelectField, Switch, TextField } from '../../../components/primitives';
import { useI18n } from '../../../store/selectors';
import { novaClient } from '../../../api/novaClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string) => void;
}

type DnsPreset = { primary: string; secondary: string; description: string };

const DNS_PRESET_ENDPOINTS: Record<string, Omit<DnsPreset, 'description'>> = {
  system: { primary: '', secondary: '' },
  cloudflare: { primary: '1.1.1.1', secondary: '1.0.0.1' },
  google: { primary: '8.8.8.8', secondary: '8.8.4.4' },
  opendns: { primary: '208.67.222.222', secondary: '208.67.220.220' },
  quad9: { primary: '9.9.9.9', secondary: '149.112.112.112' },
  comodo: { primary: '8.26.56.26', secondary: '8.20.247.20' },
  adguard: { primary: '94.140.14.14', secondary: '94.140.15.15' },
  cleanbrowsing: { primary: '185.228.168.9', secondary: '185.228.169.9' },
  custom: { primary: '', secondary: '' },
};

export const NetworkAndPerformance: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const t = useI18n();
  const [proxyTestStatus, setProxyTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const dnsPresets = useMemo<Record<string, DnsPreset>>(
    () => ({
      system: { ...DNS_PRESET_ENDPOINTS.system, description: t('settings_dns_desc_system') },
      cloudflare: { ...DNS_PRESET_ENDPOINTS.cloudflare, description: t('settings_dns_desc_cloudflare') },
      google: { ...DNS_PRESET_ENDPOINTS.google, description: t('settings_dns_desc_google') },
      opendns: { ...DNS_PRESET_ENDPOINTS.opendns, description: t('settings_dns_desc_opendns') },
      quad9: { ...DNS_PRESET_ENDPOINTS.quad9, description: t('settings_dns_desc_quad9') },
      comodo: { ...DNS_PRESET_ENDPOINTS.comodo, description: t('settings_dns_desc_comodo') },
      adguard: { ...DNS_PRESET_ENDPOINTS.adguard, description: t('settings_dns_desc_adguard') },
      cleanbrowsing: { ...DNS_PRESET_ENDPOINTS.cleanbrowsing, description: t('settings_dns_desc_cleanbrowsing') },
      custom: { ...DNS_PRESET_ENDPOINTS.custom, description: t('settings_dns_desc_custom') },
    }),
    [t],
  );
  const dnsModeOptions = [
    { value: 'system', label: t('settings_dns_system_default') },
    { value: 'cloudflare', label: 'Cloudflare (1.1.1.1)' },
    { value: 'google', label: 'Google DNS (8.8.8.8)' },
    { value: 'opendns', label: 'OpenDNS (208.67.222.222)' },
    { value: 'quad9', label: 'Quad9 (9.9.9.9)' },
    { value: 'comodo', label: 'Comodo Secure (8.26.56.26)' },
    { value: 'adguard', label: 'AdGuard DNS (94.140.14.14)' },
    { value: 'cleanbrowsing', label: 'CleanBrowsing (185.228.168.9)' },
    { value: 'custom', label: t('settings_dns_custom_manual') },
  ];
  const [proxyErrorMessage, setProxyErrorMessage] = useState('');
  const [dnsCustomPrimary, setDnsCustomPrimary] = useState(() => settings.extra.dnsCustomResolver.split(',')[0] ?? '');
  const [dnsCustomSecondary, setDnsCustomSecondary] = useState(
    () => settings.extra.dnsCustomResolver.split(',')[1] ?? '',
  );

  const activeDnsPreset = useMemo(
    () => dnsPresets[settings.extra.dnsResolver] ?? { primary: '', secondary: '', description: '' },
    [dnsPresets, settings.extra.dnsResolver],
  );

  const handleDnsModeChange = (mode: string) => {
    updateSetting('extra', 'dnsResolver', mode);
    const preset = dnsPresets[mode];
    if (mode !== 'custom') {
      const servers = [preset.primary, preset.secondary].filter(Boolean).join(',');
      // Real consumer: AddDownloadDialog reads connection.defaults.dnsServers.
      updateSetting('connection', 'defaults', {
        ...settings.connection.defaults,
        dnsServers: servers,
      });
      if (mode !== 'system') {
        updateSetting('extra', 'dnsCustomResolver', servers);
      }
    }
  };

  const handleDnsCustomApply = () => {
    const servers = [dnsCustomPrimary, dnsCustomSecondary].filter(Boolean).join(',');
    updateSetting('extra', 'dnsCustomResolver', servers);
    updateSetting('connection', 'defaults', {
      ...settings.connection.defaults,
      dnsServers: servers,
    });
    onAddToast('success', t('settings_dns_configuration'), t('settings_dns_custom_applied'));
  };

  const handleDnsTest = async () => {
    try {
      const data = await novaClient.pingDnsProviders();
      const resolver = settings.extra.dnsResolver;
      const preset = dnsPresets[resolver];
      const currentIp = resolver === 'custom' ? settings.extra.dnsCustomResolver.split(',')[0] : preset.primary;
      const match = currentIp ? data.results.find((r) => r.ip === currentIp) : null;
      if (match && match.latencyMs !== null) {
        onAddToast(
          'success',
          t('settings_dns_test_title'),
          t('settings_dns_test_result', { resolver, ip: match.ip, latency: match.latencyMs.toFixed(1) }),
        );
      } else if (match) {
        onAddToast('warning', t('settings_dns_test_title'), t('settings_dns_test_timeout', { resolver, ip: match.ip }));
      } else {
        onAddToast('info', t('settings_dns_test_title'), t('settings_dns_test_hint'));
      }
    } catch {
      onAddToast('error', t('settings_dns_test_title'), t('settings_dns_test_failed'));
    }
  };

  const [pingResults, setPingResults] = useState<Array<{ name: string; ip: string; latencyMs: number | null }> | null>(
    null,
  );
  const [pingLoading, setPingLoading] = useState(false);

  const handlePingAll = async () => {
    setPingLoading(true);
    setPingResults(null);
    try {
      const data = await novaClient.pingDnsProviders();
      setPingResults(data.results);
      const reachable = data.results.filter((r) => r.latencyMs !== null).length;
      onAddToast(
        'info',
        t('settings_dns_ping_title'),
        t('settings_dns_ping_summary', { total: data.results.length, reachable }),
      );
    } catch {
      onAddToast('error', t('settings_dns_ping_title'), t('settings_dns_ping_failed'));
    } finally {
      setPingLoading(false);
    }
  };

  const bestPing = pingResults
    ? pingResults.reduce<{ name: string; latencyMs: number } | null>((best, r) => {
        if (r.latencyMs === null) return best;
        if (!best || r.latencyMs < best.latencyMs) return { name: r.name, latencyMs: r.latencyMs };
        return best;
      }, null)
    : null;

  const handleTestProxy = () => {
    setProxyTestStatus('testing');
    setProxyErrorMessage('');
    setTimeout(() => {
      const host = settings.connection.proxyHost.trim();
      const port = Number(settings.connection.proxyPort);
      if (!host) {
        setProxyTestStatus('fail');
        setProxyErrorMessage(t('settings_proxy_host_empty'));
        onAddToast('error', t('settings_toast_proxy_test'), t('settings_toast_proxy_fail'));
        return;
      }
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        setProxyTestStatus('fail');
        setProxyErrorMessage(t('settings_proxy_port_invalid'));
        onAddToast('error', t('settings_toast_proxy_test'), t('settings_toast_proxy_fail'));
        return;
      }
      setProxyTestStatus('pass');
      setProxyErrorMessage(t('settings_proxy_configuration_valid'));
      onAddToast('success', t('settings_toast_proxy_test'), t('settings_toast_proxy_pass'));
    }, 400);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* ── Proxy ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Globe className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">{t('settings_enable_proxy')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <FormRow label={t('settings_enable_proxy')}>
            <Switch
              checked={settings.connection.enableProxy}
              onChange={(v) => {
                updateSetting('connection', 'enableProxy', v);
              }}
            />
          </FormRow>

          {settings.connection.enableProxy && (
            <div className="space-y-3 pt-2 border-t border-[var(--border-color)]/50 animate-in slide-in-from-top-2 duration-150">
              <div className="grid grid-cols-1 gap-3">
                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    label={t('settings_proxy_host')}
                    value={settings.connection.proxyHost}
                    onChange={(e) => {
                      updateSetting('connection', 'proxyHost', e.target.value);
                    }}
                    placeholder={t('settings_proxy_host_placeholder')}
                    style={{ direction: 'ltr', textAlign: 'left' }}
                  />
                  <TextField
                    label={t('settings_port')}
                    value={settings.connection.proxyPort}
                    onChange={(e) => {
                      updateSetting('connection', 'proxyPort', e.target.value);
                    }}
                    placeholder="8080"
                    style={{ direction: 'ltr', textAlign: 'left' }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <SelectField
                    label={t('settings_proxy_type')}
                    value={settings.connection.proxyType}
                    onChange={(e) => {
                      updateSetting('connection', 'proxyType', e.target.value);
                    }}
                    options={[
                      { value: 'http', label: 'HTTP' },
                      { value: 'socks4', label: 'SOCKS4' },
                      { value: 'socks5', label: 'SOCKS5' },
                      { value: 'socks4a', label: 'SOCKS4a' },
                      { value: 'socks5h', label: 'SOCKS5h' },
                    ]}
                  />
                  <div className="flex items-center gap-6 pt-5">
                    <Checkbox
                      label={t('settings_proxy_tunnel')}
                      checked={settings.connection.proxyTunnel}
                      onChange={(v) => {
                        updateSetting('connection', 'proxyTunnel', v);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <TextField
                  label={t('settings_proxy_user_optional')}
                  value={settings.connection.proxyUser}
                  onChange={(e) => {
                    updateSetting('connection', 'proxyUser', e.target.value);
                  }}
                  placeholder={t('settings_proxy_username')}
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
                <TextField
                  label={t('settings_proxy_pass_optional')}
                  type="password"
                  value={settings.connection.proxyPass}
                  onChange={(e) => {
                    updateSetting('connection', 'proxyPass', e.target.value);
                  }}
                  placeholder={t('settings_proxy_password')}
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
              </div>

              <div className="flex flex-col gap-1.5 items-start pt-2 border-t border-[var(--border-color)]/30">
                <button
                  type="button"
                  onClick={handleTestProxy}
                  disabled={proxyTestStatus === 'testing'}
                  className="px-3 py-1.5 bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--info)] rounded text-xs font-bold hover:bg-[var(--info-bg)] transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
                >
                  {proxyTestStatus === 'testing' && (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--info)]" />
                  )}
                  {t('settings_test_proxy')}
                </button>
                {proxyTestStatus === 'pass' && (
                  <span className="bg-[var(--success-bg)] border border-[var(--success-border)] text-[var(--success)] px-2 py-0.5 rounded text-[10px] font-bold">
                    {t('settings_proxy_connected')}
                  </span>
                )}
                {proxyTestStatus === 'fail' && (
                  <span className="bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger)] px-2 py-0.5 rounded text-[10px] font-bold">
                    {t('settings_proxy_failed')}
                  </span>
                )}
                {proxyErrorMessage && (
                  <p className="text-[11px] text-[var(--danger)] font-mono mt-1">{proxyErrorMessage}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── VPN ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <ShieldCheck className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">{t('settings_vpn_title')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <FormRow label={t('settings_vpn_enable')}>
            <Switch
              checked={settings.extra.vpnEnabled}
              onChange={(v) => {
                updateSetting('extra', 'vpnEnabled', v);
              }}
            />
          </FormRow>

          {settings.extra.vpnEnabled && (
            <div className="space-y-3 pt-2 border-t border-[var(--border-color)]/50 animate-in slide-in-from-top-2 duration-150">
              <SelectField
                label={t('settings_vpn_mode')}
                value={settings.extra.vpnMode}
                onChange={(e) => {
                  updateSetting('extra', 'vpnMode', e.target.value);
                }}
                options={[
                  { value: 'system', label: t('settings_vpn_mode_system') },
                  { value: 'proxy', label: t('settings_vpn_mode_proxy') },
                  { value: 'bind', label: t('settings_vpn_mode_bind') },
                ]}
              />

              {settings.extra.vpnMode === 'proxy' && (
                <TextField
                  label={t('settings_vpn_proxy')}
                  value={settings.extra.vpnProxyUrl}
                  onChange={(e) => {
                    updateSetting('extra', 'vpnProxyUrl', e.target.value);
                  }}
                  placeholder={t('settings_vpn_proxy_placeholder')}
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
              )}

              {settings.extra.vpnMode === 'bind' && (
                <TextField
                  label={t('settings_vpn_bind')}
                  value={settings.extra.vpnBindAddress}
                  onChange={(e) => {
                    updateSetting('extra', 'vpnBindAddress', e.target.value);
                  }}
                  placeholder={t('settings_vpn_bind_placeholder')}
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
              )}

              <div className="flex flex-col gap-2">
                <Checkbox
                  label={t('settings_vpn_kill_switch')}
                  checked={settings.extra.vpnKillSwitch}
                  onChange={(v) => {
                    updateSetting('extra', 'vpnKillSwitch', v);
                  }}
                />
              </div>

              <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_vpn_note')}</p>
            </div>
          )}
        </div>
      </div>

      {/* ── DNS ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Network className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">{t('settings_dns_configuration')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <SelectField
            label={t('settings_dns_provider')}
            value={settings.extra.dnsResolver}
            onChange={(e) => {
              handleDnsModeChange(e.target.value);
            }}
            options={dnsModeOptions}
          />

          {settings.extra.dnsResolver !== 'system' && (
            <div className="space-y-3 pt-2 border-t border-[var(--border-color)]/50 animate-in slide-in-from-top-2 duration-150">
              <div className="bg-[var(--bg-hover)]/50 px-2.5 py-2 rounded border border-[var(--border-color)]/50">
                <p className="text-[10px] text-[var(--text-muted)] font-mono">{activeDnsPreset.description}</p>
                {settings.extra.dnsResolver !== 'custom' && (
                  <p className="text-[11px] text-[var(--accent-primary)] font-mono mt-1">
                    {[activeDnsPreset.primary, activeDnsPreset.secondary].filter(Boolean).join(', ')}
                  </p>
                )}
              </div>

              {settings.extra.dnsResolver === 'custom' && (
                <div className="grid grid-cols-2 gap-3 p-2.5 bg-[var(--bg-hover)]/50 rounded border border-[var(--border-color)]/50">
                  <TextField
                    label={t('settings_dns_primary')}
                    value={dnsCustomPrimary}
                    onChange={(e) => {
                      setDnsCustomPrimary(e.target.value);
                    }}
                    placeholder="e.g. 1.1.1.1"
                    style={{ direction: 'ltr', textAlign: 'left' }}
                  />
                  <TextField
                    label={t('settings_dns_secondary')}
                    value={dnsCustomSecondary}
                    onChange={(e) => {
                      setDnsCustomSecondary(e.target.value);
                    }}
                    placeholder="e.g. 1.0.0.1"
                    style={{ direction: 'ltr', textAlign: 'left' }}
                  />
                  <div className="col-span-2 flex justify-end">
                    <button
                      type="button"
                      onClick={handleDnsCustomApply}
                      className="px-3 py-1.5 bg-[var(--accent-primary)]/10 border border-[var(--accent-border)] text-[var(--accent-primary)] rounded text-[10px] font-bold hover:bg-[var(--accent-primary)]/20 transition-all cursor-pointer"
                    >
                      {t('settings_dns_apply_custom')}
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <FormRow label={t('settings_dns_cache_timeout')}>
                  <input
                    type="number"
                    min={0}
                    max={86400}
                    value={settings.extra.dnsCacheTimeoutSec}
                    onChange={(e) => {
                      const val = Math.max(0, Math.min(86400, Number(e.target.value) || 0));
                      updateSetting('extra', 'dnsCacheTimeoutSec', val);
                    }}
                    className="w-20 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-2 py-1 text-[10px] font-mono text-[var(--text-primary)] focus:border-[var(--accent-primary)] focus:outline-none text-left"
                    style={{ direction: 'ltr' }}
                  />
                </FormRow>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    void handleDnsTest();
                  }}
                  className="px-3 py-1.5 bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--info)] rounded text-[10px] font-bold hover:bg-[var(--info-bg)] transition-all cursor-pointer flex items-center gap-1"
                >
                  <Server className="w-3 h-3" />
                  {t('settings_dns_test')}
                </button>
                <button
                  type="button"
                  onClick={() => void handlePingAll()}
                  disabled={pingLoading}
                  className="px-3 py-1.5 bg-[var(--bg-hover)] border border-[var(--border-color)] text-[var(--text-secondary)] rounded text-[10px] font-bold hover:bg-[var(--border-color)]/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
                >
                  {pingLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
                  {t('settings_dns_ping_all')}
                </button>
              </div>

              {pingResults && (
                <div className="pt-1 animate-in fade-in duration-200">
                  <table className="w-full text-[10px] font-mono border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--border-color)]/50">
                        <th className="text-left py-1.5 pr-2 text-[var(--text-muted)] font-bold uppercase tracking-wider">
                          {t('settings_dns_provider_column')}
                        </th>
                        <th className="text-left py-1.5 pr-2 text-[var(--text-muted)] font-bold uppercase tracking-wider">
                          IP
                        </th>
                        <th className="text-right py-1.5 text-[var(--text-muted)] font-bold uppercase tracking-wider">
                          {t('settings_dns_latency')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pingResults.map((r) => {
                        const isBest = bestPing && r.name === bestPing.name && r.latencyMs !== null;
                        return (
                          <tr
                            key={r.name}
                            className={`border-b border-[var(--border-color)]/20 ${isBest ? 'bg-[var(--success-bg)]/20' : ''}`}
                          >
                            <td className="py-1.5 pr-2 text-[var(--text-primary)] flex items-center gap-1">
                              {isBest && <Zap className="w-2.5 h-2.5 text-[var(--success)]" />}
                              {r.name}
                            </td>
                            <td className="py-1.5 pr-2 text-[var(--text-muted)]">{r.ip}</td>
                            <td
                              className={`py-1.5 text-right ${r.latencyMs === null ? 'text-[var(--danger)]' : r.latencyMs < 50 ? 'text-[var(--success)]' : r.latencyMs < 150 ? 'text-[var(--warning)]' : 'text-[var(--danger)]'}`}
                            >
                              {r.latencyMs !== null ? (
                                <span className="flex items-center justify-end gap-1">
                                  <Clock className="w-2.5 h-2.5" />
                                  {`${r.latencyMs.toFixed(1)} ms`}
                                </span>
                              ) : (
                                <span className="flex items-center justify-end gap-1">
                                  <XCircle className="w-2.5 h-2.5" />
                                  {t('settings_dns_timeout')}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {bestPing && (
                    <p className="text-[9px] text-[var(--success)] font-bold mt-2 flex items-center gap-1">
                      <Zap className="w-2.5 h-2.5" />
                      {t('settings_dns_fastest', { name: bestPing.name, latency: bestPing.latencyMs.toFixed(1) })}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
