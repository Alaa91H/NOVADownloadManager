import React from 'react';
import { BridgeState } from '../../core/app-state';
import { useI18n } from '../../i18n/react';

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'connected') return 'success';
  if (status === 'reconnecting' || status === 'booting' || status === 'discovering' || status === 'pairing') return 'info';
  if (status === 'degraded' || status === 'tokenExpired' || status === 'protocolMismatch') return 'warning';
  return 'danger';
}

function humanStatus(status: string): string {
  return status.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
}

export function ConnectionStatus({ state, onRetry, onRepair, onOpenNova, onDiagnostics }: { state?: BridgeState; onRetry(): void; onRepair(): void; onOpenNova(): void; onDiagnostics(): void }) {
  const { t } = useI18n();
  const status = state?.status ?? 'booting';
  const tone = statusTone(status);
  return <section className="nova-card" aria-label={t('connectionCard.aria')}>
    <div className="nova-card-header">
      <div>
        <h2 className="nova-card-title">{t('connectionCard.title')}</h2>
        <p className="nova-card-description">{t('connectionCard.help')}</p>
      </div>
      <span className="nova-pill" data-tone={tone}>{humanStatus(status)}</span>
    </div>
    <div className="nova-grid nova-grid-3">
      <Metric label={t('connectionCard.sendState')} value={state?.canSend ? t('connectionCard.ready') : t('connectionCard.blocked')} tone={state?.canSend ? 'success' : 'warning'} />
      <Metric label={t('connectionCard.transport')} value={state?.transport ?? t('connectionCard.none')} />
      <Metric label={t('connectionCard.protocol')} value={state?.protocolVersion ? `v${state.protocolVersion}` : t('general.unknown')} />
    </div>
    {state?.lastError ? <div className="nova-notice" data-kind={state.lastError.retryable ? 'info' : 'error'} role="status">
      <strong>{state.lastError.code}</strong>: {state.lastError.message}{state.lastError.repairHint ? ` - ${state.lastError.repairHint}` : ''}
    </div> : null}
    <div className="nova-toolbar">
      <button onClick={onRetry} data-variant="primary">{t('connectionCard.retry')}</button>
      <button onClick={onRepair}>{t('connectionCard.linkNova')}</button>{/* Link with NOVA */}
      <button onClick={onOpenNova}>{t('connectionCard.openNova')}</button>
      <button onClick={onDiagnostics}>{t('connectionCard.diagnostics')}</button>
    </div>
  </section>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'warning' }) {
  return <div className="nova-metric">
    <span className="nova-metric-value">{value}</span>
    <span className="nova-metric-label">{label}{tone ? ` - ${tone}` : ''}</span>
  </div>;
}

export default ConnectionStatus;
