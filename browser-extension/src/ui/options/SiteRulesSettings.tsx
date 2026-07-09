import { runtimeRequest } from '../runtime-request';
import React, { useEffect, useMemo, useState } from 'react';
import { createDefaultSiteRule, SiteRule, SiteRuleSchema } from '../../rules/site-rules';
import ConfirmDialog from '../components/ConfirmDialog';
import { useI18n } from '../../i18n/react';

const mediaTypeOptions: SiteRule['mediaTypes'] = ['video', 'audio', 'image', 'document', 'archive', 'app', 'torrent', 'magnet'];

export function SiteRulesSettings() {
  const { t } = useI18n();
  const [rules, setRules] = useState<SiteRule[]>([]);
  const [host, setHost] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; message: string }>();
  // Delete site rule?
  const [deleteTarget, setDeleteTarget] = useState<SiteRule>();
  const sorted = useMemo(() => [...rules].sort((a, b) => a.host.localeCompare(b.host)), [rules]);

  useEffect(() => { void refresh(); }, []);

  async function refresh(): Promise<void> {
    try {
      const raw = await runtimeRequest({ type: 'GET_SITE_RULES' });
      const parsed = SiteRuleSchema.array().safeParse(raw);
      if (parsed.success) setRules(parsed.data);
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('options.siteRules.loadError') });
    }
  }

  async function add(): Promise<void> {
    if (!host.trim()) return;
    try {
      await runtimeRequest({ type: 'UPSERT_SITE_RULE', rule: createDefaultSiteRule(host) });
      setNotice({ kind: 'success', message: t('options.siteRules.ruleAdded', { host: host.trim() }) });
      setHost('');
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('options.siteRules.addError') });
    }
  }

  async function update(rule: SiteRule, patch: Partial<SiteRule>): Promise<void> {
    try {
      const next = SiteRuleSchema.parse({ ...rule, ...patch, updatedAt: new Date().toISOString() });
      await runtimeRequest({ type: 'UPSERT_SITE_RULE', rule: next });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('options.siteRules.updateError') });
    }
  }

  async function remove(rule: SiteRule): Promise<void> {
    try {
      await runtimeRequest({ type: 'DELETE_SITE_RULE', id: rule.id });
      setNotice({ kind: 'success', message: t('options.siteRules.ruleDeleted', { host: rule.host }) });
      setDeleteTarget(undefined);
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : t('options.siteRules.deleteError') });
    }
  }

  async function exportRules(): Promise<void> {
    const data = await runtimeRequest({ type: 'EXPORT_SITE_RULES' });
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setNotice({ kind: 'success', message: t('options.siteRules.rulesExported') });
  }

  function toggleMedia(rule: SiteRule, mediaType: SiteRule['mediaTypes'][number], enabled: boolean): void {
    const next = enabled ? [...new Set([...rule.mediaTypes, mediaType])] : rule.mediaTypes.filter((value) => value !== mediaType);
    if (next.length > 0) void update(rule, { mediaTypes: next });
  }

  return <section className="nova-section">
    <div className="nova-section-title-row">
      <div>
        <h2>{t('options.siteRules.title')}</h2>
        <p className="nova-help">{t('options.siteRules.help')}</p>
      </div>
      <span className="nova-pill" data-tone={sorted.length ? 'info' : 'warning'}>{sorted.length} rules</span>
    </div>
    {notice ? <div className="nova-notice" data-kind={notice.kind} role="status">{notice.message}</div> : null}
    <div className="nova-form-row">
      <input placeholder={t('options.siteRules.addPlaceholder')} aria-label={t('options.siteRules.addPlaceholder')} value={host} onChange={(event) => setHost(event.currentTarget.value)} />
      <button data-variant="primary" disabled={!host.trim()} onClick={() => void add()}>{t('options.siteRules.addRule')}</button>
      <button onClick={() => void exportRules()}>{t('options.siteRules.copyJson')}</button>
    </div>
    <div className="nova-divider" />
    {sorted.length === 0 ? <div className="nova-empty">
      <strong>{t('options.siteRules.emptyTitle')}</strong>
      <p>{t('options.siteRules.emptyHelp')}</p>
    </div> : <div className="nova-grid">
      {sorted.map((rule) => <article key={rule.id} className="nova-rule-card" data-disabled={!rule.enabled}>
        <div className="nova-rule-header">
          <div>
            <h3 className="nova-card-title">{rule.host}</h3>
            <p className="nova-card-description">{t('options.siteRules.ruleDetail', { size: rule.minSizeMB, count: rule.mediaTypes.length, sendBehavior: rule.askBeforeSend ? t('options.siteRules.sendAsk') : t('options.siteRules.sendAuto') })}</p>
          </div>
          <div className="nova-actions-row">
            <span className="nova-pill" data-tone={rule.enabled ? 'success' : 'warning'}>{rule.enabled ? t('options.siteRules.enabled') : t('options.siteRules.disabled')}</span>
            <button data-variant="danger" onClick={() => setDeleteTarget(rule)}>{t('options.siteRules.delete')}</button>
          </div>
        </div>
        <div className="nova-field-grid">
          <label className="nova-toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => void update(rule, { enabled: event.currentTarget.checked })} /><span><strong>{t('options.siteRules.enabledLabel')}</strong><span>{t('options.siteRules.enabledHelp')}</span></span></label>
          <label className="nova-toggle"><input type="checkbox" checked={rule.autoCapture} onChange={(event) => void update(rule, { autoCapture: event.currentTarget.checked })} /><span><strong>{t('options.siteRules.autoCapture')}</strong><span>{t('options.siteRules.autoCaptureHelp')}</span></span></label>
          <label className="nova-toggle"><input type="checkbox" checked={rule.askBeforeSend} onChange={(event) => void update(rule, { askBeforeSend: event.currentTarget.checked })} /><span><strong>{t('options.siteRules.askBeforeSend')}</strong><span>{t('options.siteRules.askBeforeSendHelp')}</span></span></label>
          <label className="nova-toggle"><span><strong>{t('options.siteRules.minSize')}</strong><span>{t('options.siteRules.minSizeHelp')}</span></span><input type="number" min={0} value={rule.minSizeMB} onChange={(event) => void update(rule, { minSizeMB: Number(event.currentTarget.value) })} /></label>
        </div>
        <div className="nova-check-grid">
          {mediaTypeOptions.map((mediaType) => <label key={mediaType} className="nova-check-chip">
            <input type="checkbox" checked={rule.mediaTypes.includes(mediaType)} onChange={(event) => toggleMedia(rule, mediaType, event.currentTarget.checked)} /> {mediaType}
          </label>)}
        </div>
        <details className="nova-rule-details">
          <summary>{t('options.siteRules.advancedFilters')}</summary>
          <div className="nova-grid nova-grid-2">
            <label><strong>{t('options.siteRules.includePatterns')}</strong><textarea rows={3} value={rule.includePatterns.join('\n')} onChange={(event) => void update(rule, { includePatterns: splitLines(event.currentTarget.value) })} placeholder={t('options.siteRules.patternPlaceholder')} /></label>
            <label><strong>{t('options.siteRules.excludePatterns')}</strong><textarea rows={3} value={rule.excludePatterns.join('\n')} onChange={(event) => void update(rule, { excludePatterns: splitLines(event.currentTarget.value) })} placeholder={t('options.siteRules.patternPlaceholder')} /></label>
          </div>
        </details>
      </article>)}
    </div>}
    <ConfirmDialog
      open={Boolean(deleteTarget)}
      tone="danger"
      title={t('options.siteRules.deleteConfirmTitle')}
      description={deleteTarget ? t('options.siteRules.deleteConfirmDescription', { host: deleteTarget.host }) : t('options.siteRules.deleteConfirmDescriptionGeneric')}
      confirmLabel={t('options.siteRules.deleteConfirmLabel')}
      onCancel={() => setDeleteTarget(undefined)}
      onConfirm={() => { if (deleteTarget) void remove(deleteTarget); }}
    />
  </section>;
}

function splitLines(value: string): string[] {
  return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
}

export default SiteRulesSettings;
