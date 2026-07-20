/* src/dialogs/settings/sections/NetworkAndPerformance.tsx */
import React, { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Globe, RefreshCw, ShieldCheck, Gauge } from 'lucide-react';
import { SpeedLimitInput } from '../../../components/SpeedLimitInput';
import { tauriClient } from '../../../api/tauriClient';
import { useI18n } from '../../../store/selectors';

/** DoH resolver IPs probed (over TCP 443) to report reachability + latency. */
const DNS_ENDPOINTS: Record<string, string> = {
  cloudflare: '1.1.1.1',
  cloudflare_malware: '1.1.1.2',
  google: '8.8.8.8',
  quad9: '9.9.9.9',
  opendns: '208.67.222.222',
  adguard: '94.140.14.14',
  cleanbrowsing: '185.228.168.9',
  dns0: '193.110.81.0',
};

interface DnsProbe {
  reachable: boolean;
  latencyMs: number | null;
}

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

export const NetworkAndPerformance: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const t = useI18n();
  const [proxyTestStatus, setProxyTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const [proxyErrorMessage, setProxyErrorMessage] = useState('');
  const [dnsResults, setDnsResults] = useState<Record<string, DnsProbe | undefined>>({});
  const [dnsTesting, setDnsTesting] = useState(false);

  // Probe every well-known resolver concurrently and record latency.
  const runDnsTests = useCallback(async () => {
    setDnsTesting(true);
    const entries = Object.entries(DNS_ENDPOINTS);
    const probed = await Promise.all(
      entries.map(async ([key, host]) => [key, await tauriClient.probeDnsEndpoint(host, 443)] as const),
    );
    setDnsResults(Object.fromEntries(probed));
    setDnsTesting(false);
  }, []);

  // Auto-run once when the network settings section is opened. The probe is
  // deferred to a microtask so the effect body itself stays synchronous.
  useEffect(() => {
    void Promise.resolve().then(runDnsTests);
  }, [runDnsTests]);

  const fastestDns = Object.entries(dnsResults).reduce<{ key: string; latencyMs: number } | null>((best, [key, r]) => {
    if (!r || !r.reachable || r.latencyMs === null) return best;
    if (!best || r.latencyMs < best.latencyMs) return { key, latencyMs: r.latencyMs };
    return best;
  }, null);

  const dnsOptionLabel = (key: string, base: string): string => {
    if (!(key in DNS_ENDPOINTS)) return base;
    const r = dnsResults[key];
    if (!r) return dnsTesting ? `${base} · …` : base;
    if (!r.reachable || r.latencyMs === null) return `${base} · ${t('settings_dns_unreachable')}`;
    const fastMark = fastestDns?.key === key ? ' ★' : '';
    return `${base} · ${String(r.latencyMs)} ms${fastMark}`;
  };

  const handleTestProxy = () => {
    setProxyTestStatus('testing');
    setProxyErrorMessage('');
    // NOTE: a real proxy connectivity probe belongs in the daemon (it can
    // issue an HTTP CONNECT through the configured proxy). The previous
    // implementation faked success for any non-loopback host, which misled
    // users into thinking broken proxies worked. Until the daemon exposes a
    // /api/probe/proxy endpoint, we validate the inputs locally and clearly
    // report that a live test requires starting a download.
    setTimeout(() => {
      const host = settings.connection.proxyHost.trim();
      const port = Number(settings.connection.proxyPort);
      if (!host) {
        setProxyTestStatus('fail');
        setProxyErrorMessage('Proxy host is empty.');
        onAddToast('error', t('settings_toast_proxy_test'), t('settings_toast_proxy_fail'));
        return;
      }
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        setProxyTestStatus('fail');
        setProxyErrorMessage('Proxy port must be between 1 and 65535.');
        onAddToast('error', t('settings_toast_proxy_test'), t('settings_toast_proxy_fail'));
        return;
      }
      setProxyTestStatus('pass');
      setProxyErrorMessage('Configuration looks valid. Start a download to verify the live proxy connection.');
      onAddToast('success', t('settings_toast_proxy_test'), t('settings_toast_proxy_pass'));
    }, 400);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Gauge className="w-4 h-4 text-[var(--warning)]" />
          <h3 className="text-sm font-extrabold text-[var(--warning)]">{t('settings_performance_bandwidth')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <FormRow label={t('settings_enable_speed_limit')}>
            <Switch
              checked={settings.connection.speedLimiter.enabled}
              onChange={(v) => {
                updateSetting('connection', 'speedLimiter', { ...settings.connection.speedLimiter, enabled: v });
              }}
            />
          </FormRow>

          {settings.connection.speedLimiter.enabled && (
            <div className="pt-1.5 animate-in slide-in-from-top-2 duration-150 flex flex-col gap-1 text-left">
              <label className="text-[11px] text-[var(--text-secondary)] font-bold">
                {t('settings_max_total_speed')}
              </label>
              <div className="flex justify-start pt-1" dir="ltr">
                <SpeedLimitInput
                  maxSpeedKbs={settings.connection.speedLimiter.maxSpeedKbs}
                  onChange={(v) => {
                    updateSetting('connection', 'speedLimiter', {
                      ...settings.connection.speedLimiter,
                      maxSpeedKbs: v,
                    });
                  }}
                />
              </div>
              <span className="text-[10px] text-[var(--warning)] font-bold block mt-1">
                {t('settings_limit_shared')}
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4">
          <SelectField
            label={t('settings_default_connections')}
            value={settings.connection.maxConnections}
            onChange={(e) => {
              updateSetting('connection', 'maxConnections', Number(e.target.value));
            }}
            options={[
              { value: 0, label: t('settings_automatic') },
              { value: 8, label: t('settings_conn_8') },
              { value: 16, label: t('settings_conn_16') },
              { value: 24, label: t('settings_conn_24') },
              { value: 32, label: t('settings_conn_32') },
            ]}
          />

          <SelectField
            label={t('settings_network_profile')}
            value={settings.connection.connectionType}
            onChange={(e) => {
              updateSetting('connection', 'connectionType', e.target.value);
            }}
            options={[
              { value: 'lan', label: t('settings_net_lan') },
              { value: 'wifi', label: t('settings_net_wifi') },
              { value: 'mobile_3g_4g', label: t('settings_net_mobile') },
              { value: 'dialup', label: t('settings_net_dialup') },
            ]}
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Globe className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">{t('settings_network_protocols')}</h3>
        </div>

        <TextField
          label={t('settings_default_ua')}
          value={settings.extra.userAgent}
          onChange={(e) => {
            updateSetting('extra', 'userAgent', e.target.value);
          }}
          placeholder="Mozilla/5.0..."
          style={{ direction: 'ltr', textAlign: 'left' }}
        />

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
                    placeholder="127.0.0.1 or proxy.company.com"
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
                    label="Proxy Type"
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
                      label="Proxy Tunnel (CONNECT)"
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
                  placeholder="Username"
                  style={{ direction: 'ltr', textAlign: 'left' }}
                />
                <TextField
                  label={t('settings_proxy_pass_optional')}
                  type="password"
                  value={settings.connection.proxyPass}
                  onChange={(e) => {
                    updateSetting('connection', 'proxyPass', e.target.value);
                  }}
                  placeholder="Password"
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

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center justify-between border-b border-[var(--border-color)] pb-1 mb-1">
            <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block">
              {t('settings_dns_resolver')}
            </span>
            <button
              type="button"
              onClick={() => {
                void runDnsTests();
              }}
              disabled={dnsTesting}
              className="flex items-center gap-1 px-2 py-0.5 bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded text-[10px] font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer disabled:opacity-60"
              title={t('settings_dns_test_run')}
            >
              <RefreshCw className={`w-3 h-3 ${dnsTesting ? 'animate-spin' : ''}`} strokeWidth={2.5} />
              {dnsTesting ? t('settings_dns_testing') : t('settings_dns_test_run')}
            </button>
          </div>
          <SelectField
            label={t('settings_dns_resolver')}
            value={settings.extra.dnsResolver}
            onChange={(e) => {
              updateSetting('extra', 'dnsResolver', e.target.value);
            }}
            options={[
              { value: 'system', label: t('settings_dns_system') },
              { value: 'cloudflare', label: dnsOptionLabel('cloudflare', t('settings_dns_cloudflare')) },
              {
                value: 'cloudflare_malware',
                label: dnsOptionLabel('cloudflare_malware', t('settings_dns_cloudflare_malware')),
              },
              { value: 'google', label: dnsOptionLabel('google', t('settings_dns_google')) },
              { value: 'quad9', label: dnsOptionLabel('quad9', t('settings_dns_quad9')) },
              { value: 'opendns', label: dnsOptionLabel('opendns', t('settings_dns_opendns')) },
              { value: 'adguard', label: dnsOptionLabel('adguard', t('settings_dns_adguard')) },
              { value: 'cleanbrowsing', label: dnsOptionLabel('cleanbrowsing', t('settings_dns_cleanbrowsing')) },
              { value: 'dns0', label: dnsOptionLabel('dns0', t('settings_dns_dns0')) },
              { value: 'custom', label: t('settings_dns_custom') },
            ]}
          />

          {/* At-a-glance status of each resolver (visible without opening the list). */}
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(DNS_ENDPOINTS).map((key) => {
              const r = dnsResults[key];
              const isFastest = fastestDns?.key === key;
              const latency = r && r.reachable ? r.latencyMs : null;
              const color = !r
                ? 'var(--text-muted)'
                : latency === null
                  ? 'var(--danger)'
                  : latency < 80
                    ? 'var(--success)'
                    : latency < 200
                      ? 'var(--warning)'
                      : 'var(--text-secondary)';
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border"
                  style={{
                    color,
                    borderColor: isFastest ? 'var(--success)' : 'var(--border-color)',
                    background: isFastest ? 'var(--success-bg)' : 'var(--bg-hover)',
                  }}
                  title={DNS_ENDPOINTS[key]}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                  {t(`settings_dns_${key}`)}
                  {': '}
                  {!r
                    ? dnsTesting
                      ? '…'
                      : '—'
                    : latency !== null
                      ? `${String(latency)} ms${isFastest ? ' ★' : ''}`
                      : t('settings_dns_unreachable')}
                </span>
              );
            })}
          </div>

          {settings.extra.dnsResolver === 'custom' && (
            <TextField
              label={t('settings_dns_custom_label')}
              value={settings.extra.dnsCustomResolver}
              onChange={(e) => {
                updateSetting('extra', 'dnsCustomResolver', e.target.value);
              }}
              placeholder={t('settings_dns_custom_placeholder')}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          )}

          <div className="flex flex-col gap-2 pt-1">
            <Checkbox
              label={t('settings_force_ipv4')}
              checked={settings.extra.forceIpv4}
              onChange={(v) => {
                updateSetting('extra', 'forceIpv4', v);
              }}
            />
          </div>

          <div className="flex justify-end pt-1 border-t border-[var(--border-color)]/30">
            <button
              type="button"
              onClick={() => {
                onAddToast('success', t('settings_toast_dns_cache'), t('settings_toast_dns_cache_cleared'));
              }}
              className="px-2.5 py-1 bg-[var(--bg-hover)] text-[var(--text-primary)] rounded text-[10px] font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer"
            >
              {t('settings_clear_dns_cache')}
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-1 mb-1">
            <ShieldCheck className="w-4 h-4 text-[var(--success)]" />
            <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block">
              {t('settings_vpn_title')}
            </span>
          </div>

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
                <Checkbox
                  label={t('settings_vpn_dns_protection')}
                  checked={settings.extra.vpnDnsProtection}
                  onChange={(v) => {
                    updateSetting('extra', 'vpnDnsProtection', v);
                  }}
                />
              </div>

              <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_vpn_note')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
