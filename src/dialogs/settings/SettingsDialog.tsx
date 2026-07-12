/* src/dialogs/settings/SettingsDialog.tsx */
import React, { useState } from 'react';
import { Settings, Sliders, Cpu, Globe, Bell, Palette, Search, ChevronDown, ChevronUp, X, Download, Video, Activity } from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import type { AppSettings, AppThemeSettings } from '../../types/desktop-ui.types';
import { initialSettings } from '../../initialData';
import { playAppSound } from '../../utils/sound';

// Import subcomponents
import { GeneralAndDownloads } from './sections/GeneralAndDownloads';
import { NetworkAndPerformance } from './sections/NetworkAndPerformance';
import { BrowserAndIntegration } from './sections/BrowserAndIntegration';
import { IntegrationsAndAutomation } from './sections/IntegrationsAndAutomation';
import { AppearanceAndSecurity } from './sections/AppearanceAndSecurity';
import { DiagnosticsAndSystem } from './sections/DiagnosticsAndSystem';
import { DirectDownloadSettings } from './sections/DirectDownloadSettings';
import { MediaDownloadSettings } from './sections/MediaDownloadSettings';

type SettingsTabId =
  | 'general'
  | 'engines'
  | 'network'
  | 'integration'
  | 'integrations_automation'
  | 'appearance_security'
  | 'diagnostics_system';
type EnginesSubTab = 'direct' | 'media';
type AutomationSubTab = 'telegram' | 'webhooks' | 'smtp' | 'rules';
type DiagnosticsSubTab = 'bridge' | 'diagnostics' | 'backup' | 'advanced';
type SettingsDialogPayload = {
  tab?: SettingsTabId;
  subTab?: EnginesSubTab | AutomationSubTab | DiagnosticsSubTab;
};

const isSettingsPayload = (payload: unknown): payload is SettingsDialogPayload =>
  Boolean(payload && typeof payload === 'object');

