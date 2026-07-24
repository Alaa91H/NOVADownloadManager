/* src/dialogs/settings/sections/NetworkAndPerformance.tsx */
import React, { useState } from 'react';
import { Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Checkbox, FormRow, SelectField, Switch, TextField } from '../../../components/primitives';
import { useI18n } from '../../../store/selectors';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'warning' | 'info', title: string, message: string) => void;
}

export const NetworkAndPerformance: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const t = useI18n();
  const [proxyTestStatus, setProxyTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const [proxyErrorMessage, setProxyErrorMessage] = useState('');

  const handleTestProxy = () => {
    setProxyTestStatus('testing');
    setProxyErrorMessage('');
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
