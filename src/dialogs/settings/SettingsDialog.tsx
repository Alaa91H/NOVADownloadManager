/* src/dialogs/settings/SettingsDialog.tsx */
import React, { useState, useEffect } from 'react';
import { 
  Settings, Sliders, HardDrive, Cpu, Music, Shield, Info, Palette, 
  Search, RefreshCw, RotateCcw, AlertOctagon, HelpCircle,
  ChevronDown, ChevronUp
} from 'lucide-react';
import { useAppStore } from '../../state/appStore';
import { DialogButton } from '../../components/primitives';
import { AppSettings, AppThemeSettings } from '../../types/desktop-ui.types';
import { initialSettings } from '../../initialData';

// Import subcomponents
import { GeneralAndDownloads } from './sections/GeneralAndDownloads';
import { NetworkAndPerformance } from './sections/NetworkAndPerformance';
import { BrowserAndIntegration } from './sections/BrowserAndIntegration';
import { MediaAndTorrent } from './sections/MediaAndTorrent';
import { IntegrationsAndAutomation } from './sections/IntegrationsAndAutomation';
import { AppearanceAndSecurity } from './sections/AppearanceAndSecurity';
import { DiagnosticsAndSystem } from './sections/DiagnosticsAndSystem';

export const SettingsDialog: React.FC = () => {
  const { 
    closeDialog, 
    settings, 
    updateSettings, 
    themeSettings, 
    updateThemeSettings, 
    addToast,
    t
  } = useAppStore();
  // Local state for atomic transactions
  const [localSettings, setLocalSettings] = useState<AppSettings>(JSON.parse(JSON.stringify(settings)));
  const [localThemeSettings, setLocalThemeSettings] = useState<AppThemeSettings>(JSON.parse(JSON.stringify(themeSettings)));
  const [activeTab, setActiveTab] = useState<'general' | 'network' | 'integration' | 'media_torrent' | 'integrations_automation' | 'appearance_security' | 'diagnostics_system'>('general');
  const [searchQuery, setSearchQuery] = useState('');

  const updateLocalSetting = (section: keyof AppSettings, key: string, value: any) => {
    setLocalSettings(prev => {
      const updated = { ...prev };
      if (typeof updated[section] === 'object' && updated[section] !== null) {
        (updated[section] as any)[key] = value;
      } else {
        (updated as any)[section] = value;
      }
      // Apply immediately and silently to global store
      updateSettings(updated, true);
      return updated;
    });
  };

  const updateLocalThemeSetting = (key: keyof AppThemeSettings, value: any) => {
    setLocalThemeSettings(prev => {
      const updated = { ...prev, [key]: value };
      // Apply immediately and silently to global store
      updateThemeSettings(key, value);
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
        daemonPort: '57423',
        daemonBindAddress: '127.0.0.1',
        experimentalFeatures: false
      }
    };
    setLocalSettings(updatedSettings);
    // Directly apply changes to the store instantly and silently
    updateSettings(updatedSettings, true);
  };

  const handleResetAllSilent = () => {
    const defaults = JSON.parse(JSON.stringify(initialSettings));
    setLocalSettings(defaults);
    const defaultsTheme: AppThemeSettings = {
      theme: 'dark',
      density: 'dense',
      accent: 'blue',
      sidebar: 'expanded',
      progress: 'bar',
      contrast: 'normal',
      motion: 'enabled',
      blur: 'enabled'
    };
    setLocalThemeSettings(defaultsTheme);
    // Directly apply all changes to the store instantly and silently
    updateSettings(defaults, true);
    Object.keys(defaultsTheme).forEach((key) => {
      updateThemeSettings(key as keyof AppThemeSettings, (defaultsTheme as any)[key]);
    });
  };

  const handleClearPartials = () => {
    // Clear partials can be kept simple or silent as well, let's keep it silent too as requested for settings
  };

  const handleTestNotification = () => {
    if (localSettings.sounds.enabled) {
      try {
        const audio = new Audio('/sounds/success_chime.wav');
        audio.volume = 0.5;
        audio.play().catch(() => {});
      } catch (e) {}
    }
  };

  // Search keyword map to auto-switch or highlight tabs
  const tabKeywordMap = {
    general: ['general', 'startup', 'language', 'download', 'folder', 'temporary', 'duplicate', 'license', 'update', 'path'],
    network: ['network', 'proxy', 'connection', 'dns', 'ip', 'speed', 'bandwidth', 'threads', 'limits', 'performance'],
    integration: ['browser', 'extension', 'integrate', 'capture', 'token', 'cookies', 'history', 'filter', 'monitor'],
    media_torrent: ['media', 'audio', 'video', 'merge', 'ffmpeg', 'torrent', 'magnet', 'seed', 'peer', 'port'],
    integrations_automation: ['telegram', 'webhook', 'mail', 'smtp', 'automation', 'rule', 'rules', 'discord', 'slack', 'bot'],
    appearance_security: ['appearance', 'security', 'theme', 'dark', 'privacy', 'color', 'screen', 'encryption', 'layout', 'contrast'],
    diagnostics_system: ['diagnostics', 'daemon', 'bridge', 'system', 'reset', 'backup', 'restore', 'factory', 'updates', 'port']
  };

  // State for sub-tabs and accordion expand
  const [automationSubTab, setAutomationSubTab] = useState<'telegram' | 'webhooks' | 'smtp' | 'rules'>('telegram');
  const [diagnosticsSubTab, setDiagnosticsSubTab] = useState<'bridge' | 'diagnostics' | 'backup' | 'advanced'>('bridge');
  const [expandedTabId, setExpandedTabId] = useState<string>('');

  // Helper to check if a single tab matches search criteria
  const isTabMatchingSearch = (tabId: string, tabLabel: string, tabDesc: string) => {
    if (!searchQuery) return true;
    const term = searchQuery.toLowerCase();
    const tabLabelMatch = tabLabel.toLowerCase().includes(term) || tabDesc.toLowerCase().includes(term);
    const keywords = tabKeywordMap[tabId as keyof typeof tabKeywordMap] || [];
    const keywordMatch = keywords.some(k => k.includes(term));
    return tabLabelMatch || keywordMatch;
  };

  const mainTabs = [
    { id: 'general' as const, label: t('set_tab_general'), desc: t('set_tab_general_desc'), icon: Settings },
    { id: 'network' as const, label: t('set_tab_network'), desc: t('set_tab_network_desc'), icon: Shield },
    { id: 'integration' as const, label: t('set_tab_browser_integration'), desc: t('set_tab_browser_integration_desc'), icon: Sliders },
    { id: 'media_torrent' as const, label: t('set_tab_media_torrent'), desc: t('set_tab_media_torrent_desc'), icon: Music },
    { 
      id: 'integrations_automation' as const, 
      label: t('set_tab_integrations_automation'), 
      desc: t('set_tab_integrations_automation_desc'), 
      icon: Cpu,
      subItems: [
        { id: 'telegram', label: 'Telegram Bot' },
        { id: 'webhooks', label: 'Webhooks API' },
        { id: 'smtp', label: 'SMTP Alerts' },
        { id: 'rules', label: 'Automation Rules' }
      ]
    },
    { id: 'appearance_security' as const, label: t('set_tab_appearance_security'), desc: t('set_tab_appearance_security_desc'), icon: Palette },
    { 
      id: 'diagnostics_system' as const, 
      label: t('set_tab_diagnostics_system'), 
      desc: t('set_tab_diagnostics_system_desc'), 
      icon: Info,
      subItems: [
        { id: 'bridge', label: 'Bridge & Daemon' },
        { id: 'diagnostics', label: 'Diagnostics & Reports' },
        { id: 'backup', label: 'Backup & Restore' },
        { id: 'advanced', label: 'Advanced & Ports' }
      ]
    }
  ];

  // Filter tabs and their sub-items based on search query
  const filteredTabs = mainTabs.map(tab => {
    const isDirectMatch = isTabMatchingSearch(tab.id, tab.label, tab.desc);
    if (tab.subItems) {
      const term = searchQuery.toLowerCase();
      const matchedSubItems = tab.subItems.filter(sub => 
        !searchQuery || sub.label.toLowerCase().includes(term) || isDirectMatch
      );
      return {
        ...tab,
        subItems: matchedSubItems,
        isMatched: isDirectMatch || matchedSubItems.length > 0
      };
    }
    return {
      ...tab,
      isMatched: isDirectMatch
    };
  }).filter(tab => tab.isMatched);

  // Synchronize expanded state with activeTab
  useEffect(() => {
    const activeTabObj = mainTabs.find(tab => tab.id === activeTab);
    if (activeTabObj && activeTabObj.subItems) {
      setExpandedTabId(activeTab);
    } else {
      setExpandedTabId('');
    }
  }, [activeTab]);

  // If search query is active, auto-expand and auto-select matching tabs/sub-tabs
  useEffect(() => {
    if (searchQuery && filteredTabs.length > 0) {
      const firstTab = filteredTabs[0];
      setActiveTab(firstTab.id);
      if (firstTab.subItems && firstTab.subItems.length > 0) {
        setExpandedTabId(firstTab.id);
        if (firstTab.id === 'integrations_automation') {
          setAutomationSubTab(firstTab.subItems[0].id as any);
        } else if (firstTab.id === 'diagnostics_system') {
          setDiagnosticsSubTab(firstTab.subItems[0].id as any);
        }
      }
    }
  }, [searchQuery]);

  return (
    <div className={`flex flex-col h-[75vh] min-h-[550px] max-h-[700px] ${'text-left'}`} dir={'ltr'}>
      
      {/* 1. TOP HEADER WITH SEARCH BAR */}
      <div className={`flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-[var(--border-color)] pb-3 mb-4 gap-3`}>
        <div className="space-y-0.5">
          <h2 className="text-base font-extrabold text-slate-100 flex items-center gap-2">
            <Settings className="w-5 h-5 text-[var(--accent-primary)]" />
            {t('set_control_center_title')}
          </h2>
          <p className="text-[11px] text-[var(--text-secondary)]">
            {t('set_control_center_desc')}
          </p>
        </div>
        
        {/* Dynamic Search */}
        <div className="relative w-full sm:w-72">
          <input 
            type="text" 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('set_search_placeholder')}
            className={`w-full bg-[var(--bg-hover)] border border-[var(--border-color)] hover:border-[var(--border-color-hover)] focus:border-[var(--accent-primary)] focus:ring-1 focus:ring-[var(--accent-primary)] rounded-lg px-3 py-1.5 ${'pr-8 text-left'} text-xs font-semibold text-slate-200`}
          />
          <Search className={`w-3.5 h-3.5 absolute ${'right-2.5'} top-2.5 text-slate-400`} />
        </div>
      </div>

      {/* 2. LAYOUT: SIDEBAR TABS & ACTIVE CONTENT */}
      <div className="flex flex-row flex-1 min-h-0 overflow-hidden gap-4">
        
        {/* SIDEBAR TABS - ACCORDION LAYOUT */}
        <div className={`w-56 shrink-0 ${'border-r pr-2'} border-[var(--border-color)] overflow-y-auto scrollbar-none select-none flex flex-col gap-1.5`}>
          {filteredTabs.map(tab => {
            const TabIcon = tab.icon;
            const isSelected = activeTab === tab.id;
            const hasSubItems = !!tab.subItems;
            const isExpanded = expandedTabId === tab.id;
            
            return (
              <div key={tab.id} className="flex flex-col gap-1 border-b border-[var(--border-color)]/20 pb-1.5 last:border-none">
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
                        if (tab.subItems && tab.subItems.length > 0) {
                          if (tab.id === 'integrations_automation') {
                            setAutomationSubTab(tab.subItems[0].id as any);
                          } else if (tab.id === 'diagnostics_system') {
                            setDiagnosticsSubTab(tab.subItems[0].id as any);
                          }
                        }
                      }
                    }
                  }}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors text-xs font-bold text-left w-full ${
                    isSelected 
                      ? 'text-[var(--accent-primary)] bg-[var(--accent-primary)]/10 font-extrabold border-l-2 border-[var(--accent-primary)]' 
                      : 'text-slate-300 hover:text-white hover:bg-[var(--bg-hover)]/35'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <TabIcon className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
                    <span>{tab.label}</span>
                  </div>
                  {hasSubItems && (
                    isExpanded ? (
                      <ChevronUp className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    )
                  )}
                </button>

                {/* Sub-items (Inner Tabs) with expand/collapse behavior */}
                {hasSubItems && isExpanded && tab.subItems && (
                  <div className={`flex flex-col gap-1 mt-1 animate-in slide-in-from-top-1 duration-150 ${
                    'pl-3 ml-3 border-l border-[var(--border-color)]/50 mr-1 pr-1'
                  }`}>
                    {tab.subItems.map(sub => {
                      const isSubSelected = (tab.id === 'integrations_automation' && automationSubTab === sub.id) ||
                                            (tab.id === 'diagnostics_system' && diagnosticsSubTab === sub.id);
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          onClick={() => {
                            setActiveTab(tab.id);
                            if (tab.id === 'integrations_automation') {
                              setAutomationSubTab(sub.id as any);
                            } else if (tab.id === 'diagnostics_system') {
                              setDiagnosticsSubTab(sub.id as any);
                            }
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer text-[11px] font-semibold w-full text-left justify-start transition-all ${
                            isSubSelected && isSelected
                              ? 'text-white bg-[var(--accent-primary)]/10 font-extrabold border-l border-[var(--accent-primary)]' 
                              : 'text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/30'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${isSubSelected && isSelected ? 'bg-[var(--accent-primary)]' : 'bg-slate-600'}`} />
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
            <div className="p-2 text-slate-400 italic text-xs">
              {'No tabs match your search.'}
            </div>
          )}
        </div>

        {/* COMPONENT CANVAS - ACTIVE CONTENT */}
        <div className="flex-1 overflow-y-auto pr-1 pl-1 scrollbar-thin" dir={'ltr'}>
          
          {activeTab === 'general' && (
            <GeneralAndDownloads 
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onTestNotification={handleTestNotification}
              onClearPartials={handleClearPartials}
              onResetDaemonTab={handleResetDaemonTabSilent}
              onResetAll={handleResetAllSilent}
            />
          )}

          {activeTab === 'network' && (
            <NetworkAndPerformance 
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onAddToast={addToast}
            />
          )}

          {activeTab === 'integration' && (
            <BrowserAndIntegration 
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onAddToast={addToast}
            />
          )}

          {activeTab === 'media_torrent' && (
            <MediaAndTorrent 
              settings={localSettings}
              updateSetting={updateLocalSetting}
              onAddToast={addToast}
            />
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
