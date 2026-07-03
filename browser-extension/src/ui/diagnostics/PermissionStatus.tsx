import React from 'react';
import { useI18n } from '../../i18n/react';

type PermissionValue = boolean | { granted: boolean; reason?: string; degradedFeature?: string };

export function PermissionStatus({ permissions }: { permissions?: Record<string, PermissionValue> }) {
  const { t } = useI18n();
  const entries = Object.entries(permissions ?? {});
  return <section className="adm-section">
    <h2>{t('diagnostics.permissions')}</h2>
    <p className="adm-help">{t('diagnostics.permissionsHelp')}</p>
    {entries.length === 0 ? <div className="adm-empty">{t('diagnostics.permissionsEmpty')}</div> : <ul className="adm-status-list">
      {entries.map(([key, value]) => {
        const granted = typeof value === 'boolean' ? value : value.granted;
        const reason = typeof value === 'boolean' ? undefined : value.reason;
        const degraded = typeof value === 'boolean' ? undefined : value.degradedFeature;
        return <li key={key}>
          <span><strong>{key}</strong>{degraded ? <span className="adm-card-description"> · degraded: {degraded}</span> : null}{reason ? <span className="adm-card-description"> · {reason}</span> : null}</span>
          <span className="adm-pill" data-tone={granted ? 'success' : 'warning'}>{granted ? t('diagnostics.granted') : t('diagnostics.missing')}</span>
        </li>;
      })}
    </ul>}
  </section>;
}
export default PermissionStatus;
