/* src/dialogs/settings/SettingsDialog.tsx */
import React, { useState } from 'react';
import { Settings, Globe, Search, X, Palette, Monitor, Video, Bot, Package, ScrollText, Database } from 'lucide-react';
import {
  useDialogData,
  useSettingsData,
  useSettingsActions,
  useThemeData,
  useToastActions,
  useI18n,
} from '../../store/selectors';
import type { AppSettings } from '../../types/desktop-ui.types';
import { initialSettings } from '../../initialData';
import { playAppSound } from '../../utils/sound';
import { tauriClient } from '../../api/tauriClient';

import { GeneralSettings } from './sections/GeneralSettings';
import { DownloadSettings } from './sections/DownloadSettings';
import { NetworkAndPerformance } from './sections/NetworkAndPerformance';
import { AppearanceSettings } from './sections/AppearanceSettings';
import { BrowserSettings } from './sections/BrowserSettings';
import { MediaSettings } from './sections/MediaSettings';
import { TelegramBotSettings } from './sections/TelegramBotSettings';
import { ExternalToolsSettings } from './sections/ExternalToolsSettings';

import { LoggingSettings } from './sections/LoggingSettings';
import { BackupResetSettings } from './sections/BackupResetSettings';

type SettingsTabId =
  | 'general'
  | 'downloads'
  | 'network'
  | 'appearance'
  | 'browser'
  | 'media'
  | 'telegram'
  | 'external_tools'
  | 'logging'
  | 'backup';

type SettingsDialogPayload = {
  tab?: SettingsTabId;
};

const isSettingsPayload = (payload: unknown): payload is SettingsDialogPayload =>
  Boolean(payload && typeof payload === 'object');

interface TabDef {
  id: SettingsTabId;
  labelKey: string;
  icon: typeof Settings;
  keywords: string[];
}

