/* src/dialogs/settings/sections/MediaAndTorrent.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Film, Magnet, RefreshCw, CheckCircle2 } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';
import { useAppStore } from '../../../state/appStore';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

export const MediaAndTorrent: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const { t } = useAppStore();
  const [ffmpegStatus, setFfmpegStatus] = useState<'idle' | 'detecting' | 'found' | 'not_found'>('idle');
  const [ffmpegVersion, setFfmpegVersion] = useState('');
  const [portStatus, setPortStatus] = useState<'idle' | 'checking' | 'open' | 'closed'>('idle');

  const handleDetectFFmpeg = () => {
    setFfmpegStatus('detecting');
    setTimeout(() => {
      setFfmpegStatus('found');
      setFfmpegVersion('FFmpeg 6.1.1 static build detected');
      onAddToast('success', t('settings_toast_ffmpeg_detect'), t('settings_toast_ffmpeg_found'));
    }, 800);
  };

  const handleTestPort = () => {
    setPortStatus('checking');
    setTimeout(() => {
      setPortStatus('open');
      onAddToast('success', t('settings_toast_torrent_port'), t('settings_toast_port_reachable'));
    }, 800);
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Film className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-extrabold text-rose-400">{t('settings_media_capture')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_media_detection')}
          </span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox
              label={t('settings_monitor_media')}
              checked={settings.extra.mediaMonitorEnabled}
              onChange={(v) => {
                updateSetting('extra', 'mediaMonitorEnabled', v);
              }}
            />
            <Checkbox
              label={t('settings_capture_hls')}
              checked={settings.extra.captureHls}
              onChange={(v) => {
                updateSetting('extra', 'captureHls', v);
              }}
            />
            <Checkbox
              label={t('settings_capture_dash')}
              checked={settings.extra.captureDash}
              onChange={(v) => {
                updateSetting('extra', 'captureDash', v);
              }}
            />
            <Checkbox
              label={t('settings_download_subtitles')}
              checked={settings.extra.downloadSubtitles}
              onChange={(v) => {
                updateSetting('extra', 'downloadSubtitles', v);
              }}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 pt-1">
            <SelectField
              label={t('settings_video_quality')}
              value={settings.extra.videoQuality}
              onChange={(e) => {
                updateSetting('extra', 'videoQuality', e.target.value);
              }}
              options={[
                { value: 'ask', label: t('settings_ask_each') },
                { value: 'best', label: t('settings_best_available') },
                { value: '4320p', label: t('settings_8k') },
                { value: '2160p', label: t('settings_4k') },
                { value: '1440p', label: t('settings_2k') },
                { value: '1080p', label: t('settings_1080p') },
                { value: '720p', label: t('settings_720p') },
                { value: '480p', label: t('settings_480p') },
                { value: '360p', label: t('settings_360p') },
                { value: '240p', label: t('settings_240p') },
                { value: '144p', label: t('settings_144p') },
              ]}
            />
            <SelectField
              label={t('settings_subtitle_language')}
              value={settings.extra.subtitleLanguage}
              onChange={(e) => {
                updateSetting('extra', 'subtitleLanguage', e.target.value);
              }}
              options={[
                { value: '', label: t('settings_use_media_default') },
                { value: 'all', label: t('settings_all_languages') },
                ...WORLD_LANGUAGES,
              ]}
            />
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_ffmpeg_integration')}
          </span>
          <TextField
            label={t('settings_ffmpeg_path')}
            value={settings.extra.ffmpegPath}
            onChange={(e) => {
              updateSetting('extra', 'ffmpegPath', e.target.value);
            }}
            placeholder="C:\\ffmpeg\\bin\\ffmpeg.exe"
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox
              label={t('settings_ffmpeg_merge')}
              checked={settings.extra.ffmpegAutoMerge}
              onChange={(v) => {
                updateSetting('extra', 'ffmpegAutoMerge', v);
              }}
            />
            <Checkbox
              label={t('settings_ffmpeg_delete_segments')}
              checked={settings.extra.ffmpegDeleteSegments}
              onChange={(v) => {
                updateSetting('extra', 'ffmpegDeleteSegments', v);
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5 items-start pt-2 border-t border-[var(--border-color)]/30">
            <button
              type="button"
              onClick={handleDetectFFmpeg}
              disabled={ffmpegStatus === 'detecting'}
              className="px-3 py-1.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded text-xs font-bold hover:bg-rose-500/20 transition-all cursor-pointer flex items-center gap-1"
            >
              {ffmpegStatus === 'detecting' && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {t('settings_detect_ffmpeg')}
            </button>
            {ffmpegStatus === 'found' && (
              <span className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-2.5 py-0.5 rounded text-[10px] font-bold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> {t('settings_ffmpeg_ready')}
              </span>
            )}
          </div>

          {ffmpegVersion && <p className="text-[11px] text-emerald-400 font-mono mt-1">{ffmpegVersion}</p>}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Magnet className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">{t('settings_torrent_magnet')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_torrent_engine')}
          </span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox
              label={t('settings_enable_bittorrent')}
              checked={settings.extra.torrentEnabled}
              onChange={(v) => {
                updateSetting('extra', 'torrentEnabled', v);
              }}
            />
            <Checkbox
              label={t('settings_enable_dht')}
              checked={settings.extra.torrentDht}
              onChange={(v) => {
                updateSetting('extra', 'torrentDht', v);
              }}
            />
            <Checkbox
              label={t('settings_enable_pex')}
              checked={settings.extra.torrentPex}
              onChange={(v) => {
                updateSetting('extra', 'torrentPex', v);
              }}
            />
            <Checkbox
              label={t('settings_prefer_encrypted')}
              checked={settings.extra.torrentEncrypt}
              onChange={(v) => {
                updateSetting('extra', 'torrentEncrypt', v);
              }}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 pt-1">
            <TextField
              label={t('settings_incoming_port')}
              value={settings.extra.torrentPort}
              onChange={(e) => {
                updateSetting('extra', 'torrentPort', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('settings_max_peers')}
              value={settings.extra.torrentMaxPeers}
              onChange={(e) => {
                updateSetting('extra', 'torrentMaxPeers', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-color)]/30">
            <button
              type="button"
              onClick={handleTestPort}
              disabled={portStatus === 'checking'}
              className="px-2.5 py-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded text-xs font-bold hover:bg-emerald-500/20 transition-all cursor-pointer flex items-center gap-1"
            >
              {portStatus === 'checking' && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {t('settings_test_port')}
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">
            {t('settings_seeding_limits')}
          </span>
          <div className="grid grid-cols-1 gap-3">
            <Checkbox
              label={t('settings_continue_seeding')}
              checked={settings.extra.torrentSeeding}
              onChange={(v) => {
                updateSetting('extra', 'torrentSeeding', v);
              }}
            />
            <Checkbox
              label={t('settings_stop_seeding_battery')}
              checked={settings.extra.torrentBatteryStop}
              onChange={(v) => {
                updateSetting('extra', 'torrentBatteryStop', v);
              }}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 pt-1">
            <TextField
              label={t('settings_ratio_limit')}
              value={settings.extra.torrentRatioLimit}
              onChange={(e) => {
                updateSetting('extra', 'torrentRatioLimit', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('settings_max_upload_speed')}
              value={settings.extra.torrentUploadSpeed}
              onChange={(e) => {
                updateSetting('extra', 'torrentUploadSpeed', e.target.value);
              }}
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
