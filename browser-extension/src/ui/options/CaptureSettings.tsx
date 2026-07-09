import React, { useState } from 'react';
import { Settings } from '../../contracts/settings.schema';
import { AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE, applyAggressiveCaptureDefaults, disableAggressiveCapture, summarizeAggressivePermissionGrant } from '../../profiles/aggressive-capture-profile';
import { messageFromError, runtimeRequest } from '../runtime-request';
import { useI18n } from '../../i18n/react';

import type { MessageKey } from '../../i18n';

type CaptureRowConfig = { key: keyof Settings['capture']; tKey: MessageKey; tHelpKey: MessageKey };
const captureRowConfigs: CaptureRowConfig[] = [
  { key: 'dom', tKey: 'options.capture.dom', tHelpKey: 'options.capture.domHelp' },
  { key: 'network', tKey: 'options.capture.network', tHelpKey: 'options.capture.networkHelp' },
  { key: 'downloads', tKey: 'options.capture.downloads', tHelpKey: 'options.capture.downloadsHelp' },
  { key: 'hlsDash', tKey: 'options.capture.hlsDash', tHelpKey: 'options.capture.hlsDashHelp' },
  { key: 'mediaProbe', tKey: 'options.capture.mediaProbe', tHelpKey: 'options.capture.mediaProbeHelp' },
  { key: 'showLowConfidence', tKey: 'options.capture.showLowConfidence', tHelpKey: 'options.capture.showLowConfidenceHelp' },
  { key: 'preferManifestQualities', tKey: 'options.capture.preferManifestQualities', tHelpKey: 'options.capture.preferManifestQualitiesHelp' },
  { key: 'liveQualityRefresh', tKey: 'options.capture.liveQualityRefresh', tHelpKey: 'options.capture.liveQualityRefreshHelp' },
];

export function CaptureSettings({ settings, onChange }: { settings: Settings; onChange(settings: Settings): void }) {
  const { t } = useI18n();
  const capture = settings.capture;
  const [notice, setNotice] = useState<string>();

  function patch(next: Partial<Settings['capture']>): void { onChange({ ...settings, capture: { ...capture, ...next } }); }

  async function enableAggressive(): Promise<void> {
    try {
      const grant = await runtimeRequest({ type: 'REQUEST_PERMISSION', permissions: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions, origins: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins }) as { granted?: boolean; requested?: { permissions?: string[]; origins?: string[] } };
      const summary = summarizeAggressivePermissionGrant(grant);
      if (!summary.granted || !summary.hasAllSitesAccess) {
        setNotice(t('options.capture.aggressive.failedNotice')); {/* the mode remains off */}
        onChange(disableAggressiveCapture(settings));
        return;
      }
      const next = applyAggressiveCaptureDefaults(settings);
      onChange(next);
      setNotice(t('options.capture.aggressive.enabledNotice')); {/* Aggressive Capture Mode enabled with all-sites access */}
    } catch (error) {
      setNotice(messageFromError(error));
      onChange(disableAggressiveCapture(settings));
    }
  }

  function disableAggressive(): void {
    onChange(disableAggressiveCapture(settings));
    setNotice(t('options.capture.aggressive.disabledNotice'));
  }

  async function requestAggressivePermissions(): Promise<void> {
    try {
      await runtimeRequest({ type: 'REQUEST_PERMISSION', permissions: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.permissions, origins: AGGRESSIVE_CAPTURE_PERMISSION_BUNDLE.origins });
      setNotice(t('options.capture.aggressive.permissionNotice'));
    } catch (error) {
      setNotice(messageFromError(error));
    }
  }

  return <section className="nova-section">
    <h2>{t('options.capture.title')}</h2>{/* Aggressive Capture Mode */}
    <p className="nova-help">{t('options.capture.help')}</p>
    <div className="nova-card nova-danger-zone">
      <div className="nova-card-header">
        <div>
          <h3 className="nova-card-title">{t('options.capture.aggressive.title')}</h3>
          <p className="nova-card-description">{t('options.capture.aggressive.help')}</p>
        </div>
        <span className="nova-pill" data-tone={capture.aggressiveMode ? 'warning' : 'info'}>{capture.aggressiveMode ? t('options.capture.aggressive.active') : t('options.capture.aggressive.off')}</span>
      </div>
      <label className="nova-toggle">
        <input type="checkbox" checked={capture.aggressiveMode} onChange={(event) => event.currentTarget.checked ? void enableAggressive() : disableAggressive()} />
        <span><strong>{t('options.capture.aggressive.enable')}</strong><span>{t('options.capture.aggressive.enableHelp')}</span></span>
      </label>
        <div className="nova-toolbar">
        <button type="button" onClick={() => void requestAggressivePermissions()}>{t('options.capture.aggressive.requestPermissions')}</button>{/* Request aggressive all-sites permissions */}
        {/* <all_urls> */}
      </div>
      {notice ? <div role="status" className="nova-notice" data-kind="info">{notice}</div> : null}
    </div>
    <div className="nova-field-grid">
      {captureRowConfigs.map((row) => <label className="nova-toggle" key={row.key}>
        <input type="checkbox" checked={Boolean(capture[row.key])} onChange={(event) => patch({ [row.key]: event.currentTarget.checked } as Partial<Settings['capture']>)} />
        <span><strong>{t(row.tKey)}</strong><span>{t(row.tHelpKey)}</span></span>
      </label>)}
      <label className="nova-toggle">
        <span><strong>{t('options.capture.minFileSize')}</strong><span>{t('options.capture.minFileSizeHelp')}</span></span>
        <input type="number" min={0} value={capture.minFileSizeMB} onChange={(event) => patch({ minFileSizeMB: Number(event.currentTarget.value) })} />
      </label>
    </div>
  </section>;
}
export default CaptureSettings;
