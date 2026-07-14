import React, { useCallback, useEffect, useState } from 'react';
import { BridgeState } from '../../core/app-state';
import { Candidate } from '../../contracts/candidate.schema';
import { MAX_HANDOFF_CANDIDATES } from '../../contracts/limits';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import { capabilitiesForCandidate } from '../../contracts/capabilities.schema';
import { useI18n } from '../../i18n/react';
import AppLogo from '../components/AppLogo';
import { messageFromError, runtimeRequest } from '../runtime-request';
import CandidateList from './CandidateList';
import CandidateFilters from './CandidateFilters';

type Notice = { kind: 'info' | 'error' | 'success'; message: string };
type CandidateFilter = Candidate['mediaType'] | 'all';

function statusTone(status?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'connected') return 'success';
  if (status === 'reconnecting' || status === 'booting' || status === 'discovering' || status === 'pairing' || status === 'authChecking' || status === 'capabilitySyncing') return 'info';
  if (status === 'degraded' || status === 'tokenExpired' || status === 'protocolMismatch') return 'warning';
  return 'danger';
}

function isHandoffable(candidate: Candidate): boolean {
  return handoffPolicyDecision(candidate).allowed;
}

function isSupportedByRuntime(candidate: Candidate, state?: BridgeState): boolean {
  return capabilitiesForCandidate(candidate, state?.capabilities).supported;
}

function unsupportedRuntimeReason(candidate: Candidate, state?: BridgeState): string | undefined {
  const decision = capabilitiesForCandidate(candidate, state?.capabilities);
  if (decision.supported) return undefined;
  return `Desktop runtime capability missing: ${decision.missing ?? 'unknown'}`;
}

