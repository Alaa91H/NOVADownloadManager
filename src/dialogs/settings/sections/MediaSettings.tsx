/* src/dialogs/settings/sections/MediaSettings.tsx */
import React from 'react';
import type { AppSettings } from '../../../types/desktop-ui.types';
import { Switch, SelectField, TextField } from '../../../components/primitives';
import { Video, Subtitles, Film } from 'lucide-react';
import { useI18n } from '../../../store/selectors';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: unknown) => void;
}

export const MediaSettings: React.FC<Props> = ({ settings, updateSetting }) => {
  const t = useI18n();
  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      {/* ── Video Quality ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Video className="w-4 h-4 text-[var(--info)]" />
          <h3 className="text-sm font-extrabold text-[var(--info)]">{t('settings_video_quality')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <SelectField
            label={t('settings_video_quality')}
            value={settings.extra.videoQuality}
            onChange={(e) => {
              updateSetting('extra', 'videoQuality', e.target.value);
            }}
            options={[
              { value: 'best', label: t('settings_best_available') },
              { value: 'good', label: t('settings_720p') },
              { value: 'worst', label: t('settings_480p') },
            ]}
          />
        </div>
      </div>

      {/* ── Subtitles ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Subtitles className="w-4 h-4 text-[var(--success)]" />
          <h3 className="text-sm font-extrabold text-[var(--success)]">{t('media_adv_tab_subtitles')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <div className="flex items-center justify-between py-2">
            <span className="text-xs font-bold text-[var(--text-primary)]">{t('media_adv_download_subtitles')}</span>
            <Switch
              checked={settings.extra.downloadSubtitles}
              onChange={(v) => {
                updateSetting('extra', 'downloadSubtitles', v);
              }}
            />
          </div>
          <TextField
            label={t('settings_subtitle_language')}
            value={settings.extra.subtitleLanguage}
            onChange={(e) => {
              updateSetting('extra', 'subtitleLanguage', e.target.value);
            }}
            placeholder={t('media_adv_subtitle_languages_placeholder')}
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_all_languages')}</p>
        </div>
      </div>

      {/* ── FFmpeg ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Film className="w-4 h-4 text-[var(--warning)]" />
          <h3 className="text-sm font-extrabold text-[var(--warning)]">{t('settings_ffmpeg_integration')}</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <TextField
            label={t('settings_ffmpeg_path')}
            value={settings.extra.ffmpegPath}
            onChange={(e) => {
              updateSetting('extra', 'ffmpegPath', e.target.value);
            }}
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
          <div className="flex items-center justify-between py-2">
            <span className="text-xs font-bold text-[var(--text-primary)]">{t('settings_ffmpeg_merge')}</span>
            <Switch
              checked={settings.extra.ffmpegAutoMerge}
              onChange={(v) => {
                updateSetting('extra', 'ffmpegAutoMerge', v);
              }}
            />
          </div>
          <p className="text-[10px] text-[var(--text-muted)] leading-relaxed">{t('settings_ffmpeg_delete_segments')}</p>
        </div>
      </div>
    </div>
  );
};
