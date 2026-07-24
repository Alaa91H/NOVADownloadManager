import React from 'react';
import { Subtitles, Settings2, Wifi, Gauge } from 'lucide-react';
import { TextField, Switch } from '../primitives';
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
  const tabs: { id: AdvancedTab; label: string; icon: React.ReactNode; activeColor: string }[] = [
    { id: 'subtitles', label: 'Subtitles', icon: <Subtitles className="w-3 h-3" />, activeColor: 'text-[var(--info)]' },
    {
      id: 'format',
      label: 'Format',
      icon: <Settings2 className="w-3 h-3" />,
      activeColor: 'text-[var(--accent-primary)]',
    },
    { id: 'network', label: 'Network', icon: <Wifi className="w-3 h-3" />, activeColor: 'text-cyan-400' },
    { id: 'perf', label: 'Perf', icon: <Gauge className="w-3 h-3" />, activeColor: 'text-[var(--warning)]' },
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
                label="Download Subtitles"
                checked={state.downloadSubtitles}
                onChange={(v) => {
                  onChange('downloadSubtitles', v);
                }}
              />
              <Switch
                label="Auto-generated"
                checked={state.autoSubtitles}
                onChange={(v) => {
                  onChange('autoSubtitles', v);
                }}
              />
              <Switch
                label="Embed Subtitles"
                checked={state.embedSubtitles}
                onChange={(v) => {
                  onChange('embedSubtitles', v);
                }}
              />
              <Switch
                label="Write Thumbnail"
                checked={state.writeThumbnail}
                onChange={(v) => {
                  onChange('writeThumbnail', v);
                }}
              />
              <Switch
                label="Embed Thumbnail"
                checked={state.embedThumbnail}
                onChange={(v) => {
                  onChange('embedThumbnail', v);
                }}
              />
              <Switch
                label="Info JSON"
                checked={state.writeInfoJson}
                onChange={(v) => {
                  onChange('writeInfoJson', v);
                }}
              />
              <Switch
                label="Description"
                checked={state.writeDescription}
                onChange={(v) => {
                  onChange('writeDescription', v);
                }}
              />
              <Switch
                label="Split Chapters"
                checked={state.splitChapters}
                onChange={(v) => {
                  onChange('splitChapters', v);
                }}
              />
            </div>
            <TextField
              label="Subtitle Languages"
              value={state.subtitleLanguages}
              onChange={(e) => {
                onChange('subtitleLanguages', e.target.value);
              }}
              placeholder="en, ar, all"
              className="font-mono"
              style={{ direction: 'ltr', textAlign: 'left' }}
            />
          </div>
        )}

        {advancedTab === 'format' && (
          <div className="space-y-2">
            <TextField
              label="Format Selector Override"
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
              label="Format Sort"
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
              label="Download Sections"
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
              label="Match Filter"
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
              label="Remux Format"
              disabled={!supportsMediaOption('remuxFormat')}
              value={state.remuxFormat}
              onChange={(e) => {
                onChange('remuxFormat', e.target.value);
              }}
              placeholder="mp4, mkv, webm"
            />
            <TextField
              label="SponsorBlock Segments"
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
              label="Proxy"
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
              label="Cookies From Browser"
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
              label="User-Agent"
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
              label="Referer"
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
              <label className="text-[var(--text-secondary)] text-[11px] font-bold">Custom Headers</label>
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
              <label className="text-[var(--text-secondary)] text-[11px] font-bold">Cookies</label>
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
              label="Rate Limit (KB/s)"
              disabled={!supportsMediaOption('rateLimitKbs')}
              type="number"
              value={state.rateLimitKbs}
              onChange={(e) => {
                onChange('rateLimitKbs', Number(e.target.value));
              }}
              placeholder="0 = unlimited"
            />
            <TextField
              label="Retries"
              disabled={!supportsMediaOption('retries')}
              type="number"
              value={state.retries}
              onChange={(e) => {
                onChange('retries', Number(e.target.value));
              }}
            />
            <TextField
              label="Fragment Retries"
              disabled={!supportsMediaOption('fragmentRetries')}
              type="number"
              value={state.fragmentRetries}
              onChange={(e) => {
                onChange('fragmentRetries', Number(e.target.value));
              }}
            />
            <TextField
              label="Concurrent Frags"
              disabled={!supportsMediaOption('concurrentFragments')}
              type="number"
              value={state.concurrentFragments}
              onChange={(e) => {
                onChange('concurrentFragments', Number(e.target.value));
              }}
            />
            <TextField
              label="Sleep Interval (s)"
              disabled={!supportsMediaOption('sleepIntervalSec')}
              type="number"
              value={state.sleepIntervalSec}
              onChange={(e) => {
                onChange('sleepIntervalSec', Number(e.target.value));
              }}
              placeholder="0"
            />
            <TextField
              label="Max Sleep (s)"
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
