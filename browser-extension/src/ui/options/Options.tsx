import { runtimeRequest } from '../runtime-request';
import React, { useEffect, useMemo, useState } from 'react';
import { defaultSettings, Settings, SettingsSchema } from '../../contracts/settings.schema';
import { useI18n } from '../../i18n/react';
import AppLogo from '../components/AppLogo';
import CaptureSettings from './CaptureSettings';
import ConnectionSettings from './ConnectionSettings';
import DataSettings from './DataSettings';
import GeneralSettings from './GeneralSettings';
import OverlaySettings from './OverlaySettings';
import SiteRulesSettings from './SiteRulesSettings';
import PermissionsSettings from './PermissionsSettings';

const tabs = ['general', 'overlay', 'capture', 'permissions', 'site-rules', 'connection', 'data'] as const;
type Tab = typeof tabs[number];

export function Options() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [active, setActive] = useState<Tab>('general');
  const [notice, setNotice] = useState<string>('');
  const aggressive = useMemo(() => settings.capture.aggressiveMode, [settings.capture.aggressiveMode]);

  useEffect(() => {
    void runtimeRequest({ type: 'GET_SETTINGS' })
      .then((raw) => setSettings(SettingsSchema.catch(defaultSettings).parse(raw)))
      .catch((error) => setNotice(error instanceof Error ? error.message : t('options.loadError')));
  }, []);

  async function save(next: Settings): Promise<void> {
    const parsed = SettingsSchema.parse(next);
    setSettings(parsed);
    await runtimeRequest({ type: 'UPDATE_SETTINGS', settings: parsed });
    setNotice(t('options.saved'));
  }

  const tabLabels: Record<Tab, string> = {
    general: t('options.tab.general'),
    overlay: t('options.tab.overlay'),
    capture: t('options.tab.capture'),
    permissions: t('options.tab.permissions'),
    'site-rules': t('options.tab.siteRules'),
    connection: t('options.tab.connection'),
    data: t('options.tab.data'),
  };

  return <main className="nova-page">
    <div className="nova-page-shell">
      <header className="nova-topbar">
        <div className="nova-brand">
          <AppLogo />
          <div>
            <h1 className="nova-title">{t('options.title')}</h1>
            <p className="nova-subtitle">{t('options.subtitle')}</p>
          </div>
        </div>
        <div className="nova-actions-row">
          <span className="nova-pill" data-tone={settings.enabled ? 'success' : 'warning'}>{settings.enabled ? t('options.enabled') : t('options.disabled')}</span>
          <span className="nova-pill" data-tone={aggressive ? 'warning' : 'info'}>{aggressive ? t('options.aggressiveMode') : t('options.standardMode')}</span>
        </div>
      </header>
      {notice ? <div className="nova-notice" data-kind="success" role="status">{notice}</div> : null}
      <div className="nova-settings-shell">
        <aside className="nova-sidebar" aria-label={t('options.navigation')}>
          <div className="nova-brand">
            <AppLogo />
            <div>
              <strong>{t('options.controlCenter')}</strong>
              <p className="nova-subtitle">{t('options.advancedSetup')}</p>
            </div>
          </div>
          <nav className="nova-sidebar-nav" role="tablist">
            {tabs.map((tab) => <button role="tab" key={tab} aria-selected={active === tab} onClick={() => setActive(tab)}>{tabLabels[tab]}</button>)}
          </nav>
        </aside>
        <div className="nova-settings-content">
          {active === 'general' ? <GeneralSettings settings={settings} onChange={(patch) => void save({ ...settings, ...patch })} /> : null}
          {active === 'overlay' ? <OverlaySettings settings={settings} onChange={(next) => void save(next)} /> : null}
          {active === 'capture' ? <CaptureSettings settings={settings} onChange={(next) => void save(next)} /> : null}
          {active === 'permissions' ? <PermissionsSettings /> : null}
          {active === 'site-rules' ? <SiteRulesSettings /> : null}
          {active === 'connection' ? <ConnectionSettings /> : null}
          {active === 'data' ? <DataSettings /> : null}
        </div>
      </div>
    </div>
  </main>;
}
export default Options;
