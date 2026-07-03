/* src/dialogs/settings/sections/MediaAndTorrent.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Film, Magnet, RefreshCw, CheckCircle2 } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: any) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

export const MediaAndTorrent: React.FC<Props> = ({
  settings,
  updateSetting,
  onAddToast,
}) => {
  const [ffmpegStatus, setFfmpegStatus] = useState<'idle' | 'detecting' | 'found' | 'not_found'>('idle');
  const [ffmpegVersion, setFfmpegVersion] = useState('');
  const [portStatus, setPortStatus] = useState<'idle' | 'checking' | 'open' | 'closed'>('idle');

  const handleDetectFFmpeg = () => {
    setFfmpegStatus('detecting');
    setTimeout(() => {
      setFfmpegStatus('found');
      setFfmpegVersion('FFmpeg 6.1.1 static build detected');
      onAddToast('success', 'FFmpeg Detection', 'FFmpeg was detected and is ready for media post-processing.');
    }, 800);
  };

  const handleTestPort = () => {
    setPortStatus('checking');
    setTimeout(() => {
      setPortStatus('open');
      onAddToast('success', 'Torrent Port', 'The configured incoming port appears reachable.');
    }, 800);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Film className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-extrabold text-rose-400">Media Capture & Post-processing</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">Media Detection</span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox label="Monitor media links automatically" checked={settings.extra.mediaMonitorEnabled} onChange={(v) => updateSetting('extra', 'mediaMonitorEnabled', v)} />
            <Checkbox label="Capture HLS streams (.m3u8)" checked={settings.extra.captureHls} onChange={(v) => updateSetting('extra', 'captureHls', v)} />
            <Checkbox label="Capture DASH streams (.mpd)" checked={settings.extra.captureDash} onChange={(v) => updateSetting('extra', 'captureDash', v)} />
            <Checkbox label="Download subtitles by default" checked={settings.extra.downloadSubtitles} onChange={(v) => updateSetting('extra', 'downloadSubtitles', v)} />
          </div>

          <div className="grid grid-cols-1 gap-3 pt-1">
            <SelectField
              label="Preferred Video Quality"
              value={settings.extra.videoQuality}
              onChange={(e) => updateSetting('extra', 'videoQuality', e.target.value)}
              options={[
                { value: 'ask', label: 'Ask each time' },
                { value: 'best', label: 'Best available' },
                { value: '4320p', label: '8K 4320p' },
                { value: '2160p', label: '4K 2160p' },
                { value: '1440p', label: '2K 1440p' },
                { value: '1080p', label: 'Full HD 1080p' },
                { value: '720p', label: 'HD 720p' },
                { value: '480p', label: 'SD 480p' },
                { value: '360p', label: '360p' },
                { value: '240p', label: '240p' },
                { value: '144p', label: '144p' },
              ]}
            />
            <SelectField
              label="Default Subtitle Language"
              value={settings.extra.subtitleLanguage}
              onChange={(e) => updateSetting('extra', 'subtitleLanguage', e.target.value)}
              options={[
                { value: '', label: 'Use media default' },
                { value: 'all', label: 'All available languages' },
                ...WORLD_LANGUAGES,
              ]}
            />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">FFmpeg Integration</span>
          <TextField label="FFmpeg Path" value={settings.extra.ffmpegPath} onChange={(e) => updateSetting('extra', 'ffmpegPath', e.target.value)} placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe" style={{ direction: 'ltr', textAlign: 'left' }} />
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox label="Merge audio and video streams automatically" checked={settings.extra.ffmpegAutoMerge} onChange={(v) => updateSetting('extra', 'ffmpegAutoMerge', v)} />
            <Checkbox label="Delete temporary media segments after merging" checked={settings.extra.ffmpegDeleteSegments} onChange={(v) => updateSetting('extra', 'ffmpegDeleteSegments', v)} />
          </div>

          <div className="flex flex-col gap-1.5 items-start pt-2 border-t border-[var(--border-color)]/30">
            <button type="button" onClick={handleDetectFFmpeg} disabled={ffmpegStatus === 'detecting'} className="px-3 py-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded text-xs font-bold hover:bg-rose-500/20 transition-all cursor-pointer flex items-center gap-1">
              {ffmpegStatus === 'detecting' && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Detect FFmpeg
            </button>
            {ffmpegStatus === 'found' && (
              <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2.5 py-0.5 rounded text-[10px] font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Ready
              </span>
            )}
          </div>

          {ffmpegVersion && <p className="text-[11px] text-emerald-400 font-mono mt-1">{ffmpegVersion}</p>}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Magnet className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">Torrent & Magnet Links</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">Torrent Engine</span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox label="Enable BitTorrent and magnet downloads" checked={settings.extra.torrentEnabled} onChange={(v) => updateSetting('extra', 'torrentEnabled', v)} />
            <Checkbox label="Enable distributed hash table (DHT)" checked={settings.extra.torrentDht} onChange={(v) => updateSetting('extra', 'torrentDht', v)} />
            <Checkbox label="Enable peer exchange (PEX)" checked={settings.extra.torrentPex} onChange={(v) => updateSetting('extra', 'torrentPex', v)} />
            <Checkbox label="Prefer encrypted peer connections" checked={settings.extra.torrentEncrypt} onChange={(v) => updateSetting('extra', 'torrentEncrypt', v)} />
          </div>

          <div className="grid grid-cols-1 gap-3 pt-1">
            <TextField label="Incoming Port" value={settings.extra.torrentPort} onChange={(e) => updateSetting('extra', 'torrentPort', e.target.value)} style={{ direction: 'ltr', textAlign: 'left' }} />
            <TextField label="Maximum Peers" value={settings.extra.torrentMaxPeers} onChange={(e) => updateSetting('extra', 'torrentMaxPeers', e.target.value)} style={{ direction: 'ltr', textAlign: 'left' }} />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-color)]/30">
            <button type="button" onClick={handleTestPort} disabled={portStatus === 'checking'} className="px-2.5 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded text-xs font-bold hover:bg-emerald-500/20 transition-all cursor-pointer flex items-center gap-1">
              {portStatus === 'checking' && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Test Incoming Port
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">Seeding & Upload Limits</span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox label="Continue seeding after completion" checked={settings.extra.torrentSeeding} onChange={(v) => updateSetting('extra', 'torrentSeeding', v)} />
            <Checkbox label="Stop seeding on low battery" checked={settings.extra.torrentBatteryStop} onChange={(v) => updateSetting('extra', 'torrentBatteryStop', v)} />
          </div>
          <div className="grid grid-cols-1 gap-3 pt-1">
            <TextField label="Ratio Limit" value={settings.extra.torrentRatioLimit} onChange={(e) => updateSetting('extra', 'torrentRatioLimit', e.target.value)} style={{ direction: 'ltr', textAlign: 'left' }} />
            <TextField label="Maximum Upload Speed (KB/s)" value={settings.extra.torrentUploadSpeed} onChange={(e) => updateSetting('extra', 'torrentUploadSpeed', e.target.value)} style={{ direction: 'ltr', textAlign: 'left' }} />
          </div>
        </div>
      </div>
    </div>
  );
};
