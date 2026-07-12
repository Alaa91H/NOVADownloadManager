import React from 'react';
import { useI18n } from '../../i18n/react';

export type OutboxCounts = Partial<Record<'pending' | 'sending' | 'sent' | 'failed' | 'dead-letter' | 'deadLetter', number>>;

export function OutboxStatus({ counts, onRetry }: { counts?: OutboxCounts; onRetry(): void }) {
  const { t } = useI18n();
  const pending = (counts?.pending ?? 0) + (counts?.failed ?? 0);
  const dead = counts?.deadLetter ?? counts?.['dead-letter'] ?? 0;
  return <section className="nova-card" aria-label={t('outbox.aria')}>
    <div className="nova-card-header">
      <div>
        <h2 className="nova-card-title">{t('outbox.title')}</h2>
        <p className="nova-card-description">{t('outbox.help')}</p>
      </div>
      <button disabled={pending === 0} onClick={onRetry}>{t('outbox.retry')}</button>
    </div>
    <div className="nova-grid nova-grid-3">
      <Metric label={t('outbox.pending')} value={counts?.pending ?? 0} />
      <Metric label={t('outbox.sending')} value={counts?.sending ?? 0} />
      <Metric label={t('outbox.failed')} value={counts?.failed ?? 0} />
      <Metric label={t('outbox.sent')} value={counts?.sent ?? 0} />
      <Metric label={t('outbox.deadLetter')} value={dead} />
    </div>
  </section>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <span className="nova-metric">
    <strong className="nova-metric-value">{value}</strong>
    <span className="nova-metric-label">{label}</span>
  </span>;
}

export default OutboxStatus;
