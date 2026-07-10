/* src/dialogs/settings/sections/NetworkAndPerformance.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Globe, RefreshCw, ShieldCheck, Gauge } from 'lucide-react';
import { SpeedLimitInput } from '../../../components/SpeedLimitInput';
import { useAppStore } from '../../../state/appStore';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

export const NetworkAndPerformance: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const { t } = useAppStore();
  const [proxyTestStatus, setProxyTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const [proxyErrorMessage, setProxyErrorMessage] = useState('');

  const handleTestProxy = () => {
    setProxyTestStatus('testing');
    setProxyErrorMessage('');
    setTimeout(() => {
      if (settings.connection.proxyHost === '127.0.0.1' || !settings.connection.proxyHost) {
        setProxyTestStatus('fail');
        setProxyErrorMessage('Connection refused or proxy host is empty.');
        onAddToast('error', t('settings_toast_proxy_test'), t('settings_toast_proxy_fail'));
      } else {
        setProxyTestStatus('pass');
        onAddToast('success', t('settings_toast_proxy_test'), t('settings_toast_proxy_pass'));
      }
    }, 800);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Gauge className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-extrabold text-amber-400">{t('settings_performance_bandwidth')}</h3>
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
              <span className="text-[10px] text-amber-500 font-bold block mt-1">{t('settings_limit_shared')}</span>
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
          <Globe className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-extrabold text-blue-400">{t('settings_network_protocols')}</h3>
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
                  className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded text-xs font-bold hover:bg-blue-500/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50"
                >
                  {proxyTestStatus === 'testing' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />}
                  {t('settings_test_proxy')}
                </button>
                {proxyTestStatus === 'pass' && (
                  <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-bold">
                    {t('settings_proxy_connected')}
                  </span>
                )}
                {proxyTestStatus === 'fail' && (
                  <span className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-2 py-0.5 rounded text-[10px] font-bold">
                    {t('settings_proxy_failed')}
                  </span>
                )}
                {proxyErrorMessage && <p className="text-[11px] text-rose-500 font-mono mt-1">{proxyErrorMessage}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">
            {t('settings_dns_resolver')}
          </span>
          <SelectField
            label={t('settings_dns_resolver')}
            value={settings.extra.dnsResolver}
            onChange={(e) => {
              updateSetting('extra', 'dnsResolver', e.target.value);
            }}
            options={[
              { value: 'system', label: t('settings_dns_system') },
              { value: 'cloudflare', label: t('settings_dns_cloudflare') },
              { value: 'cloudflare_malware', label: t('settings_dns_cloudflare_malware') },
              { value: 'google', label: t('settings_dns_google') },
              { value: 'quad9', label: t('settings_dns_quad9') },
              { value: 'opendns', label: t('settings_dns_opendns') },
              { value: 'adguard', label: t('settings_dns_adguard') },
              { value: 'cleanbrowsing', label: t('settings_dns_cleanbrowsing') },
              { value: 'dns0', label: t('settings_dns_dns0') },
              { value: 'custom', label: t('settings_dns_custom') },
            ]}
          />

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
              className="px-2.5 py-1 bg-[var(--bg-hover)] text-slate-300 rounded text-[10px] font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer"
            >
              {t('settings_clear_dns_cache')}
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-1 mb-1">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
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

              <p className="text-[10px] text-slate-400 leading-relaxed">{t('settings_vpn_note')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
