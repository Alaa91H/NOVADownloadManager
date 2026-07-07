import React from 'react';
import { Settings } from '../../contracts/settings.schema';
import type { MessageKey } from '../../i18n';
import { useI18n } from '../../i18n/react';

type RowConfig = { key: keyof Settings; tKey: MessageKey; tHelpKey: MessageKey };
const rowConfigs: RowConfig[] = [
  { key: 'enabled', tKey: 'options.general.enabled', tHelpKey: 'options.general.enabledHelp' },
  { key: 'autoConnect', tKey: 'options.general.autoConnect', tHelpKey: 'options.general.autoConnectHelp' },
  { key: 'notifications', tKey: 'options.general.notifications', tHelpKey: 'options.general.notificationsHelp' },
  { key: 'showBadge', tKey: 'options.general.showBadge', tHelpKey: 'options.general.showBadgeHelp' },
  { key: 'openAdmAfterSend', tKey: 'options.general.openAdmAfterSend', tHelpKey: 'options.general.openAdmAfterSendHelp' },
];

export function GeneralSettings({ settings, onChange }: { settings: Settings; onChange(patch: Partial<Settings>): void }) {
  const { t } = useI18n();
  return <section className="adm-section">
    <h2>{t('options.general.title')}</h2>
    <p className="adm-help">{t('options.general.help')}</p>
    <div className="adm-field-grid">
      {rowConfigs.map((row) => <label className="adm-toggle" key={row.key}>
        <input type="checkbox" checked={Boolean(settings[row.key])} onChange={(event) => onChange({ [row.key]: event.currentTarget.checked } as Partial<Settings>)} />
        <span><strong>{t(row.tKey)}</strong><span>{t(row.tHelpKey)}</span></span>
      </label>)}
    </div>
  </section>;
}
export default GeneralSettings;
