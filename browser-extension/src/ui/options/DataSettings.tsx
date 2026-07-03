import { runtimeRequest } from '../runtime-request';
import React, { useMemo, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';
import { useI18n } from '../../i18n/react';

export function DataSettings() {
  const { t } = useI18n();
  const [lastAction, setLastAction] = useState<{ kind: 'success' | 'error' | 'info'; message: string }>();
  const [importJson, setImportJson] = useState<string>('');
  const [confirmReset, setConfirmReset] = useState(false);
  const importPreview = useMemo(() => previewImport(importJson), [importJson]);

  async function clear(scope: string): Promise<void> {
    await runtimeRequest({ type: 'CLEAR_LOCAL_DATA', scope });
    setLastAction({ kind: 'success', message: t('options.data.cleared', { scope }) });
  }

  async function exportSettings(): Promise<void> {
    const data = await runtimeRequest({ type: 'EXPORT_SETTINGS' });
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setLastAction({ kind: 'success', message: t('options.data.exported') });
  }

  async function importSettings(): Promise<void> {
    try {
      const parsed = JSON.parse(importJson) as { settings?: unknown; siteRules?: unknown } | unknown;
      const settings = typeof parsed === 'object' && parsed && 'settings' in parsed ? (parsed as { settings: unknown }).settings : parsed;
      await runtimeRequest({ type: 'IMPORT_SETTINGS', settings });
      if (typeof parsed === 'object' && parsed && 'siteRules' in parsed) {
        await runtimeRequest({ type: 'IMPORT_SITE_RULES', rules: (parsed as { siteRules: unknown }).siteRules });
      }
      setImportJson('');
      setLastAction({ kind: 'success', message: t('options.data.imported') });
    } catch (error) {
      setLastAction({ kind: 'error', message: error instanceof Error ? error.message : t('options.data.importFailed') });
    }
  }

  return <section className="adm-section">
    <div className="adm-section-title-row">
      <div>
        <h2>{t('options.data.title')}</h2>
        <p className="adm-help">{t('options.data.help')}</p>
      </div>
      <span className="adm-pill" data-tone="info">{t('options.data.localOnly')}</span>
    </div>
    {lastAction ? <div className="adm-notice" data-kind={lastAction.kind} role="status">{lastAction.message}</div> : null}
    <div className="adm-grid adm-grid-2">
      <button aria-label={t('options.data.clearCandidateCache')} onClick={() => void clear('candidate-cache')}>{t('options.data.clearCandidateCache')}</button>
      <button aria-label={t('options.data.clearOutbox')} onClick={() => void clear('outbox-terminal')}>{t('options.data.clearOutbox')}</button>
      <button aria-label={t('options.data.clearDiagnostics')} onClick={() => void clear('diagnostics')}>{t('options.data.clearDiagnostics')}</button>
      <button aria-label={t('options.data.clearOverlayDiagnostics')} onClick={() => void clear('overlay-diagnostics')}>{t('options.data.clearOverlayDiagnostics')}</button>{/* Clear overlay diagnostics */}
      <button aria-label={t('options.data.clearOverlayPositions')} onClick={() => void clear('overlay-positions')}>{t('options.data.clearOverlayPositions')}</button>{/* Clear overlay positions */}
      <button aria-label={t('options.data.exportJson')} onClick={() => void exportSettings()}>{t('options.data.exportJson')}</button>
      <button aria-label={t('options.data.resetAll')} data-variant="danger" onClick={() => setConfirmReset(true)}>{t('options.data.resetAll')}</button>
    </div>
    <div className="adm-divider" />
    <label>
      <strong>{t('options.data.importTitle')}</strong>
      <textarea value={importJson} onChange={(event) => setImportJson(event.currentTarget.value)} rows={8} placeholder={t('options.data.importPlaceholder')} />
    </label>
    {importJson.trim() ? <div className="adm-import-preview" data-valid={importPreview.valid}>
      <strong>{importPreview.valid ? t('options.data.importPreview') : t('options.data.invalidJson')}</strong>
      <span>{importPreview.message}</span>
    </div> : null}
    <div className="adm-toolbar">
      <button disabled={!importJson.trim() || !importPreview.valid} onClick={() => void importSettings()}>{t('options.data.importButton')}</button>
    </div>
    {/* Reset all local extension data? */}
    <ConfirmDialog
      open={confirmReset}
      tone="danger"
      title={t('options.data.resetConfirmTitle')}
      description={t('options.data.resetConfirmDescription')}
      confirmLabel={t('options.data.resetConfirmLabel')}
      onCancel={() => setConfirmReset(false)}
      onConfirm={() => {
        setConfirmReset(false);
        void clear('all-local');
      }}
      details={<ul className="adm-dialog-list">
        <li>{t('options.data.resetConfirmDetail1')}</li>
        <li>{t('options.data.resetConfirmDetail2')}</li>
      </ul>}
    />
  </section>;
}

function previewImport(value: string): { valid: boolean; message: string } {
  if (!value.trim()) return { valid: false, message: 'Paste JSON exported by this extension.' };
  try {
    const parsed = JSON.parse(value) as unknown;
    const hasSettings = typeof parsed === 'object' && parsed !== null && 'settings' in parsed;
    const hasSiteRules = typeof parsed === 'object' && parsed !== null && 'siteRules' in parsed;
    if (hasSettings && hasSiteRules) return { valid: true, message: 'Settings and site rules detected.' };
    if (hasSettings) return { valid: true, message: 'Settings object detected.' };
    if (hasSiteRules) return { valid: true, message: 'Site rules object detected.' };
    return { valid: true, message: 'Raw settings JSON detected.' };
  } catch {
    return { valid: false, message: 'The pasted text is not valid JSON.' };
  }
}

export default DataSettings;