export const SettingsDialog: React.FC = () => {
  const dialog = useDialogData();
  const settings = useSettingsData();
  const { updateSettings } = useSettingsActions();
  const { updateThemeSettings } = useSettingsActions();
  const themeSettings = useThemeData();
  const { addToast } = useToastActions();
  const t = useI18n();
  const payload = isSettingsPayload(dialog.payload) ? dialog.payload : {};
  const [localSettings, setLocalSettings] = useState<AppSettings>(structuredClone(settings));
  const [activeTab, setActiveTab] = useState<SettingsTabId>(payload.tab || 'general');
  const [searchQuery, setSearchQuery] = useState('');

  const REJECTED_KEY_PATTERN = /[^a-zA-Z0-9_]/;
  const updateLocalSetting = (section: keyof AppSettings, key: string, value: unknown) => {
    if (REJECTED_KEY_PATTERN.test(key)) return;
    const updated = { ...localSettings };
    if (typeof updated[section] === 'object') {
      (updated[section] as Record<string, unknown>)[key] = value;
    } else {
      (updated as Record<string, unknown>)[section] = value;
    }
    setLocalSettings(updated);
    updateSettings(updated, true);
  };

  const handleResetDaemonTabSilent = () => {
    const updatedSettings = {
      ...localSettings,
      extra: {
        ...localSettings.extra,
        autoReconnectDaemon: true,
        enableSse: true,
        daemonPort: '3199',
      },
    };
    setLocalSettings(updatedSettings);
    updateSettings(updatedSettings, true);
  };

  const handleResetAllSilent = () => {
    const defaults = structuredClone(initialSettings);
    setLocalSettings(defaults);
    updateSettings(defaults, true);
  };

  const handleTestNotification = () => {
    playAppSound(localSettings, 'complete');
    void tauriClient.triggerNativeNotification('Test notification', 'This is a test from NOVA Download Manager.');
  };

  const mainTabs: TabDef[] = [
    {
      id: 'general',
      labelKey: 'set_tab_general',
      icon: Settings,
      keywords: ['general', 'language', 'update'],
    },
    {
      id: 'downloads',
      labelKey: 'all_downloads',
      icon: Globe,
      keywords: ['download', 'folder', 'category', 'file type', 'duplicate', 'sound', 'reset'],
    },
    {
      id: 'network',
      labelKey: 'set_tab_network',
      icon: Globe,
      keywords: ['network', 'proxy', 'vpn', 'connection', 'dns', 'speed', 'bandwidth'],
    },
    {
      id: 'appearance',
      labelKey: 'settings_appearance',
      icon: Palette,
      keywords: ['appearance', 'theme', 'density', 'accent', 'color', 'contrast', 'progress'],
    },
    {
      id: 'browser',
      labelKey: 'browser',
      icon: Monitor,
      keywords: ['browser', 'extension', 'chrome', 'edge', 'firefox', 'clipboard', 'intercept', 'hls', 'dash'],
    },
    {
      id: 'media',
      labelKey: 'grabber_filter_media',
      icon: Video,
      keywords: ['media', 'video', 'quality', 'subtitle', 'ffmpeg'],
    },
    {
      id: 'telegram',
      labelKey: 'set_sub_telegram',
      icon: Bot,
      keywords: ['telegram', 'bot', 'tg', 'chat', 'command', 'cli'],
    },
    {
      id: 'external_tools',
      labelKey: 'set_tab_engines',
      icon: Package,
      keywords: ['external', 'tool', 'yt-dlp', 'ytdlp', 'ffmpeg', 'install', 'update'],
    },

    {
      id: 'logging',
      labelKey: 'settings_logging_title',
      icon: ScrollText,
      keywords: ['logging', 'log', 'debug', 'trace', 'error'],
    },
    {
      id: 'backup',
      labelKey: 'settings_backup_restore',
      icon: Database,
      keywords: ['backup', 'restore', 'export', 'import', 'factory', 'reset'],
    },
  ];

  const filteredTabs = searchQuery
    ? mainTabs.filter((tab) => {
        const term = searchQuery.toLowerCase();
        if (t(tab.labelKey).toLocaleLowerCase().includes(term)) return true;
        return tab.keywords.some((k) => k.includes(term));
      })
    : mainTabs;

  if (searchQuery && filteredTabs.length > 0 && filteredTabs[0].id !== activeTab) {
    setActiveTab(filteredTabs[0].id);
  }

  return (
    <div className="flex flex-col h-full min-h-0 text-start">
      <div className="flex items-center justify-end border-b border-[var(--border-color)] pb-3 mb-4 gap-3">
        <div className="relative w-full sm:w-72">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            placeholder={t('set_search_placeholder')}
            className="w-full bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] rounded-lg px-3 py-1.5 pe-8 text-start text-xs font-semibold text-[var(--text-primary)]"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
              }}
              className="absolute end-2 top-1.5 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              title={t('set_search_clear')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <Search className="w-3.5 h-3.5 absolute end-2.5 top-2.5 text-[var(--text-muted)]" />
          )}
        </div>
      </div>

      <div className="flex flex-row flex-1 min-h-0 overflow-hidden gap-4">
        <div
          role="tablist"
          aria-label={t('set_control_center_title')}
          className="w-48 shrink-0 border-e pe-2 border-[var(--border-color)] overflow-y-auto scrollbar-none select-none flex flex-col gap-1"
        >
          {filteredTabs.map((tab) => {
            const TabIcon = tab.icon;
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={isSelected}
                aria-controls={`settings-panel-${tab.id}`}
                onClick={() => {
                  setActiveTab(tab.id);
                }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-all duration-150 hover:scale-[1.02] active:scale-[0.98] text-xs font-bold text-start w-full border ${
                  isSelected
                    ? 'text-[var(--accent-primary)] bg-[var(--accent-primary)]/10 font-extrabold border-[var(--accent-border)]'
                    : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <TabIcon className="w-3.5 h-3.5 shrink-0 text-[var(--accent-primary)]" />
                <span className="truncate">{t(tab.labelKey)}</span>
              </button>
            );
          })}
          {filteredTabs.length === 0 && (
            <div className="p-2 text-[var(--text-muted)] italic text-xs">{t('set_no_tabs_match')}</div>
          )}
        </div>

        <div
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          className="flex-1 overflow-y-auto px-1 scrollbar-thin"
        >
          {activeTab === 'general' && <GeneralSettings settings={localSettings} updateSetting={updateLocalSetting} />}
          {activeTab === 'downloads' && (
            <DownloadSettings
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onTestNotification={handleTestNotification}
              onResetDaemonTab={handleResetDaemonTabSilent}
              onResetAll={handleResetAllSilent}
            />
          )}
          {activeTab === 'network' && (
            <NetworkAndPerformance settings={localSettings} updateSetting={updateLocalSetting} onAddToast={addToast} />
          )}
          {activeTab === 'appearance' && (
            <AppearanceSettings
              settings={localSettings}
              updateSetting={updateLocalSetting}
              themeSettings={themeSettings}
              onUpdateThemeSettings={updateThemeSettings}
            />
          )}
          {activeTab === 'browser' && <BrowserSettings settings={localSettings} updateSetting={updateLocalSetting} />}
          {activeTab === 'media' && <MediaSettings settings={localSettings} updateSetting={updateLocalSetting} />}
          {activeTab === 'telegram' && (
            <TelegramBotSettings settings={localSettings} updateSetting={updateLocalSetting} onAddToast={addToast} />
          )}
          {activeTab === 'external_tools' && <ExternalToolsSettings onAddToast={addToast} />}

          {activeTab === 'logging' && (
            <LoggingSettings settings={localSettings} updateSetting={updateLocalSetting} onAddToast={addToast} />
          )}
          {activeTab === 'backup' && (
            <BackupResetSettings settings={localSettings} onAddToast={addToast} onFactoryReset={handleResetAllSilent} />
          )}
        </div>
      </div>
    </div>
  );
};
