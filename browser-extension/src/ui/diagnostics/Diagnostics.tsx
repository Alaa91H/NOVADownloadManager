import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/react';
import { runtimeRequest } from '../runtime-request';
import DiagnosticsPanel, { DiagnosticsModel } from './DiagnosticsPanel';

type LoadState = { status: 'loading' } | { status: 'ready'; diagnostics: DiagnosticsModel } | { status: 'error'; message: string };

export function Diagnostics() {
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  useEffect(() => { void loadDiagnostics(); }, []);

  async function loadDiagnostics(): Promise<void> {
    setState({ status: 'loading' });
    try {
      const value = await runtimeRequest({ type: 'GET_DIAGNOSTICS' });
      setState({ status: 'ready', diagnostics: value as DiagnosticsModel });
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : t('diagnostics.failed') });
    }
  }

  if (state.status === 'error') {
    return <main className="nova-page">
      <div className="nova-page-shell">
        <section className="nova-section">
          <h1>{t('diagnostics.title')}</h1>
          <div className="nova-notice" data-kind="error" role="alert">{state.message}</div>
          <button data-variant="primary" onClick={() => void loadDiagnostics()}>{t('diagnostics.retry')}</button>
        </section>
      </div>
    </main>;
  }

  return <DiagnosticsPanel diagnostics={state.status === 'ready' ? state.diagnostics : undefined} onRefresh={() => void loadDiagnostics()} loading={state.status === 'loading'} />;
}
