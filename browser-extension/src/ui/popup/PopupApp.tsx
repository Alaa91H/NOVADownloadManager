import React, { useCallback, useEffect, useMemo, useState } from 'react';
import browser from 'webextension-polyfill';
import { BridgeState } from '../../core/app-state';
import { Candidate } from '../../contracts/candidate.schema';
import { defaultSettings, Settings, SettingsSchema } from '../../contracts/settings.schema';
import { MAX_HANDOFF_CANDIDATES } from '../../contracts/limits';
import { handoffPolicyDecision } from '../../security/handoff-policy';
import type { MessageKey, TranslateFunction } from '../../i18n';
import { useI18n } from '../../i18n/react';
import AppLogo from '../components/AppLogo';
import ConfirmDialog from '../components/ConfirmDialog';
import { messageFromError, runtimeRequest } from '../runtime-request';
import CandidateList from './CandidateList';
import CandidateFilters from './CandidateFilters';
import TaskActions from './TaskActions';
import TaskList, { TaskSummary } from './TaskList';
import OutboxStatus, { OutboxCounts } from './OutboxStatus';

type Notice = { kind: 'info' | 'error' | 'success'; message: string };
type ThemeMode = 'dark' | 'light';
type TabKey = 'connection' | 'candidates' | 'tasks' | 'popup-options' | 'capture-options';
type CandidateFilter = Candidate['mediaType'] | 'all';

const THEME_STORAGE_KEY = 'adm-ui-theme';

const defaultTabOptions: Array<{ value: Settings['popup']['defaultTab']; labelKey: MessageKey }> = [
  { value: 'connection', labelKey: 'popup.tab.connection' },
  { value: 'candidates', labelKey: 'popup.tab.candidates' },
  { value: 'tasks', labelKey: 'popup.tab.tasks' },
  { value: 'popup-options', labelKey: 'popup.tab.popupOptionsFull' },
  { value: 'capture-options', labelKey: 'popup.tab.captureOptionsFull' },
];

function readInitialTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in restricted extension contexts.
  }
}

function statusTone(status?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'connected') return 'success';
  if (status === 'reconnecting' || status === 'booting' || status === 'discovering' || status === 'pairing' || status === 'authChecking' || status === 'capabilitySyncing') return 'info';
  if (status === 'degraded' || status === 'tokenExpired' || status === 'protocolMismatch') return 'warning';
  return 'danger';
}

function connectionLabel(state: BridgeState | undefined, t: TranslateFunction): string {
  if (!state) return t('popup.state.checking');
  if (state.canSend && state.status === 'connected') return t('popup.state.connected');
  if (state.status === 'degraded') return t('popup.state.degraded');
  if (state.status === 'reconnecting') return t('popup.state.reconnecting');
  if (state.status === 'offline') return t('popup.state.offline');
  if (state.status === 'integrationDisabled') return t('popup.state.integrationDisabled');
  if (state.status === 'protocolMismatch') return t('popup.state.protocolMismatch');
  if (state.status === 'tokenExpired') return t('popup.state.tokenExpired');
  return state.status.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());
}

function isHandoffable(candidate: Candidate): boolean {
  return handoffPolicyDecision(candidate).allowed;
}