export const SettingsDialog: React.FC = () => {
  const { dialog, settings, updateSettings, themeSettings, updateThemeSettings, addToast, t } = useAppStore();
  const payload = isSettingsPayload(dialog.payload) ? dialog.payload : {};
  // Local state for atomic transactions
  const [localSettings, setLocalSettings] = useState<AppSettings>(structuredClone(settings));
  const [localThemeSettings, setLocalThemeSettings] = useState<AppThemeSettings>(structuredClone(themeSettings));
  const [activeTab, setActiveTab] = useState<SettingsTabId>(payload.tab || 'general');
  const [searchQuery, setSearchQuery] = useState('');
  const [enginesSubTab, setEnginesSubTab] = useState<EnginesSubTab>(
    payload.tab === 'engines' && (payload.subTab === 'direct' || payload.subTab === 'media')
      ? payload.subTab
      : 'direct',
  );

  const REJECTED_KEY_PATTERN = /[^a-zA-Z0-9_]/;
  const updateLocalSetting = (section: keyof AppSettings, key: string, value: unknown) => {
    if (REJECTED_KEY_PATTERN.test(key)) return;
    setLocalSettings((prev) => {
      const updated = { ...prev };
      if (typeof updated[section] === 'object') {
        (updated[section] as Record<string, unknown>)[key] = value;
      } else {
        (updated as Record<string, unknown>)[section] = value;
      }
      // Apply immediately and silently to global store
      updateSettings(updated, true);
      return updated;
    });
  };

  const updateLocalThemeSetting = (key: keyof AppThemeSettings, value: unknown) => {
    setLocalThemeSettings((prev) => {
      const updated = { ...prev, [key]: value };
      // Apply immediately and silently to global store
      updateThemeSettings(key, value as string);
      return updated;
    });
  };

  const handleResetDaemonTabSilent = () => {
    const updatedSettings = {
      ...localSettings,
      extra: {
        ...localSettings.extra,
        autoReconnectDaemon: true,
        enableSse: true,
        daemonPort: '3199',
        daemonBindAddress: '127.0.0.1',
        experimentalFeatures: false,
      },
    };
    setLocalSettings(updatedSettings);
    // Directly apply changes to the store instantly and silently
    updateSettings(updatedSettings, true);
  };

  const handleResetAllSilent = () => {
    const defaults = structuredClone(initialSettings);
    setLocalSettings(defaults);
    const defaultsTheme: AppThemeSettings = {
      theme: 'dark',
      density: 'dense',
      accent: 'blue',
      sidebar: 'expanded',
      progress: 'bar',
      contrast: 'normal',
      motion: 'enabled',
      blur: 'enabled',
    };
    setLocalThemeSettings(defaultsTheme);
    // Directly apply all changes to the store instantly and silently
    updateSettings(defaults, true);
    (Object.keys(defaultsTheme) as (keyof AppThemeSettings)[]).forEach((key) => {
      updateThemeSettings(key, defaultsTheme[key]);
    });
  };

  const handleTestNotification = () => {
    if (localSettings.sounds.enabled) {
      playAppSound(localSettings, 'complete');
      try {
        const audio = new Audio('/sounds/success_chime.wav');
        audio.volume = 0.5;
        audio.play().catch(() => {});
      } catch {
        // Audio playback unavailable — nothing to do.
      }
    }
  };

  // Search keyword map to auto-switch or highlight tabs
  const tabKeywordMap = {
    general: [
      'general',
      'startup',
      'language',
      'download',
      'folder',
      'temporary',
      'duplicate',
      'license',
      'update',
      'path',
    ],
    engines: [
      'engine',
      'curl',
      'libcurl',
      'ytdlp',
      'yt-dlp',
      'media',
      'direct',
      'ffmpeg',
      'tls',
      'timeout',
      'quality',
      'format',
      'subtitle',
    ],
    network: ['network', 'proxy', 'connection', 'dns', 'ip', 'speed', 'bandwidth', 'threads', 'limits', 'performance'],
    integration: ['browser', 'extension', 'integrate', 'capture', 'token', 'cookies', 'history', 'filter', 'monitor'],
    integrations_automation: [
      'telegram',
      'webhook',
      'mail',
      'smtp',
      'automation',
      'rule',
      'rules',
      'discord',
      'slack',
      'bot',
      'notify',
      'notification',
    ],
    appearance_security: [
      'appearance',
      'security',
      'theme',
      'dark',
      'privacy',
      'color',
      'screen',
      'encryption',
      'layout',
      'contrast',
      'accent',
      'toolbar',
    ],
    diagnostics_system: [
      'diagnostics',
      'daemon',
      'bridge',
      'system',
      'reset',
      'backup',
      'restore',
      'factory',
      'updates',
      'port',
    ],
  };

  // State for sub-tabs and accordion expand
  const [automationSubTab, setAutomationSubTab] = useState<AutomationSubTab>(
    payload.tab === 'integrations_automation' &&
      (payload.subTab === 'telegram' ||
        payload.subTab === 'webhooks' ||
        payload.subTab === 'smtp' ||
        payload.subTab === 'rules')
      ? payload.subTab
      : 'telegram',
  );
  const [diagnosticsSubTab, setDiagnosticsSubTab] = useState<DiagnosticsSubTab>(
    payload.tab === 'diagnostics_system' &&
      (payload.subTab === 'bridge' ||
        payload.subTab === 'diagnostics' ||
        payload.subTab === 'backup' ||
        payload.subTab === 'advanced')
      ? payload.subTab
      : 'bridge',
  );
  const [expandedTabId, setExpandedTabId] = useState<string>(
    payload.tab === 'integrations_automation' || payload.tab === 'diagnostics_system' || payload.tab === 'engines'
      ? payload.tab
      : '',
  );

  // Helper to check if a single tab matches search criteria
  const isTabMatchingSearch = (tabId: string, tabLabel: string, tabDesc: string) => {
    if (!searchQuery) return true;
    const term = searchQuery.toLowerCase();
    const tabLabelMatch = tabLabel.toLowerCase().includes(term) || tabDesc.toLowerCase().includes(term);
    const keywords = tabKeywordMap[tabId as keyof typeof tabKeywordMap];
    const keywordMatch = keywords.some((k) => k.includes(term));
    return tabLabelMatch || keywordMatch;
  };

  const mainTabs = [
    { id: 'general' as const, label: t('set_tab_general'), desc: t('set_tab_general_desc'), icon: Settings },
    {
      id: 'engines' as const,
      label: t('set_tab_engines'),
      desc: t('set_tab_engines_desc'),
      icon: Cpu,
      subItems: [
        { id: 'direct', label: t('set_tab_direct_download'), icon: Download },
        { id: 'media', label: t('set_tab_media_download'), icon: Video },
      ],
    },
    { id: 'network' as const, label: t('set_tab_network'), desc: t('set_tab_network_desc'), icon: Globe },
    {
      id: 'integration' as const,
      label: t('set_tab_browser_integration'),
      desc: t('set_tab_browser_integration_desc'),
      icon: Sliders,
    },
    {
      id: 'integrations_automation' as const,
      label: t('set_tab_integrations_automation'),
      desc: t('set_tab_integrations_automation_desc'),
      icon: Bell,
      subItems: [
        { id: 'telegram', label: t('set_sub_telegram') },
        { id: 'webhooks', label: t('set_sub_webhooks') },
        { id: 'smtp', label: t('set_sub_smtp') },
        { id: 'rules', label: t('set_sub_rules') },
      ],
    },
    {
      id: 'appearance_security' as const,
      label: t('set_tab_appearance_security'),
      desc: t('set_tab_appearance_security_desc'),
      icon: Palette,
    },
    {
      id: 'diagnostics_system' as const,
      label: t('set_tab_diagnostics_system'),
      desc: t('set_tab_diagnostics_system_desc'),
      icon: Activity,
      subItems: [
        { id: 'bridge', label: t('set_sub_bridge') },
        { id: 'diagnostics', label: t('set_sub_diagnostics') },
        { id: 'backup', label: t('set_sub_backup') },
        { id: 'advanced', label: t('set_sub_advanced') },
      ],
    },
  ];

  // Filter tabs and their sub-items based on search query
  const filteredTabs = mainTabs
    .map((tab) => {
      const isDirectMatch = isTabMatchingSearch(tab.id, tab.label, tab.desc);
      if (tab.subItems) {
        const term = searchQuery.toLowerCase();
        const matchedSubItems = tab.subItems.filter(
          (sub) => !searchQuery || sub.label.toLowerCase().includes(term) || isDirectMatch,
        );
        return {
          ...tab,
          subItems: matchedSubItems,
          isMatched: isDirectMatch || matchedSubItems.length > 0,
        };
      }
      return {
        ...tab,
        isMatched: isDirectMatch,
      };
    })
    .filter((tab) => tab.isMatched);

  // Synchronize expanded state with activeTab, adjusting during render
  // instead of in an effect.
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (prevActiveTab !== activeTab) {
    setPrevActiveTab(activeTab);
    const activeTabObj = mainTabs.find((tab) => tab.id === activeTab);
    setExpandedTabId(activeTabObj && 'subItems' in activeTabObj && activeTabObj.subItems ? activeTab : '');
  }

  // If search query is active, auto-expand and auto-select matching tabs/sub-tabs
  const [prevSearchQuery, setPrevSearchQuery] = useState(searchQuery);
  if (prevSearchQuery !== searchQuery) {
    setPrevSearchQuery(searchQuery);
    if (searchQuery && filteredTabs.length > 0) {
      const firstTab = filteredTabs[0];
      setActiveTab(firstTab.id);
      if (firstTab.subItems && firstTab.subItems.length > 0) {
        setExpandedTabId(firstTab.id);
        if (firstTab.id === 'engines') {
          setEnginesSubTab(firstTab.subItems[0].id as EnginesSubTab);
        } else if (firstTab.id === 'integrations_automation') {
          setAutomationSubTab(firstTab.subItems[0].id as AutomationSubTab);
        } else {
          setDiagnosticsSubTab(firstTab.subItems[0].id as DiagnosticsSubTab);
        }
      }
    }
  }

  return (
    <div className={`flex flex-col h-full min-h-0 text-left`} dir={'ltr'}>
      {/* 1. SEARCH BAR ROW (page header carries the title) */}
      <div className={`flex items-center justify-end border-b border-[var(--border-color)] pb-3 mb-4 gap-3`}>
        <div className="relative w-full sm:w-72">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
            placeholder={t('set_search_placeholder')}
            className={`w-full bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] rounded-lg px-3 py-1.5 pr-8 text-left text-xs font-semibold text-[var(--text-primary)]`}
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
              }}
              className="absolute right-2 top-1.5 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              title={t('set_search_clear')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <Search className={`w-3.5 h-3.5 absolute right-2.5 top-2.5 text-[var(--text-muted)]`} />
          )}
        </div>
      </div>

      {/* 2. LAYOUT: SIDEBAR TABS & ACTIVE CONTENT */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden gap-4">
        {/* SIDEBAR TABS - ACCORDION LAYOUT */}
        <div
          className={`w-56 shrink-0 border-r pr-2 border-[var(--border-color)] overflow-y-auto scrollbar-none select-none flex flex-col gap-1.5`}
        >
          {filteredTabs.map((tab) => {
            const TabIcon = tab.icon;
            const isSelected = activeTab === tab.id;
            const hasSubItems = !!tab.subItems;
            const isExpanded = expandedTabId === tab.id;

            return (
              <div
                key={tab.id}
                className="flex flex-col gap-1 border-b border-[var(--border-color)]/20 pb-1.5 last:border-none"
              >
                {/* Main Tab Button / Accordion Header */}
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.id);
                    if (hasSubItems) {
                      if (isExpanded) {
                        setExpandedTabId('');
                      } else {
                        setExpandedTabId(tab.id);
                        // Also auto-select its first sub-item if any
                        if (tab.subItems.length > 0) {
                          if (tab.id === 'engines') {
                            setEnginesSubTab(tab.subItems[0].id as EnginesSubTab);
                          } else if (tab.id === 'integrations_automation') {
                            setAutomationSubTab(tab.subItems[0].id as AutomationSubTab);
                          } else {
                            setDiagnosticsSubTab(tab.subItems[0].id as DiagnosticsSubTab);
                          }
                        }
                      }
                    }
                  }}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-150 hover:scale-[1.02] active:scale-[0.98] text-xs font-bold text-left w-full border ${
                    isSelected
                      ? 'text-[var(--accent-primary)] bg-[var(--accent-primary)]/10 font-extrabold border-[var(--accent-border)]'
                      : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-color-hover)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <TabIcon className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                    <span>{tab.label}</span>
                  </div>
                  {hasSubItems &&
                    (isExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
                    ))}
                </button>

                {/* Sub-items (Inner Tabs) with expand/collapse behavior */}
                {hasSubItems && isExpanded && (
                  <div
                    className={`flex flex-col gap-1 mt-1 animate-in slide-in-from-top-1 duration-150 pl-3 ml-3 border-l border-[var(--border-color)]/50 mr-1 pr-1`}
                  >
                    {tab.subItems.map((sub) => {
                      const isSubSelected =
                        (tab.id === 'engines' && enginesSubTab === sub.id) ||
                        (tab.id === 'integrations_automation' && automationSubTab === sub.id) ||
                        (tab.id === 'diagnostics_system' && diagnosticsSubTab === sub.id);
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          onClick={() => {
                            setActiveTab(tab.id);
                            if (tab.id === 'engines') {
                              setEnginesSubTab(sub.id as EnginesSubTab);
                            } else if (tab.id === 'integrations_automation') {
                              setAutomationSubTab(sub.id as AutomationSubTab);
                            } else {
                              setDiagnosticsSubTab(sub.id as DiagnosticsSubTab);
                            }
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer text-[11px] font-semibold w-full text-left justify-start transition-all duration-150 hover:scale-[1.02] active:scale-[0.98] ${
                            isSubSelected && isSelected
                              ? 'text-[var(--text-primary)] bg-[var(--accent-primary)]/10 font-extrabold border-l border-[var(--accent-primary)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${isSubSelected && isSelected ? 'bg-[var(--accent-primary)]' : 'bg-[var(--text-muted)]'}`}
                          />
                          <span>{sub.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {filteredTabs.length === 0 && (
            <div className="p-2 text-[var(--text-muted)] italic text-xs">{t('set_no_tabs_match')}</div>
          )}
        </div>

        {/* COMPONENT CANVAS - ACTIVE CONTENT */}
        <div className="flex-1 overflow-y-auto pr-1 pl-1 scrollbar-thin" dir={'ltr'}>
          {activeTab === 'general' && (
            <GeneralAndDownloads
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onTestNotification={handleTestNotification}
              onResetDaemonTab={handleResetDaemonTabSilent}
              onResetAll={handleResetAllSilent}
            />
          )}

          {activeTab === 'engines' && enginesSubTab === 'direct' && (
            <DirectDownloadSettings settings={localSettings} updateSetting={updateLocalSetting} />
          )}

          {activeTab === 'engines' && enginesSubTab === 'media' && (
            <MediaDownloadSettings settings={localSettings} updateSetting={updateLocalSetting} onAddToast={addToast} />
          )}

          {activeTab === 'network' && (
            <NetworkAndPerformance settings={localSettings} updateSetting={updateLocalSetting} onAddToast={addToast} />
          )}

          {activeTab === 'integration' && (
            <BrowserAndIntegration settings={localSettings} updateSetting={updateLocalSetting} onAddToast={addToast} />
          )}

          {activeTab === 'integrations_automation' && (
            <IntegrationsAndAutomation
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onAddToast={addToast}
              activeSubTab={automationSubTab}
              onChangeSubTab={setAutomationSubTab}
            />
          )}

          {activeTab === 'appearance_security' && (
            <AppearanceAndSecurity
              settings={localSettings}
              themeSettings={localThemeSettings}
              updateThemeSetting={updateLocalThemeSetting}
              updateSetting={updateLocalSetting}
            />
          )}

          {activeTab === 'diagnostics_system' && (
            <DiagnosticsAndSystem
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onAddToast={addToast}
              onFactoryReset={handleResetAllSilent}
              activeSubTab={diagnosticsSubTab}
              onChangeSubTab={setDiagnosticsSubTab}
            />
          )}
        </div>
      </div>
    </div>
  );
};
