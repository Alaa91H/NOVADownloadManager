import React from 'react';
import { Subtitles, Settings2, Wifi, Gauge } from 'lucide-react';
import { TextField, Switch } from '../primitives';
import { useI18n } from '../../store/selectors';
import type { AdvancedTab } from './mediaHelpers';

export interface AdvancedState {
  downloadSubtitles: boolean;
  autoSubtitles: boolean;
  embedSubtitles: boolean;
  writeThumbnail: boolean;
  embedThumbnail: boolean;
  writeInfoJson: boolean;
  writeDescription: boolean;
  splitChapters: boolean;
  subtitleLanguages: string;
  formatSelectorOverride: string;
  formatSort: string;
  downloadSections: string;
  matchFilter: string;
  remuxFormat: string;
  sponsorBlock: string;
  mediaProxy: string;
  cookiesFromBrowser: string;
  mediaUserAgent: string;
  mediaReferer: string;
  mediaHeaders: string;
  mediaCookies: string;
  rateLimitKbs: number;
  retries: number;
  fragmentRetries: number;
  concurrentFragments: number;
  sleepIntervalSec: number;
  maxSleepIntervalSec: number;
}

interface AdvancedTabsProps {
  advancedTab: AdvancedTab;
  onTabChange: (tab: AdvancedTab) => void;
  state: AdvancedState;
  onChange: <K extends keyof AdvancedState>(key: K, value: AdvancedState[K]) => void;
  supportsMediaOption: (key: string) => boolean;
}

