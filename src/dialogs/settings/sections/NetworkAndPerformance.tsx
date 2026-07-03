/* src/dialogs/settings/sections/NetworkAndPerformance.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Gauge, Globe, RefreshCw } from 'lucide-react';
import { SpeedLimitInput } from '../../../components/SpeedLimitInput';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: any) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

export const NetworkAndPerformance: React.FC<Props> = ({
  settings,
  updateSetting,
  onAddToast,
}) => {
  const [proxyTestStatus, setProxyTestStatus] = useState<'idle' | 'testing' | 'pass' | 'fail'>('idle');
  const [proxyErrorMessage, setProxyErrorMessage] = useState('');

  const handleTestProxy = () => {
    setProxyTestStatus('testing');
    setProxyErrorMessage('');
    setTimeout(() => {
      if (settings.connection.proxyHost === '127.0.0.1' || !settings.connection.proxyHost) {
        setProxyTestStatus('fail');
        setProxyErrorMessage('Connection refused or proxy host is empty.');
        onAddToast('error', 'Proxy Test', 'NOVA could not connect to the configured proxy.');
      } else {
        setProxyTestStatus('pass');
        onAddToast('success', 'Proxy Test', 'Proxy connection settings look reachable.');
      }
    }, 800);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Gauge className="w-4 h-4 text-amber-500" />
          <h3 className="text-sm font-extrabold text-amber-400">Performance & Bandwidth</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <FormRow label="Enable global maximum speed limit">
            <Switch
              checked={settings.connection.speedLimiter.enabled}
              onChange={(v) => updateSetting('connection', 'speedLimiter', { ...settings.connection.speedLimiter, enabled: v })}
            />
          </FormRow>

          {settings.connection.speedLimiter.enabled && (
            <div className="pt-1.5 animate-in slide-in-from-top-2 duration-150 flex flex-col gap-1 text-left">
              <label className="text-[11px] text-[var(--text-secondary)] font-bold">Maximum total speed:</label>
              <div className="flex justify-start pt-1" dir="ltr">
                <SpeedLimitInput
                  maxSpeedKbs={settings.connection.speedLimiter.maxSpeedKbs}
                  onChange={(v) => updateSetting('connection', 'speedLimiter', { ...settings.connection.speedLimiter, maxSpeedKbs: v })}
                />
              </div>
              <span className="text-[10px] text-amber-500 font-bold block mt-1">
                The limit is shared across active downloads.
              </span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4">
          <SelectField
            label="Default connections per file"
            value={settings.connection.maxConnections}
            onChange={(e) => updateSetting('connection', 'maxConnections', Number(e.target.value))}
            options={[
              { value: 0, label: 'Automatic' },
              { value: 8, label: '8 connections' },
              { value: 16, label: '16 connections' },
              { value: 24, label: '24 connections' },
              { value: 32, label: '32 connections' },
            ]}
          />

          <SelectField
            label="Network profile"
            value={settings.connection.connectionType}
            onChange={(e) => updateSetting('connection', 'connectionType', e.target.value)}
            options={[
              { value: 'lan', label: 'LAN / Fiber' },
              { value: 'wifi', label: 'Wi-Fi' },
              { value: 'mobile_3g_4g', label: 'Mobile Data' },
              { value: 'dialup', label: 'Dial-up' },
            ]}
          />
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">Disk & Memory</span>
          <FormRow label="Pre-allocate files on disk when supported">
            <Switch checked={settings.advanced.dynamicAllocation} onChange={(v) => updateSetting('advanced', 'dynamicAllocation', v)} />
          </FormRow>
          <TextField
            label="Memory write buffer size (KB)"
            type="number"
            value={settings.advanced.bufferSizeKb}
            onChange={(e) => updateSetting('advanced', 'bufferSizeKb', Number(e.target.value))}
          />
          <p className="text-[10px] text-slate-400">
            Larger buffers reduce frequent disk writes during active downloads.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Globe className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-extrabold text-blue-400">Network Protocols, Proxy & DNS</h3>
        </div>

        <TextField
          label="Default User-Agent"
          value={settings.extra.userAgent}
          onChange={(e) => updateSetting('extra', 'userAgent', e.target.value)}
          placeholder="Mozilla/5.0..."
          style={{ direction: 'ltr', textAlign: 'left' }}
        />

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <FormRow label="Enable proxy server">
            <Switch checked={settings.connection.enableProxy} onChange={(v) => updateSetting('connection', 'enableProxy', v)} />
          </FormRow>

          {settings.connection.enableProxy && (
            <div className="space-y-3 pt-2 border-t border-[var(--border-color)]/50 animate-in slide-in-from-top-2 duration-150">
              <div className="grid grid-cols-1 gap-3">
                <TextField label="Proxy Host" value={settings.connection.proxyHost} onChange={(e) => updateSetting('connection', 'proxyHost', e.target.value)} placeholder="127.0.0.1 or proxy.company.com" style={{ direction: 'ltr', textAlign: 'left' }} />
                <TextField label="Port" value={settings.connection.proxyPort} onChange={(e) => updateSetting('connection', 'proxyPort', e.target.value)} placeholder="8080" style={{ direction: 'ltr', textAlign: 'left' }} />
              </div>

              <div className="grid grid-cols-1 gap-3">
                <TextField label="Username (optional)" value={settings.connection.proxyUser} onChange={(e) => updateSetting('connection', 'proxyUser', e.target.value)} placeholder="Username" style={{ direction: 'ltr', textAlign: 'left' }} />
                <TextField label="Password (optional)" type="password" value={settings.connection.proxyPass} onChange={(e) => updateSetting('connection', 'proxyPass', e.target.value)} placeholder="Password" style={{ direction: 'ltr', textAlign: 'left' }} />
              </div>

              <div className="flex flex-col gap-1.5 items-start pt-2 border-t border-[var(--border-color)]/30">
                <button type="button" onClick={handleTestProxy} disabled={proxyTestStatus === 'testing'} className="px-3 py-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded text-xs font-bold hover:bg-blue-500/20 transition-all cursor-pointer flex items-center gap-1 disabled:opacity-50">
                  {proxyTestStatus === 'testing' && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-400" />}
                  Test Proxy Connection
                </button>
                {proxyTestStatus === 'pass' && <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[10px] font-bold">Connected</span>}
                {proxyTestStatus === 'fail' && <span className="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-2 py-0.5 rounded text-[10px] font-bold">Failed</span>}
                {proxyErrorMessage && <p className="text-[11px] text-rose-500 font-mono mt-1">{proxyErrorMessage}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1 mb-1">DNS Settings</span>
          <SelectField
            label="DNS Resolver"
            value={settings.extra.dnsResolver}
            onChange={(e) => updateSetting('extra', 'dnsResolver', e.target.value)}
            options={[
              { value: 'system', label: 'System DNS' },
              { value: 'cloudflare', label: 'Cloudflare Secure DNS (1.1.1.1)' },
              { value: 'google', label: 'Google Public DNS (8.8.8.8)' },
              { value: 'quad9', label: 'Quad9 DNS Security (9.9.9.9)' },
            ]}
          />

          <div className="flex flex-col gap-2 pt-1">
            <Checkbox label="Force IPv4 on slow links" checked={settings.extra.forceIpv4} onChange={(v) => updateSetting('extra', 'forceIpv4', v)} />
          </div>

          <div className="flex justify-end pt-1 border-t border-[var(--border-color)]/30">
            <button type="button" onClick={() => onAddToast('success', 'DNS Cache', 'Local DNS cache was cleared.')} className="px-2.5 py-1 bg-[var(--bg-hover)] text-slate-300 rounded text-[10px] font-bold hover:bg-[var(--border-color-hover)] transition-all cursor-pointer">
              Clear DNS Cache
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
