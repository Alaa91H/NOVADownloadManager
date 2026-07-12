import { runtimeRequest, messageFromError } from '../runtime-request';
import React, { useEffect, useState } from 'react';
import { AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE } from '../../profiles/aggressive-capture-profile';
import { useI18n } from '../../i18n/react';

type PermissionEntry = { granted: boolean; reason: string; degradedFeature?: string };

const requestMap: Record<string, { permissions?: string[]; origins?: string[] }> = {
  downloads: { permissions: ['downloads'] },
  webRequest: { permissions: ['webRequest'], origins: ['<all_urls>'] },
  scripting: { permissions: ['scripting'] },
  tabs: { permissions: ['tabs'] },
  allUrls: { origins: ['<all_urls>'] },
};

// Request aggressive all-sites permission bundle
export function PermissionsSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Record<string, PermissionEntry>>({});
  const [notice, setNotice] = useState<string>('');

  useEffect(() => { void refresh(); }, []);

  async function refresh(): Promise<void> {
    const raw = await runtimeRequest({ type: 'GET_PERMISSION_STATUS' });
    setStatus(raw as Record<string, PermissionEntry>);
  }

  async function request(key: string): Promise<void> {
    const query = requestMap[key];
    if (!query) return;
    try {
      await runtimeRequest({ type: 'REQUEST_PERMISSION', permissions: query.permissions ?? [], origins: query.origins ?? [] });
      setNotice(t('options.permissions.noticeRequested'));
      await refresh();
    } catch (error) {
      setNotice(messageFromError(error));
    }
  }

  async function requestAggressiveBundle(): Promise<void> {
    try {
      await runtimeRequest({ type: 'REQUEST_PERMISSION', permissions: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions, origins: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins });
      setNotice(t('options.permissions.noticeAggressiveRequested'));
      await refresh();
    } catch (error) {
      setNotice(messageFromError(error));
    }
  }

  return <section className="nova-section">
    <h2>{t('options.permissions.title')}</h2>
    <p className="nova-help">{t('options.permissions.help')}</p>
    {notice ? <div className="nova-notice" data-kind="info" role="status">{notice}</div> : null}
    <div className="nova-toolbar">
      <button data-variant="primary" type="button" onClick={() => void requestAggressiveBundle()}>{t('options.permissions.requestAggressive')}</button>
      <button type="button" onClick={() => void refresh()}>{t('options.permissions.refresh')}</button>
    </div>
    <div className="nova-grid nova-grid-2">
      {Object.entries(status).map(([key, entry]) => <article key={key} className="nova-card">
        <div className="nova-card-header">
          <div>
            <h3 className="nova-card-title">{key}</h3>
            <p className="nova-card-description">{entry.reason}</p>
          </div>
          <span className="nova-pill" data-tone={entry.granted ? 'success' : 'warning'}>{entry.granted ? t('options.permissions.granted') : t('options.permissions.missing')}</span>
        </div>
        {!entry.granted && entry.degradedFeature ? <p className="nova-card-description">{t('options.permissions.degradedFeature', { feature: entry.degradedFeature })}</p> : null}
        {!entry.granted && requestMap[key] ? <button onClick={() => void request(key)}>{t('options.permissions.request')}</button> : null}
      </article>)}
    </div>
  </section>;
}
export default PermissionsSettings;