export const AdvancedTabs: React.FC<AdvancedTabsProps> = ({
  advancedTab,
  onTabChange,
  state,
  onChange,
  supportsMediaOption,
}) => {
  const t = useI18n();
  const tabs: { id: AdvancedTab; label: string; icon: React.ReactNode; activeColor: string }[] = [
    {
      id: 'subtitles',
      label: t('media_adv_tab_subtitles'),
      icon: <Subtitles className="w-3 h-3" />,
      activeColor: 'text-[var(--info)]',
    },
    {
      id: 'format',
      label: t('media_adv_tab_format'),
      icon: <Settings2 className="w-3 h-3" />,
      activeColor: 'text-[var(--accent-primary)]',
    },
    {
      id: 'network',
      label: t('media_adv_tab_network'),
      icon: <Wifi className="w-3 h-3" />,
      activeColor: 'text-cyan-400',
    },
    {
      id: 'perf',
      label: t('media_adv_tab_performance'),
      icon: <Gauge className="w-3 h-3" />,
      activeColor: 'text-[var(--warning)]',
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      {/* Tab pill bar */}
      <div className="flex gap-1 p-1 bg-[var(--bg-hover)]/20 rounded-lg border border-[var(--border-color)]/30">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              onTabChange(tab.id);
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[10px] font-bold transition-all cursor-pointer ${
              advancedTab === tab.id
                ? `bg-[var(--bg-surface-elevated)] ${tab.activeColor} shadow-sm`
                : 'text-[var(--text-secondary)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content panel */}
      <div className="bg-[var(--bg-hover)]/10 border border-[var(--border-color)]/20 rounded-xl p-3 space-y-2.5">
        {advancedTab === 'subtitles' && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <Switch
                label={t('media_adv_download_subtitles')}
                checked={state.downloadSubtitles}
                onChange={(v) => {
                  onChange('downloadSubtitles', v);
                }}
              />
              <Switch
                label={t('media_adv_auto_generated')}
                checked={state.autoSubtitles}
                onChange={(v) => {
                  onChange('autoSubtitles', v);
                }}
              />
              <Switch
                label={t('media_adv_embed_subtitles')}
                checked={state.embedSubtitles}
                onChange={(v) => {
                  onChange('embedSubtitles', v);
                }}
              />
              <Switch
                label={t('media_adv_write_thumbnail')}
                checked={state.writeThumbnail}
                onChange={(v) => {
                  onChange('writeThumbnail', v);
                }}
              />
              <Switch
                label={t('media_adv_embed_thumbnail')}
                checked={state.embedThumbnail}
                onChange={(v) => {
                  onChange('embedThumbnail', v);
                }}
              />
              <Switch
                label={t('media_adv_write_info_json')}
                checked={state.writeInfoJson}
                onChange={(v) => {
                  onChange('writeInfoJson', v);
                }}
              />
              <Switch
                label={t('media_adv_write_description')}
                checked={state.writeDescription}
                onChange={(v) => {
                  onChange('writeDescription', v);
                }}
              />
              <Switch
                label={t('media_adv_split_chapters')}
                checked={state.splitChapters}
                onChange={(v) => {
                  onChange('splitChapters', v);
                }}
              />
            </div>
            <TextField
              label={t('media_adv_subtitle_languages')}
              value={state.subtitleLanguages}
              onChange={(e) => {
                onChange('subtitleLanguages', e.target.value);
              }}
              placeholder={t('media_adv_subtitle_languages_placeholder')}
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
        )}

        {advancedTab === 'format' && (
          <div className="space-y-2">
            <TextField
              label={t('media_adv_format_selector')}
              disabled={!supportsMediaOption('formatSelector')}
              value={state.formatSelectorOverride}
              onChange={(e) => {
                onChange('formatSelectorOverride', e.target.value);
              }}
              placeholder="bestvideo+bestaudio/best"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_format_sort')}
              disabled={!supportsMediaOption('formatSort')}
              value={state.formatSort}
              onChange={(e) => {
                onChange('formatSort', e.target.value);
              }}
              placeholder="res,codec:avc:m4a"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_download_sections')}
              disabled={!supportsMediaOption('downloadSections')}
              value={state.downloadSections}
              onChange={(e) => {
                onChange('downloadSections', e.target.value);
              }}
              placeholder="*00:01:00-00:03:00"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_match_filter')}
              disabled={!supportsMediaOption('matchFilter')}
              value={state.matchFilter}
              onChange={(e) => {
                onChange('matchFilter', e.target.value);
              }}
              placeholder="duration < 3600"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_remux_format')}
              disabled={!supportsMediaOption('remuxFormat')}
              value={state.remuxFormat}
              onChange={(e) => {
                onChange('remuxFormat', e.target.value);
              }}
              placeholder="mp4, mkv, webm"
            />
            <TextField
              label={t('media_adv_sponsorblock_segments')}
              disabled={!supportsMediaOption('sponsorBlock')}
              value={state.sponsorBlock}
              onChange={(e) => {
                onChange('sponsorBlock', e.target.value);
              }}
              placeholder="sponsor, selfpromo"
            />
          </div>
        )}

        {advancedTab === 'network' && (
          <div className="space-y-2">
            <TextField
              label={t('media_adv_proxy')}
              disabled={!supportsMediaOption('proxy')}
              value={state.mediaProxy}
              onChange={(e) => {
                onChange('mediaProxy', e.target.value);
              }}
              placeholder="http://127.0.0.1:8080"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_cookies_from_browser')}
              disabled={!supportsMediaOption('cookiesFromBrowser')}
              value={state.cookiesFromBrowser}
              onChange={(e) => {
                onChange('cookiesFromBrowser', e.target.value);
              }}
              placeholder="chrome, edge, firefox"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_user_agent')}
              disabled={!supportsMediaOption('userAgent')}
              value={state.mediaUserAgent}
              onChange={(e) => {
                onChange('mediaUserAgent', e.target.value);
              }}
              placeholder="Mozilla/5.0 ..."
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <TextField
              label={t('media_adv_referer')}
              disabled={!supportsMediaOption('referer')}
              value={state.mediaReferer}
              onChange={(e) => {
                onChange('mediaReferer', e.target.value);
              }}
              placeholder="https://example.com/page"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[11px] font-bold">
                {t('media_adv_custom_headers')}
              </label>
              <textarea
                rows={2}
                value={state.mediaHeaders}
                onChange={(e) => {
                  onChange('mediaHeaders', e.target.value);
                }}
                placeholder={'Header-Name: value'}
                disabled={!supportsMediaOption('headers')}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus-visible:outline-none focus:border-[var(--accent-primary)] resize-none disabled:opacity-40"
                style={{ direction: 'ltr' }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[var(--text-secondary)] text-[11px] font-bold">{t('media_adv_cookies')}</label>
              <textarea
                rows={2}
                value={state.mediaCookies}
                onChange={(e) => {
                  onChange('mediaCookies', e.target.value);
                }}
                placeholder={'name=value  or  C:\\path\\cookies.txt'}
                disabled={!supportsMediaOption('cookies')}
                className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-md text-[11px] font-mono text-left text-[var(--text-primary)] p-2 focus-visible:outline-none focus:border-[var(--accent-primary)] resize-none disabled:opacity-40"
                style={{ direction: 'ltr' }}
              />
            </div>
          </div>
        )}

        {advancedTab === 'perf' && (
          <div className="grid grid-cols-2 gap-2">
            <TextField
              label={t('media_adv_rate_limit_kbs')}
              disabled={!supportsMediaOption('rateLimitKbs')}
              type="number"
              value={state.rateLimitKbs}
              onChange={(e) => {
                onChange('rateLimitKbs', Number(e.target.value));
              }}
              placeholder={t('media_adv_unlimited')}
            />
            <TextField
              label={t('media_adv_retries')}
              disabled={!supportsMediaOption('retries')}
              type="number"
              value={state.retries}
              onChange={(e) => {
                onChange('retries', Number(e.target.value));
              }}
            />
            <TextField
              label={t('media_adv_fragment_retries')}
              disabled={!supportsMediaOption('fragmentRetries')}
              type="number"
              value={state.fragmentRetries}
              onChange={(e) => {
                onChange('fragmentRetries', Number(e.target.value));
              }}
            />
            <TextField
              label={t('media_adv_concurrent_fragments')}
              disabled={!supportsMediaOption('concurrentFragments')}
              type="number"
              value={state.concurrentFragments}
              onChange={(e) => {
                onChange('concurrentFragments', Number(e.target.value));
              }}
            />
            <TextField
              label={t('media_adv_sleep_interval_seconds')}
              disabled={!supportsMediaOption('sleepIntervalSec')}
              type="number"
              value={state.sleepIntervalSec}
              onChange={(e) => {
                onChange('sleepIntervalSec', Number(e.target.value));
              }}
              placeholder="0"
            />
            <TextField
              label={t('media_adv_max_sleep_seconds')}
              disabled={!supportsMediaOption('maxSleepIntervalSec')}
              type="number"
              value={state.maxSleepIntervalSec}
              onChange={(e) => {
                onChange('maxSleepIntervalSec', Number(e.target.value));
              }}
              placeholder="0"
            />
          </div>
        )}
      </div>
    </div>
  );
};
