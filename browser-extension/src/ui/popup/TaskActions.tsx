import React from 'react';
import { useI18n } from '../../i18n/react';

export function TaskActions({ hasCandidates, hasSelection, isBusy, onScan, onSendSelected, onSendAll, onClear }: { hasCandidates: boolean; hasSelection: boolean; isBusy: boolean; onScan(): void; onSendSelected(): void; onSendAll(): void; onClear(): void }) {
  const { t } = useI18n();
  return <section className="nova-card" aria-label={t('taskActions.aria')}>
    <div className="nova-card-header">
      <div>
        <h2 className="nova-card-title">{t('taskActions.title')}</h2>
        <p className="nova-card-description">{t('taskActions.help')}</p>
      </div>
    </div>
    <div className="nova-toolbar">
      <button data-variant="primary" disabled={isBusy} onClick={onScan}>{isBusy ? t('taskActions.working') : t('taskActions.scan')}</button>
      <button disabled={isBusy || !hasSelection} onClick={onSendSelected}>{t('taskActions.sendSelected')}</button>
      <button disabled={isBusy || !hasCandidates} onClick={onSendAll}>{t('taskActions.sendAll')}</button>
      <button disabled={isBusy || !hasCandidates} onClick={onClear}>{t('taskActions.clear')}</button>
    </div>
  </section>;
}
export default TaskActions;
