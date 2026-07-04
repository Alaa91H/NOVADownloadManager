import { runtimeRequest, messageFromError } from '../runtime-request';
import React, { useState } from 'react';
import { useI18n } from '../../i18n/react';

type Notice = { kind: 'success' | 'error' | 'info'; message: string };

export function ConnectionSettings() {
  const { t } = useI18n();
  const [notice, setNotice] = useState<Notice>();

  async function run(message: string, successMessage: string, action: () => Promise<unknown>): Promise<void> {
    setNotice({ kind: 'info', message });
    try {
      await action();
      setNotice({ kind: 'success', message: successMessage });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }

  return <section className="adm-section">
    <h2>{t('options.connection.title')}</h2>
    <p className="adm-help">{t('options.connection.help')}</p>
    {notice ? <div className="adm-notice" data-kind={notice.kind} role="status">{notice.message}</div> : null}
    <div className="adm-grid adm-grid-3">
      <button aria-label={t('options.connection.reconnect')} data-variant="primary" onClick={() => void run(t('options.connection.noticeReconnecting'), t('options.connection.actionCompleted'), () => runtimeRequest({ type: 'RETRY_CONNECT' }))}>{t('options.connection.reconnect')}</button>
      <button aria-label={t('options.connection.linkAdm')} onClick={() => void run(t('options.connection.noticeLinking'), t('options.connection.actionCompleted'), () => runtimeRequest({ type: 'RESET_PAIRING' }))}>{t('options.connection.linkAdm')}</button>{/* Link with ADM */}
      <button aria-label={t('options.connection.copyDiagnostics')} onClick={() => void run(t('options.connection.noticeCopying'), t('options.connection.actionCompleted'), async () => {
        const diagnostics = await runtimeRequest({ type: 'GET_DIAGNOSTICS' });
        await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      })}>{t('options.connection.copyDiagnostics')}</button>
    </div>
  </section>;
}

export default ConnectionSettings;