export function PopupApp() {
  const { t } = useI18n();
  const [bridge, setBridge] = useState<BridgeState>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [autoScanned, setAutoScanned] = useState(false);

  const tone = statusTone(bridge?.status);

  const refresh = useCallback(async (showErrors = true): Promise<void> => {
    try {
      const state = await runtimeRequest<BridgeState>({ type: 'GET_BRIDGE_STATE' });
      setBridge(state);
    } catch (error) {
      if (showErrors) setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }, []);

  const loadCandidates = useCallback(async (): Promise<void> => {
    try {
      const list = await runtimeRequest<Candidate[]>({ type: 'GET_CANDIDATES' });
      setCandidates(Array.isArray(list) ? list : []);
    } catch (error) {
      // Silently fail - candidates may not be available yet
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadCandidates();
    let interval: number | undefined;
    function startPolling() {
      window.clearInterval(interval);
      interval = window.setInterval(() => {
        void refresh(false);
        void loadCandidates();
      }, 3000);
    }
    function stopPolling() {
      window.clearInterval(interval);
    }
    function onVisibilityChange() {
      if (document.hidden) stopPolling(); else startPolling();
    }
    startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { stopPolling(); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [refresh, loadCandidates]);

  useEffect(() => {
    if (autoScanned || busy) return;
    if (!bridge?.canSend) return;
    void scan();
    setAutoScanned(true);
  }, [bridge?.canSend, autoScanned, busy]);

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function scan(): Promise<void> {
    setBusy(true);
    setNotice({ kind: 'info', message: t('popup.scanning') });
    try {
      const result = await runtimeRequest<{ candidates?: Candidate[] }>({ type: 'SCAN_PAGE', userActivated: true });
      const found = Array.isArray(result?.candidates) ? result.candidates : [];
      setCandidates(found);
      setSelected(new Set());
      setNotice(found.length
        ? { kind: 'success', message: t('popup.scanFound', { count: found.length }) }
        : { kind: 'info', message: t('popup.scanNone') });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function sendSelected(): Promise<void> {
    const chosen = candidates.filter((candidate) => selected.has(candidate.id) && isHandoffable(candidate) && isSupportedByRuntime(candidate, bridge)).slice(0, MAX_HANDOFF_CANDIDATES);
    if (chosen.length === 0) {
      setNotice({ kind: 'error', message: t('popup.noSelected') });
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', message: t('popup.sending', { count: chosen.length }) });
    try {
      await runtimeRequest({ type: 'SEND_BATCH', candidates: chosen });
      setSelected(new Set());
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: chosen.length }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function sendAll(): Promise<void> {
    const handoffable = candidates.filter((candidate) => isHandoffable(candidate) && isSupportedByRuntime(candidate, bridge)).slice(0, MAX_HANDOFF_CANDIDATES);
    if (handoffable.length === 0) {
      setNotice({ kind: 'error', message: t('popup.noCandidates') });
      return;
    }
    setBusy(true);
    setNotice({ kind: 'info', message: t('popup.sending', { count: handoffable.length }) });
    try {
      await runtimeRequest({ type: 'SEND_BATCH', candidates: handoffable });
      setSelected(new Set());
      setNotice({ kind: 'success', message: t('popup.sentResult', { count: handoffable.length }) });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      void refresh(false);
    }
  }

  async function clearCandidates(): Promise<void> {
    setBusy(true);
    try {
      await runtimeRequest({ type: 'CLEAR_CANDIDATES' });
      setCandidates([]);
      setSelected(new Set());
      setNotice({ kind: 'success', message: t('popup.cleared') });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
    }
  }

  const visibleCandidates = filter === 'all' ? candidates : candidates.filter((c) => c.mediaType === filter);
  const handoffableCount = candidates.filter((c) => isHandoffable(c) && isSupportedByRuntime(c, bridge)).length;
  const selectedHandoffable = candidates.some((c) => selected.has(c.id) && isHandoffable(c) && isSupportedByRuntime(c, bridge));

  return (
    <main className="nova-popup-mini-mode">
      <header className="nova-mini-header">
        <div className="nova-mini-brand">
          <AppLogo />
          <div className="nova-mini-brand-text">
            <h1 className="nova-mini-title">NOVA</h1>
            <span className={`nova-mini-status`} data-tone={tone}>
              <span className="nova-mini-dot" />
              {bridge?.canSend ? t('popup.ready') : t('popup.needsCheck')}
            </span>
          </div>
        </div>
        {candidates.length > 0 ? (
          <span className="nova-mini-count-badge">{candidates.length}</span>
        ) : null}
      </header>

      {notice ? <div className="nova-mini-notice" data-kind={notice.kind}>{notice.message}</div> : null}

      {bridge?.lastError ? <div className="nova-mini-notice" data-kind="error">
        <strong>{bridge.lastError.code}</strong>: {bridge.lastError.message}
      </div> : null}

      {candidates.length === 0 && !busy ? (
        <div className="nova-mini-empty">
          <p>{t('candidate.empty.title')}</p>
          <p className="nova-mini-empty-hint">{t('candidate.empty.help')}</p>
        </div>
      ) : (
        <>
          {candidates.length > 0 ? <CandidateFilters value={filter} onChange={setFilter} /> : null}
          <CandidateList
            candidates={visibleCandidates}
            selected={selected}
            isCandidateSupported={(c) => isSupportedByRuntime(c, bridge)}
            unsupportedReason={(c) => unsupportedRuntimeReason(c, bridge)}
            onToggle={toggleSelected}
          />
        </>
      )}

      <footer className="nova-mini-footer">
        <div className="nova-mini-footer-actions">
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-scan"
            disabled={busy || !bridge?.canSend}
            onClick={() => void scan()}
          >
            {busy ? '...' : t('taskActions.scan')}
          </button>
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-send"
            disabled={busy || !selectedHandoffable}
            onClick={() => void sendSelected()}
          >
            {t('taskActions.sendSelected')} {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-send-all"
            disabled={busy || handoffableCount === 0}
            onClick={() => void sendAll()}
          >
            {t('taskActions.sendAll')}
          </button>
        </div>
        {candidates.length > 0 ? (
          <div className="nova-mini-footer-meta">
            <span className="nova-mini-count">{candidates.length} {t('popup.handoffable')}</span>
            <button
              type="button"
              className="nova-mini-btn-text"
              disabled={busy}
              onClick={() => void clearCandidates()}
            >
              {t('taskActions.clear')}
            </button>
          </div>
        ) : null}
        {!bridge?.canSend ? (
          <button
            type="button"
            className="nova-mini-btn nova-mini-btn-connect"
            disabled={busy}
            onClick={() => void runtimeRequest({ type: 'OPEN_NOVA' })}
          >
            {t('popup.action.linkNova')}
          </button>
        ) : null}
      </footer>
    </main>
  );
}

export default PopupApp;