function clampNumeric(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function visiblePopupTabs(settings: Settings): TabKey[] {
  return ['connection', 'candidates', ...(settings.popup.showTaskTab ? ['tasks' as const] : []), 'popup-options', 'capture-options'];
}

export function PopupApp() {
  const { locale, t } = useI18n();
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [bridge, setBridge] = useState<BridgeState>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [lastChecked, setLastChecked] = useState<string>();
  const [theme, setTheme] = useState<ThemeMode>(() => readInitialTheme());
  const [tab, setTab] = useState<TabKey>('connection');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [outbox, setOutbox] = useState<OutboxCounts>();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [sendAllConfirmOpen, setSendAllConfirmOpen] = useState(false);

  const refresh = useCallback(async (showErrors = true): Promise<void> => {
    try {
      const [state, counts] = await Promise.all([
        runtimeRequest<BridgeState>({ type: 'GET_BRIDGE_STATE' }),
        runtimeRequest<OutboxCounts>({ type: 'GET_OUTBOX_STATUS' }).catch(() => undefined),
      ]);
      setBridge(state);
      if (counts) setOutbox(counts);
      setLastChecked(new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(new Date()));
    } catch (error) {
      if (showErrors) setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }, [locale]);

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const raw = await runtimeRequest<unknown>({ type: 'GET_SETTINGS' });
      const parsed = SettingsSchema.catch(defaultSettings).parse(raw);
      setSettings(parsed);
      setTab((current) => visiblePopupTabs(parsed).includes(parsed.popup.defaultTab) ? parsed.popup.defaultTab : current);
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }, []);

  const saveSettings = useCallback(async (next: Settings, successMessage = t('options.saved')): Promise<void> => {
    const parsed = SettingsSchema.parse(next);
    setSettings(parsed);
    await runtimeRequest({ type: 'UPDATE_SETTINGS', settings: parsed });
    setNotice({ kind: 'success', message: successMessage });
  }, [t]);

  const loadCandidates = useCallback(async (): Promise<void> => {
    try {
      const list = await runtimeRequest<Candidate[]>({ type: 'GET_CANDIDATES' });
      setCandidates(Array.isArray(list) ? list : []);
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }, []);

  const loadTasks = useCallback(async (): Promise<void> => {
    try {
      const result = await runtimeRequest<{ ok?: boolean; tasks?: TaskSummary[] }>({ type: 'LIST_TASKS' });
      setTasks(Array.isArray(result?.tasks) ? result.tasks : []);
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void refresh();
    let interval: number | undefined;
    function startPolling() {
      window.clearInterval(interval);
      interval = window.setInterval(() => void refresh(false), 5000);
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
  }, [loadSettings, refresh]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (tab === 'candidates') void loadCandidates();
    if (tab === 'tasks') void loadTasks();
  }, [tab, loadCandidates, loadTasks]);

  useEffect(() => {
    if (tab !== 'candidates' || !settings.popup.autoRefreshCandidates) return undefined;
    const interval = window.setInterval(() => void loadCandidates(), settings.popup.candidateRefreshMs);
    return () => window.clearInterval(interval);
  }, [tab, settings.popup.autoRefreshCandidates, settings.popup.candidateRefreshMs, loadCandidates]);

  async function run(startMessage: string, action: () => Promise<string>): Promise<void> {
    setBusy(true);
    setNotice({ kind: 'info', message: startMessage });
    try {
      const done = await action();
      setNotice({ kind: 'success', message: done });
    } catch (error) {
      setNotice({ kind: 'error', message: messageFromError(error) });
    } finally {
      setBusy(false);
      await refresh(false);
    }
  }

  async function retry(): Promise<void> {
    await run(t('popup.notice.checkingConnection'), async () => {
      const state = await runtimeRequest<BridgeState>({ type: 'RETRY_CONNECT' });
      setBridge(state);
      return t('popup.notice.connectionUpdated');
    });
  }

  async function repair(): Promise<void> {
    await run(t('popup.notice.linkingAdm'), async () => {
      const state = await runtimeRequest<BridgeState>({ type: 'RESET_PAIRING' });
      setBridge(state);
      return t('popup.notice.linkAttemptComplete');
    });
  }

  function toggleTheme(): void {
    setTheme((current) => current === 'dark' ? 'light' : 'dark');
  }

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function scan(): Promise<void> {
    await run(t('popup.scanning'), async () => {
      const result = await runtimeRequest<{ candidates?: Candidate[] }>({ type: 'SCAN_PAGE', userActivated: true });
      const found = Array.isArray(result?.candidates) ? result.candidates : [];
      setCandidates(found);
      setSelected(new Set());
      return found.length ? t('popup.scanFound', { count: found.length }) : t('popup.scanNone');
    });
  }

  async function sendCandidates(toSend: Candidate[], emptyMessage: string): Promise<void> {
    const handoffable = toSend.filter(isHandoffable).slice(0, MAX_HANDOFF_CANDIDATES);
    if (handoffable.length === 0) {
      setNotice({ kind: 'error', message: emptyMessage });
      return;
    }
    await run(t('popup.sending', { count: handoffable.length }), async () => {
      await runtimeRequest({ type: 'SEND_BATCH', candidates: handoffable });
      setSelected(new Set());
      const counts = await runtimeRequest<OutboxCounts>({ type: 'GET_OUTBOX_STATUS' }).catch(() => undefined);
      if (counts) setOutbox(counts);
      return t('popup.sentResult', { count: handoffable.length });
    });
  }

  async function sendSelected(): Promise<void> {
    const chosen = candidates.filter((candidate) => selected.has(candidate.id));
    await sendCandidates(chosen, t('popup.noSelected'));
  }

  async function sendAll(): Promise<void> {
    if (settings.popup.confirmBeforeSendAll) {
      setSendAllConfirmOpen(true);
      return;
    }
    await sendAllConfirmed();
  }

  async function sendAllConfirmed(): Promise<void> {
    setSendAllConfirmOpen(false);
    await sendCandidates(candidates, t('popup.noCandidates'));
  }

  async function clearCandidates(): Promise<void> {
    await run(t('popup.clearing'), async () => {
      await runtimeRequest({ type: 'CLEAR_CANDIDATES' });
      setCandidates([]);
      setSelected(new Set());
      return t('popup.cleared');
    });
  }

  async function retryOutbox(): Promise<void> {
    await run(t('popup.retrying'), async () => {
      const counts = await runtimeRequest<OutboxCounts>({ type: 'RUN_OUTBOX_RETRY' });
      if (counts) setOutbox(counts);
      return t('popup.retried');
    });
  }

  function taskCommand(type: 'PAUSE_TASK' | 'RESUME_TASK' | 'CANCEL_TASK', taskId: string, label: string, doneMessage: string): void {
    void run(`${label}…`, async () => {
      await runtimeRequest({ type, taskId });
      await loadTasks();
      return doneMessage;
    });
  }

  function patchPopup(patch: Partial<Settings['popup']>): void {
    const next = { ...settings, popup: { ...settings.popup, ...patch } };
    void saveSettings(next, t('popup.settingsSavedPopup'));
  }

  function patchCapture(patch: Partial<Settings['capture']>): void {
    const next = { ...settings, capture: { ...settings.capture, ...patch } };
    void saveSettings(next, t('popup.settingsSavedCapture'));
  }

  function patchOverlay(patch: Partial<Settings['overlay']>): void {
    const next = { ...settings, overlay: { ...settings.overlay, ...patch } };
    void saveSettings(next, t('popup.settingsSavedOverlay'));
  }

  const tone = statusTone(bridge?.status);
  const availableTabs = useMemo(() => visiblePopupTabs(settings), [settings]);
  const visibleCandidates = filter === 'all' ? candidates : candidates.filter((candidate) => candidate.mediaType === filter);
  const limitedCandidates = visibleCandidates.slice(0, settings.popup.maxVisibleCandidates);
  const hiddenByPopupLimit = Math.max(0, visibleCandidates.length - limitedCandidates.length);
  const handoffableCount = candidates.filter(isHandoffable).length;
  const protectedCount = candidates.filter((candidate) => Boolean(candidate.drm?.protected || candidate.metadata?.drmProtected)).length;
  const selectedHandoffable = candidates.some((candidate) => selected.has(candidate.id) && isHandoffable(candidate));

  return <main className="adm-popup adm-connection-popup" data-density={settings.popup.density}>
    <section className="adm-connection-panel" aria-label={t('popup.connection.aria')}>
      <header className="adm-connection-header">
        <div className="adm-brand">
          <AppLogo />
          <div>
            <h1 className="adm-title">{t('popup.title')}</h1>
            <p className="adm-subtitle">{t('popup.subtitle')}</p>
          </div>
        </div>
        <div className="adm-header-tools">
          <button
            type="button"
            className="adm-theme-toggle"
            title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
            aria-label={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? t('theme.light') : t('theme.dark')}
          </button>
          <span className="adm-pill" data-tone={tone}>{bridge?.canSend ? t('popup.ready') : t('popup.needsCheck')}</span>
        </div>
      </header>

      <nav className="adm-tabs adm-popup-tabs" role="tablist" aria-label={t('popup.tab.aria')}>
        <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'connection'} onClick={() => setTab('connection')}>{t('popup.tab.connection')}</button>
        <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'candidates'} onClick={() => setTab('candidates')}>
          {t('popup.tab.candidates')}{settings.popup.showCandidateCounts && candidates.length ? ` (${candidates.length})` : ''}
        </button>
        {availableTabs.includes('tasks') ? <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'tasks'} onClick={() => setTab('tasks')}>{t('popup.tab.tasks')}</button> : null}
        <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'popup-options'} onClick={() => setTab('popup-options')}>{t('popup.tab.popupOptions')}</button>
        <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'capture-options'} onClick={() => setTab('capture-options')}>{t('popup.tab.captureOptions')}</button>
      </nav>

      {notice ? <div role="status" className="adm-notice" data-kind={notice.kind}>{notice.message}</div> : null}

      {tab === 'connection' ? <>
        <div className="adm-connection-state" data-tone={tone}>
          <span className="adm-connection-dot" aria-hidden="true" />
          <div>
            <strong>{connectionLabel(bridge, t)}</strong>
            <span>{bridge?.canSend ? t('popup.message.canSend') : t('popup.message.cannotSend')}</span>
          </div>
        </div>

        {settings.popup.showTechnicalConnectionDetails ? <dl className="adm-connection-details">
          <dt>{t('popup.detail.transport')}</dt><dd>{bridge?.transport ?? t('popup.detail.unavailable')}</dd>
          <dt>{t('popup.detail.protocol')}</dt><dd>{bridge?.protocolVersion ? `v${bridge.protocolVersion}` : t('popup.detail.unknown')}</dd>
          <dt>{t('popup.detail.lastCheck')}</dt><dd>{lastChecked ?? t('popup.detail.notYet')}</dd>
        </dl> : null}

        {bridge?.lastError ? <div className="adm-notice" data-kind={bridge.lastError.retryable ? 'info' : 'error'} role="status">
          <strong>{bridge.lastError.code}</strong>: {bridge.lastError.message}
        </div> : null}

        <div className="adm-connection-actions">
          <button type="button" data-variant="primary" disabled={busy} onClick={() => void retry()}>{busy ? t('popup.action.checking') : t('popup.action.checkConnection')}</button>
          <button type="button" disabled={busy} onClick={() => void repair()}>{t('popup.action.linkAdm')}</button>
          <button type="button" onClick={() => void runtimeRequest({ type: 'OPEN_ADM' })}>{t('popup.action.openAdm')}</button>
          <button type="button" onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('diagnostics.html') })}>{t('popup.action.diagnostics')}</button>
        </div>

        {settings.popup.showOutboxOnConnection ? <OutboxStatus counts={outbox} onRetry={() => void retryOutbox()} /> : null}
      </> : null}

      {tab === 'candidates' ? <>
        <TaskActions
          hasCandidates={handoffableCount > 0}
          hasSelection={selectedHandoffable}
          isBusy={busy}
          onScan={() => void scan()}
          onSendSelected={() => void sendSelected()}
          onSendAll={() => void sendAll()}
          onClear={() => void clearCandidates()}
        />
        <div className="adm-popup-summary-row" aria-label={t('candidate.summary')}>
          <span className="adm-pill" data-tone="success">{handoffableCount} {t('popup.handoffable')}</span>
          <span className="adm-pill" data-tone={protectedCount ? 'warning' : 'info'}>{protectedCount} {t('popup.protected')}</span>
          <span className="adm-pill" data-tone="info">{t('popup.refresh')} {settings.popup.autoRefreshCandidates ? `${settings.popup.candidateRefreshMs}ms` : t('popup.refreshManual')}</span>
        </div>
        <CandidateFilters value={filter} onChange={setFilter} />
        {hiddenByPopupLimit ? <div className="adm-detail-note">{t('popup.candidatesShowing', { shown: limitedCandidates.length, total: visibleCandidates.length })}</div> : null}
        <CandidateList candidates={limitedCandidates} selected={selected} showHandoffWarnings={settings.popup.showHandoffWarnings} onToggle={toggleSelected} onStreamSent={() => {
          setNotice({ kind: 'success', message: t('popup.streamQueued') });
          void runtimeRequest<OutboxCounts>({ type: 'GET_OUTBOX_STATUS' }).then((counts) => { if (counts) setOutbox(counts); }).catch(() => undefined);
        }} />
        <OutboxStatus counts={outbox} onRetry={() => void retryOutbox()} />
      </> : null}

      {tab === 'tasks' ? <TaskList
        tasks={tasks}
        onRefresh={() => void loadTasks()}
        onPause={(taskId) => taskCommand('PAUSE_TASK', taskId, t('task.pausing'), t('task.pauseSent'))}
        onResume={(taskId) => taskCommand('RESUME_TASK', taskId, t('task.resuming'), t('task.resumeSent'))}
        onCancel={(taskId) => taskCommand('CANCEL_TASK', taskId, t('task.cancelling'), t('task.cancelSent'))}
      /> : null}

      {tab === 'popup-options' ? <section className="adm-popup-options-panel" aria-label={t('popup.customization.title')}>
        <div className="adm-section-title-row">
          <div>
            <h2>{t('popup.customization.title')}</h2>{/* Popup customization */}
            <p className="adm-help">{t('popup.customization.help')}</p>
          </div>
          <button type="button" onClick={() => void runtimeRequest({ type: 'OPEN_OPTIONS' })}>{t('popup.customization.fullOptions')}</button>
        </div>
        <div className="adm-field-grid adm-popup-field-grid">
          <label className="adm-toggle">
            <span><strong>{t('popup.customization.defaultTab')}</strong><span>{t('popup.customization.defaultTabHelp')}</span></span>
            <select value={settings.popup.defaultTab} onChange={(event) => patchPopup({ defaultTab: event.currentTarget.value as Settings['popup']['defaultTab'] })}>
              {defaultTabOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
            </select>
          </label>
          <label className="adm-toggle">
            <span><strong>{t('popup.customization.density')}</strong><span>{t('popup.customization.densityHelp')}</span></span>
            <select value={settings.popup.density} onChange={(event) => patchPopup({ density: event.currentTarget.value as Settings['popup']['density'] })}>
              <option value="comfortable">{t('popup.customization.densityComfortable')}</option>
              <option value="compact">{t('popup.customization.densityCompact')}</option>
              <option value="dense">{t('popup.customization.densityDense')}</option>
            </select>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.showTechnicalConnectionDetails} onChange={(event) => patchPopup({ showTechnicalConnectionDetails: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.techDetails')}</strong><span>{t('popup.customization.techDetailsHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.showOutboxOnConnection} onChange={(event) => patchPopup({ showOutboxOnConnection: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.outboxOnConnection')}</strong><span>{t('popup.customization.outboxOnConnectionHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.showTaskTab} onChange={(event) => patchPopup({ showTaskTab: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.showTasks')}</strong><span>{t('popup.customization.showTasksHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.showCandidateCounts} onChange={(event) => patchPopup({ showCandidateCounts: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.showCounts')}</strong><span>{t('popup.customization.showCountsHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.autoRefreshCandidates} onChange={(event) => patchPopup({ autoRefreshCandidates: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.autoRefresh')}</strong><span>{t('popup.customization.autoRefreshHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <span><strong>{t('popup.customization.refreshInterval')}</strong><span>{t('popup.customization.refreshIntervalHelp')}</span></span>
            <input type="number" min={1000} max={30000} step={500} value={settings.popup.candidateRefreshMs} onChange={(event) => patchPopup({ candidateRefreshMs: clampNumeric(Number(event.currentTarget.value), 1000, 30000) })} />
          </label>
          <label className="adm-toggle">
            <span><strong>{t('popup.customization.visibleLimit')}</strong><span>{t('popup.customization.visibleLimitHelp')}</span></span>
            <input type="number" min={20} max={500} step={10} value={settings.popup.maxVisibleCandidates} onChange={(event) => patchPopup({ maxVisibleCandidates: clampNumeric(Number(event.currentTarget.value), 20, 500) })} />
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.confirmBeforeSendAll} onChange={(event) => patchPopup({ confirmBeforeSendAll: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.confirmSendAll')}</strong><span>{t('popup.customization.confirmSendAllHelp')}</span></span>{/* Confirm before Send all */}
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.popup.showHandoffWarnings} onChange={(event) => patchPopup({ showHandoffWarnings: event.currentTarget.checked })} />
            <span><strong>{t('popup.customization.showHandoffWarnings')}</strong><span>{t('popup.customization.showHandoffWarningsHelp')}</span></span>
          </label>
        </div>
      </section> : null}

      {tab === 'capture-options' ? <section className="adm-popup-options-panel" aria-label={t('popup.capture.title')}>
        <div className="adm-section-title-row">
          <div>
            <h2>{t('popup.capture.title')}</h2>{/* Capture customization */}
            <p className="adm-help">{t('popup.capture.help')}</p>
          </div>
          <span className="adm-pill" data-tone={settings.capture.aggressiveMode ? 'warning' : 'info'}>{settings.capture.aggressiveMode ? t('options.aggressiveMode') : t('options.standardMode')}</span>
        </div>

          <div className="adm-card adm-drm-policy-card">
          <div className="adm-card-header">
            <div>
              <h3 className="adm-card-title">{t('popup.capture.drm.title')}</h3>
              <p className="adm-card-description">{t('popup.capture.drm.help')}</p>
            </div>
          </div>
          <div className="adm-field-grid adm-popup-field-grid">
            {/* Download DRM-protected video */}

          </div>
        </div>

        <div className="adm-field-grid adm-popup-field-grid">
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.dom} onChange={(event) => patchCapture({ dom: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.dom')}</strong><span>{t('popup.capture.domHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.network} onChange={(event) => patchCapture({ network: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.network')}</strong><span>{t('popup.capture.networkHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.downloads} onChange={(event) => patchCapture({ downloads: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.downloads')}</strong><span>{t('popup.capture.downloadsHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.hlsDash} onChange={(event) => patchCapture({ hlsDash: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.hlsDash')}</strong><span>{t('popup.capture.hlsDashHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.mediaProbe} onChange={(event) => patchCapture({ mediaProbe: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.mediaProbe')}</strong><span>{t('popup.capture.mediaProbeHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.showLowConfidence} onChange={(event) => patchCapture({ showLowConfidence: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.lowConfidence')}</strong><span>{t('popup.capture.lowConfidenceHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.preferManifestQualities} onChange={(event) => patchCapture({ preferManifestQualities: event.currentTarget.checked })} />
            <span><strong>{t('popup.capture.preferManifest')}</strong><span>{t('popup.capture.preferManifestHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <input type="checkbox" checked={settings.capture.liveQualityRefresh && settings.overlay.smartVideoContinuousRefresh} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void saveSettings({
                ...settings,
                capture: { ...settings.capture, liveQualityRefresh: enabled },
                overlay: { ...settings.overlay, smartVideoContinuousRefresh: enabled },
              }, t('popup.settingsSavedLive'));
            }} />
            <span><strong>{t('popup.capture.liveQualityRefresh')}</strong><span>{t('popup.capture.liveQualityRefreshHelp')}</span></span>
          </label>
          <label className="adm-toggle">
            <span><strong>{t('popup.capture.minFileSize')}</strong><span>{t('popup.capture.minFileSizeHelp')}</span></span>
            <input type="number" min={0} step={1} value={settings.capture.minFileSizeMB} onChange={(event) => patchCapture({ minFileSizeMB: Math.max(0, Number(event.currentTarget.value) || 0) })} />
          </label>
          <label className="adm-toggle">
            <span><strong>{t('popup.capture.overlayRefresh')}</strong><span>{t('popup.capture.overlayRefreshHelp')}</span></span>
            <input type="number" min={250} max={15000} step={250} value={settings.overlay.smartVideoRefreshMs} onChange={(event) => patchOverlay({ smartVideoRefreshMs: clampNumeric(Number(event.currentTarget.value), 250, 15000) })} />
          </label>
        </div>
      </section> : null}
      <ConfirmDialog
        open={sendAllConfirmOpen}
        title={t('confirm.sendAll.title')}
        description={t('confirm.sendAll.description')}
        confirmLabel={t('confirm.sendAll.confirm')}
        cancelLabel={t('confirm.sendAll.cancel')}
        tone="warning"
        details={<ul className="adm-dialog-list"><li>{t('confirm.sendAll.items', { count: handoffableCount })}</li><li>{t('confirm.sendAll.protectedItems', { count: protectedCount })}</li></ul>}
        onConfirm={() => void sendAllConfirmed()}
        onCancel={() => setSendAllConfirmOpen(false)}
      />
    </section>
  </main>;
}

export default PopupApp;
