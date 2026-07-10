/* src/dialogs/settings/sections/MediaDownloadSettings.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { TextField, SelectField, Checkbox } from '../../../components/primitives';
import { Video, Film, FileText, RefreshCw, CheckCircle2 } from 'lucide-react';
import { WORLD_LANGUAGES } from '../../../lib/languages';
import { useAppStore } from '../../../state/appStore';
import { novaClient } from '../../../api/novaClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

export const MediaDownloadSettings: React.FC<Props> = ({ settings, updateSetting, onAddToast }) => {
  const { t } = useAppStore();
  const [ffmpegStatus, setFfmpegStatus] = useState<'idle' | 'detecting' | 'found' | 'not_found'>('idle');
  const [ffmpegVersion, setFfmpegVersion] = useState('');

  const handleDetectFFmpeg = () => {
    setFfmpegStatus('detecting');
    void novaClient
      .checkFfmpeg()
      .then((status) => {
        if (status.available) {
          setFfmpegStatus('found');
          setFfmpegVersion(
            status.versionText || status.version || `FFmpeg available at ${status.binary || 'runtime path'}`,
          );
          onAddToast('success', t('settings_toast_ffmpeg_detect'), t('settings_toast_ffmpeg_found'));
        } else {
          setFfmpegStatus('not_found');
          setFfmpegVersion('');
          onAddToast(
            'warning',
            t('settings_toast_ffmpeg_detect'),
            'FFmpeg was not found in the bundled resources or PATH.',
          );
        }
      })
      .catch(() => {
        setFfmpegStatus('not_found');
        setFfmpegVersion('');
        onAddToast('error', t('settings_toast_ffmpeg_detect'), 'Could not query the daemon for FFmpeg runtime status.');
      });
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* ── Quality & Format ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Video className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-extrabold text-rose-400">Quality &amp; Format</h3>
        </div>
        <p className="text-[10px] text-slate-400 leading-relaxed">
          Default media download behavior. Overridable per-download.
        </p>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <SelectField
            label="Default Video Quality"
            value={settings.extra.videoQuality}
            onChange={(e) => updateSetting('extra', 'videoQuality', e.target.value)}
            options={[
              { value: 'ask', label: 'Ask Each Time' },
              { value: 'best', label: 'Best Available' },
              { value: '4320p', label: '8K (4320p)' },
              { value: '2160p', label: '4K (2160p)' },
              { value: '1440p', label: '2K (1440p)' },
              { value: '1080p', label: '1080p' },
              { value: '720p', label: '720p' },
              { value: '480p', label: '480p' },
              { value: '360p', label: '360p' },
              { value: '240p', label: '240p' },
              { value: '144p', label: '144p' },
            ]}
          />
        </div>
      </div>

      {/* ── Subtitles & Languages ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <FileText className="w-4 h-4 text-blue-500" />
          <h3 className="text-sm font-extrabold text-blue-400">Subtitles &amp; Languages</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <Checkbox
            label="Download subtitles with media"
            checked={settings.extra.downloadSubtitles}
            onChange={(v) => updateSetting('extra', 'downloadSubtitles', v)}
          />
          <SelectField
            label="Subtitle Language"
            value={settings.extra.subtitleLanguage}
            onChange={(e) => updateSetting('extra', 'subtitleLanguage', e.target.value)}
            options={[
              { value: '', label: 'Use media default' },
              { value: 'all', label: 'All languages' },
              ...WORLD_LANGUAGES,
            ]}
          />
        </div>
      </div>

      {/* ── Media Detection ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Film className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-extrabold text-emerald-400">Stream Detection</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <Checkbox
            label="Monitor clipboard for media URLs"
            checked={settings.extra.mediaMonitorEnabled}
            onChange={(v) => updateSetting('extra', 'mediaMonitorEnabled', v)}
          />
          <Checkbox
            label="Capture HLS streams"
            checked={settings.extra.captureHls}
            onChange={(v) => updateSetting('extra', 'captureHls', v)}
          />
          <Checkbox
            label="Capture DASH streams"
            checked={settings.extra.captureDash}
            onChange={(v) => updateSetting('extra', 'captureDash', v)}
          />
        </div>
      </div>

      {/* ── FFmpeg Integration ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <RefreshCw className="w-4 h-4 text-purple-500" />
          <h3 className="text-sm font-extrabold text-purple-400">FFmpeg Integration</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <TextField
            label="FFmpeg Binary Path"
            value={settings.extra.ffmpegPath}
            onChange={(e) => updateSetting('extra', 'ffmpegPath', e.target.value)}
            placeholder="Leave empty to use bundled FFmpeg"
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
          <Checkbox
            label="Auto-merge audio + video segments"
            checked={settings.extra.ffmpegAutoMerge}
            onChange={(v) => updateSetting('extra', 'ffmpegAutoMerge', v)}
          />
          <Checkbox
            label="Delete segments after merge"
            checked={settings.extra.ffmpegDeleteSegments}
            onChange={(v) => updateSetting('extra', 'ffmpegDeleteSegments', v)}
          />

          <div className="flex flex-col gap-1.5 items-start pt-2 border-t border-[var(--border-color)]/30">
            <button
              type="button"
              onClick={handleDetectFFmpeg}
              disabled={ffmpegStatus === 'detecting'}
              className="px-3 py-1.5 bg-purple-500/10 border border-purple-500/20 text-purple-400 rounded text-xs font-bold hover:bg-purple-500/20 transition-all cursor-pointer flex items-center gap-1"
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
    </div>
  );
};
