/* src/dialogs/settings/sections/DirectDownloadSettings.tsx */
import React from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Clock, Shield, Network, HardDrive } from 'lucide-react';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const DirectDownloadSettings: React.FC<Props> = ({ settings, updateSetting }) => {
  const updateDefaults = (key: keyof AppSettings['connection']['defaults'], value: unknown) => {
    updateSetting('connection', 'defaults', { ...settings.connection.defaults, [key]: value });
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* -- Timeouts & Retries -- */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Clock className="w-4 h-4 text-[var(--warning)]" />
          <h3 className="text-sm font-extrabold text-[var(--warning)]">Timeouts &amp; Retries</h3>
        </div>
        <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">
          Global defaults for all direct (libcurl) downloads. Overridable per-download.
        </p>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Timeout (s)"
              type="number"
              value={settings.connection.defaults.timeoutSec}
              onChange={(e) => {
                updateDefaults('timeoutSec', Number(e.target.value));
              }}
            />
            <TextField
              label="Connect Timeout (s)"
              type="number"
              value={settings.connection.defaults.connectTimeoutSec}
              onChange={(e) => {
                updateDefaults('connectTimeoutSec', Number(e.target.value));
              }}
            />
            <TextField
              label="Retries"
              type="number"
              value={settings.connection.defaults.retryCount}
              onChange={(e) => {
                updateDefaults('retryCount', Number(e.target.value));
              }}
            />
            <TextField
              label="Retry Delay (s)"
              type="number"
              value={settings.connection.defaults.retryDelaySec}
              onChange={(e) => {
                updateDefaults('retryDelaySec', Number(e.target.value));
              }}
            />
          </div>
        </div>
      </div>

      {/* -- Connection Tuning -- */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Network className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">Connection Tuning</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="IP Resolve"
              value={settings.connection.defaults.ipResolve}
              onChange={(e) => {
                updateDefaults('ipResolve', e.target.value);
              }}
              options={[
                { value: '', label: 'System Default' },
                { value: '4', label: 'Force IPv4' },
                { value: '6', label: 'Force IPv6' },
              ]}
            />
            <TextField
              label="Max Redirects"
              type="number"
              value={settings.connection.defaults.maxRedirs}
              onChange={(e) => {
                updateDefaults('maxRedirs', Number(e.target.value));
              }}
            />
            <TextField
              label="Keepalive Interval (s)"
              type="number"
              value={settings.connection.defaults.keepaliveTimeSec}
              onChange={(e) => {
                updateDefaults('keepaliveTimeSec', Number(e.target.value));
              }}
            />
            <TextField
              label="DNS Servers"
              value={settings.connection.defaults.dnsServers}
              onChange={(e) => {
                updateDefaults('dnsServers', e.target.value);
              }}
              placeholder="1.1.1.1, 8.8.8.8"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
        </div>
      </div>

      {/* -- HTTP / TLS -- */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Shield className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">HTTP / TLS</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="HTTP Version"
              value={settings.connection.defaults.httpVersion}
              onChange={(e) => {
                updateDefaults('httpVersion', e.target.value);
              }}
              options={[
                { value: '', label: 'Auto' },
                { value: '1.0', label: 'HTTP/1.0' },
                { value: '1.1', label: 'HTTP/1.1' },
                { value: '2', label: 'HTTP/2' },
                { value: '3', label: 'HTTP/3' },
              ]}
            />
            <SelectField
              label="TLS Min Version"
              value={settings.connection.defaults.tlsMin}
              onChange={(e) => {
                updateDefaults('tlsMin', e.target.value);
              }}
              options={[
                { value: '', label: 'Default' },
                { value: '1.0', label: 'TLS 1.0' },
                { value: '1.1', label: 'TLS 1.1' },
                { value: '1.2', label: 'TLS 1.2' },
                { value: '1.3', label: 'TLS 1.3' },
              ]}
            />
            <TextField
              label="CA Certificate Path"
              value={settings.connection.defaults.caCert}
              onChange={(e) => {
                updateDefaults('caCert', e.target.value);
              }}
              placeholder="/path/to/cacert.pem"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Client Certificate"
              value={settings.connection.defaults.clientCert}
              onChange={(e) => {
                updateDefaults('clientCert', e.target.value);
              }}
              placeholder="/path/to/client.crt"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Client Key"
              value={settings.connection.defaults.clientKey}
              onChange={(e) => {
                updateDefaults('clientKey', e.target.value);
              }}
              placeholder="/path/to/client.key"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Cipher Suites"
              value={settings.connection.defaults.ciphers}
              onChange={(e) => {
                updateDefaults('ciphers', e.target.value);
              }}
              placeholder="ECDHE+AESGCM:!aNULL"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
          <div className="flex items-center gap-6 pt-1">
            <Checkbox
              label="Skip TLS verification (insecure)"
              checked={settings.connection.defaults.insecure}
              onChange={(v) => {
                updateDefaults('insecure', v);
              }}
            />
          </div>
        </div>
      </div>

      {/* -- Disk & Memory -- */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <HardDrive className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-extrabold text-[var(--accent-primary)]">Disk &amp; Memory</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <FormRow label="Preallocate disk space">
            <Switch
              checked={settings.advanced.dynamicAllocation}
              onChange={(v) => {
                updateSetting('advanced', 'dynamicAllocation', v);
              }}
            />
          </FormRow>
          <TextField
            label="Buffer Size (KB)"
            type="number"
            value={settings.advanced.bufferSizeKb}
            onChange={(e) => {
              updateSetting('advanced', 'bufferSizeKb', Number(e.target.value));
            }}
          />
          <p className="text-[10px] text-[var(--text-muted)]">Larger buffers improve throughput but use more memory.</p>
        </div>
      </div>
    </div>
  );
};
