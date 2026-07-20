/* src/dialogs/settings/sections/MediaAndTorrent.tsx */
import React from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { TextField, Checkbox } from '../../../components/primitives';
import { Magnet } from 'lucide-react';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const MediaAndTorrent: React.FC<Props> = ({ settings, updateSetting }) => {
  const updateTorrentSetting = (key: keyof AppSettings['extra'], _value: string | boolean) => {
    updateSetting('extra', key, typeof settings.extra[key] === 'boolean' ? false : '');
  };

  const torrentSupported = false;

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Magnet className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">Torrent / Magnet</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="rounded-md border border-[var(--warning-border)] bg-[var(--warning-bg)] p-2 text-[11px] text-[var(--text-primary)]">
            Torrent and magnet downloads are disabled in this libcurl-based build. libcurl is used for direct
            HTTP/HTTPS/FTP downloads only; add a dedicated torrent engine before enabling these controls.
          </div>
          <div className="grid grid-cols-1 gap-3 opacity-50 pointer-events-none">
            <Checkbox
              label="Enable BitTorrent"
              disabled={!torrentSupported}
              checked={false}
              onChange={(v) => {
                updateSetting('extra', 'torrentEnabled', v);
              }}
            />
            <Checkbox
              label="Enable DHT"
              disabled={!torrentSupported}
              checked={false}
              onChange={(v) => {
                updateTorrentSetting('torrentDht', v);
              }}
            />
            <Checkbox
              label="Enable PEX"
              disabled={!torrentSupported}
              checked={false}
              onChange={(v) => {
                updateTorrentSetting('torrentPex', v);
              }}
            />
            <Checkbox
              label="Prefer encrypted peers"
              disabled={!torrentSupported}
              checked={false}
              onChange={(v) => {
                updateTorrentSetting('torrentEncrypt', v);
              }}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 pt-1">
            <TextField
              label="Incoming port"
              disabled={!torrentSupported}
              value={settings.extra.torrentPort}
              onChange={(e) => {
                updateTorrentSetting('torrentPort', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Max peers"
              disabled={!torrentSupported}
              value={settings.extra.torrentMaxPeers}
              onChange={(e) => {
                updateTorrentSetting('torrentMaxPeers', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            Seeding Limits
          </span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox
              label="Continue seeding after download"
              disabled={!torrentSupported}
              checked={false}
              onChange={(v) => {
                updateTorrentSetting('torrentSeeding', v);
              }}
            />
            <Checkbox
              label="Stop seeding on battery"
              disabled={!torrentSupported}
              checked={false}
              onChange={(v) => {
                updateSetting('extra', 'torrentBatteryStop', v);
              }}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 pt-1">
            <TextField
              label="Ratio limit"
              disabled={!torrentSupported}
              value={settings.extra.torrentRatioLimit}
              onChange={(e) => {
                updateTorrentSetting('torrentRatioLimit', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label="Max upload speed"
              disabled={!torrentSupported}
              value={settings.extra.torrentUploadSpeed}
              onChange={(e) => {
                updateTorrentSetting('torrentUploadSpeed', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
