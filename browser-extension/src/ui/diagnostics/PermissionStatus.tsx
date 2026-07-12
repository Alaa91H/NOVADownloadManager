import React from 'react';
import { useI18n } from '../../i18n/react';

type PermissionValue = boolean | { granted: boolean; reason?: string; degradedFeature?: string };

export function PermissionStatus({ permissions }: { permissions?: Record<string, PermissionValue> }) {
  const { t } = useI18n();
  const entries = Object.entries(permissions ?? {});
  return <section className="nova-section">
    <h2>{t('diagnostics.permissions')}</h2>
    <p className="nova-help">{t('diagnostics.permissionsHelp')}</p>
    {entries.length === 0 ? <div className="nova-empty">{t('diagnostics.permissionsEmpty')}</div> : <ul className="nova-status-list">
      {entries.map(([key, value]) => {
        const granted = typeof value === 'boolean' ? value : value.granted;
        const reason = typeof value === 'boolean' ? undefined : value.reason;
        const degraded = typeof value === 'boolean' ? undefined : value.degradedFeature;
        return <li key={key}>
          <span><strong>{key}</strong>{degraded ? <span className="nova-card-description"> · degraded: {degraded}</span> : null}{reason ? <span className="nova-card-description"> · {reason}</span> : null}</span>
          <span className="nova-pill" data-tone={granted ? 'success' : 'warning'}>{granted ? t('diagnostics.granted') : t('diagnostics.missing')}</span>
        </li>;
      })}
    </ul>}
  </section>;
}
export default PermissionStatus;
