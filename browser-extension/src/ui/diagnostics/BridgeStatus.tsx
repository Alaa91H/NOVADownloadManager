import React from 'react';
import { BridgeState } from '../../core/app-state';
import { useI18n } from '../../i18n/react';

function tone(status?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'connected') return 'success';
  if (status === 'degraded' || status === 'tokenExpired' || status === 'protocolMismatch') return 'warning';
  if (!status || status === 'fatal' || status === 'offline') return 'danger';
  return 'info';
}

export function BridgeStatus({ state }: { state?: BridgeState }) {
  const { t } = useI18n();
  return <section className="adm-section">
    <div className="adm-card-header">
      <div>
        <h2>{t('bridge.title')}</h2>
        <p className="adm-help">{t('bridge.help')}</p>
      </div>
      <span className="adm-pill" data-tone={tone(state?.status)}>{state?.status ?? t('bridge.unknown')}</span>
    </div>
    <dl>
      <dt>{t('bridge.transport')}</dt><dd>{state?.transport ?? t('bridge.none')}</dd>
      <dt>{t('bridge.protocol')}</dt><dd>{state?.protocolVersion ?? t('bridge.unknown')} / min {state?.minimumSupportedProtocolVersion ?? t('bridge.unknown')}</dd>
      <dt>{t('bridge.canSend')}</dt><dd>{state?.canSend ? t('bridge.yes') : t('bridge.no')}</dd>
      <dt>{t('bridge.lastConnected')}</dt><dd>{state?.lastConnectedAt ?? t('bridge.never')}</dd>
      <dt>{t('bridge.retryAfter')}</dt><dd>{state?.retryAfterMs ? `${state.retryAfterMs} ms` : t('bridge.none')}</dd>
      <dt>{t('bridge.lastError')}</dt><dd>{state?.lastError ? `${state.lastError.code}: ${state.lastError.message}` : t('bridge.none')}</dd>
    </dl>
  </section>;
}
export default BridgeStatus;
