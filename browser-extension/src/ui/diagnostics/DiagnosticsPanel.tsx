import React from 'react';
import { BridgeState } from '../../core/app-state';
import { useI18n } from '../../i18n/react';
import AppLogo from '../components/AppLogo';
import BridgeStatus from './BridgeStatus';
import CopyDiagnostics from './CopyDiagnostics';
import PermissionStatus from './PermissionStatus';

export type DiagnosticsModel = {
  extension?: { name?: string; version?: string; manifestVersion?: number; buildTarget?: string };
  browser?: Record<string, unknown>;
  bridge?: BridgeState;
  outbox?: Record<string, number>;
  nativeAvailable?: boolean;
  daemonReachable?: boolean;
  auth?: { present?: boolean; expired?: boolean; expiresAt?: string; storageFormat?: string };
  permissions?: Record<
    string,
    boolean | { granted: boolean; reason?: string; degradedFeature?: string }
  >;
  activeSiteRules?: number;
  overlay?: {
    enabled?: boolean;
    preset?: string;
    defaultPosition?: string;
    positionScope?: string;
    openDirection?: string;
    showOnlyWhenCandidates?: boolean;
    hideWhenFiltersRejectAll?: boolean;
    minConfidence?: number;
    minFileSizeMB?: number;
    maxFileSizeMB?: number;
    mediaTypes?: string[];
    extensionAllowlistCount?: number;
    extensionBlocklistCount?: number;
    savedPositions?: Record<string, unknown>;
    runtime?: {
      lastScan?: {
        lastScanAt?: string;
        scanProfile?: string;
        totalCandidates?: number;
        visibleCandidates?: number;
        overlayFilteredOut?: number;
        nonHandoffable?: number;
        clipped?: number;
        filterReasons?: Record<string, number>;
      };
      lastSend?: {
        sentAt?: string;
        requested?: number;
        sent?: number;
        failed?: boolean;
        reason?: string;
      };
      client?: {
        state?: string;
        hiddenReason?: string;
        placement?: string;
        alignment?: string;
        pickerItems?: number;
        pickerSelected?: number;
        updatedAt?: string;
      };
    };
  };
  storageMigration?: { schemaVersion?: number; migratedAt?: string };
  securityPolicy?: Record<string, unknown>;
  generatedAt?: string;
};

export function DiagnosticsPanel({
  diagnostics,
  onRefresh,
  loading,
}: {
  diagnostics?: DiagnosticsModel;
  onRefresh?: () => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const outbox = diagnostics?.outbox ?? {};
  const caps = diagnostics?.bridge?.capabilities;
  const engineCaps = caps?.engineCapabilities;
  const capItems = caps?.items ?? [];
  const directOptions = caps?.directOptionKeys ?? [];
  const mediaOptions = caps?.mediaOptionKeys ?? [];
  return (
    <main className="adm-page">
      <div className="adm-page-shell">
        <header className="adm-topbar">
          <div className="adm-brand">
            <AppLogo />
            <div>
              <h1 className="adm-title">{t('diagnostics.title')}</h1>
              <p className="adm-subtitle">{t('diagnostics.subtitle')}</p>
            </div>
          </div>
          <div className="adm-actions-row">
            <CopyDiagnostics diagnostics={diagnostics ?? {}} />
            <button onClick={() => (onRefresh ? onRefresh() : location.reload())}>
              {loading ? t('diagnostics.refreshing') : t('diagnostics.refresh')}
            </button>
          </div>
        </header>
        {loading ? (
          <div className="adm-notice" data-kind="info">
            {t('diagnostics.loading')}
          </div>
        ) : null}
        <div className="adm-diagnostics-grid">
          <section className="adm-section">
            <h2>{t('diagnostics.extension')}</h2>
            <dl>
              <dt>{t('diagnostics.name')}</dt>
              <dd>{diagnostics?.extension?.name ?? t('general.unknown')}</dd>
              <dt>{t('diagnostics.version')}</dt>
              <dd>{diagnostics?.extension?.version ?? t('general.unknown')}</dd>
              <dt>{t('diagnostics.manifest')}</dt>
              <dd>MV{diagnostics?.extension?.manifestVersion ?? t('general.unknown')}</dd>
              <dt>{t('diagnostics.buildTarget')}</dt>{/* Build target */}
              <dd>{diagnostics?.extension?.buildTarget ?? t('general.unknown')}</dd>
              <dt>{t('diagnostics.generated')}</dt>
              <dd>{diagnostics?.generatedAt ?? t('general.unknown')}</dd>
            </dl>
          </section>
          <section className="adm-section">
            <h2>{t('diagnostics.connectivity')}</h2>{/* Connectivity */}
            <div className="adm-grid adm-grid-2">
              <Metric
                label={t('diagnostics.nativeHost')}
                value={diagnostics?.nativeAvailable ? t('diagnostics.available') : t('diagnostics.missing')}
                tone={diagnostics?.nativeAvailable ? 'success' : 'warning'}
              />
              <Metric
                label={t('diagnostics.daemon')}
                value={diagnostics?.daemonReachable ? t('diagnostics.reachable') : 'Unavailable'}
                tone={diagnostics?.daemonReachable ? 'success' : 'danger'}
              />
              <Metric label={t('diagnostics.rules')} value={String(diagnostics?.activeSiteRules ?? 0)} />
              <Metric
                label={t('diagnostics.storageSchema')}
                value={String(diagnostics?.storageMigration?.schemaVersion ?? t('general.unknown'))}
              />
            </div>
          </section>
          <BridgeStatus state={diagnostics?.bridge} />
          <section className="adm-section">
            <h2>Runtime engine capabilities</h2>
            <div className="adm-grid adm-grid-3">
              <Metric label="Capability items" value={String(capItems.length)} tone={capItems.length ? 'success' : 'warning'} />
              <Metric label="Direct options" value={String(directOptions.length)} tone={directOptions.length ? 'success' : 'warning'} />
              <Metric label="Media options" value={String(mediaOptions.length)} tone={mediaOptions.length ? 'success' : 'warning'} />
            </div>
            <p className="adm-help">Direct engine: libcurl multi. Torrent/magnet is intentionally unsupported unless the daemon advertises a dedicated torrent capability.</p>
            <details className="adm-explain-details">
              <summary>Capability matrix</summary>
              <pre className="adm-explain-pre">{JSON.stringify({ items: capItems, directOptions, mediaOptions, engineCapabilities: engineCaps }, null, 2)}</pre>
            </details>
          </section>
          <section className="adm-section">
            <h2>{t('diagnostics.floatingOverlay')}</h2>{/* <h2>Floating overlay</h2> */}
            <div className="adm-grid adm-grid-3">
              <Metric
                label={t('diagnostics.enabled')}
                value={diagnostics?.overlay?.enabled ? t('diagnostics.yes') : t('diagnostics.no')}
                tone={diagnostics?.overlay?.enabled ? 'success' : 'warning'}
              />
              <Metric label={t('diagnostics.preset')} value={diagnostics?.overlay?.preset ?? t('general.unknown')} />
              <Metric
                label={t('diagnostics.position')}
                value={`${diagnostics?.overlay?.defaultPosition ?? t('general.unknown')} / ${diagnostics?.overlay?.positionScope ?? 'global'}`}
              />
              <Metric label={t('diagnostics.menu')} value={diagnostics?.overlay?.openDirection ?? t('general.unknown')} />
              <Metric
                label={t('diagnostics.minConfidence')}
                value={String(diagnostics?.overlay?.minConfidence ?? t('general.unknown'))}
              />
              <Metric
                label={t('diagnostics.savedPositions')}
                value={String(diagnostics?.overlay?.savedPositions?.totalPositions ?? 0)}
              />
              {/* Last scan total */}
              <Metric
                label={t('diagnostics.lastScanTotal')}
                value={String(diagnostics?.overlay?.runtime?.lastScan?.totalCandidates ?? t('general.none'))}
              />
              <Metric
                label={t('diagnostics.lastScanShown')}
                value={String(diagnostics?.overlay?.runtime?.lastScan?.visibleCandidates ?? t('general.none'))}
              />
              <Metric
                label={t('diagnostics.filteredOut')}
                value={String(
                  diagnostics?.overlay?.runtime?.lastScan?.overlayFilteredOut ?? t('general.none'),
                )}
              />
              {/* Non-handoffable */}
              <Metric
                label={t('diagnostics.nonHandoffable')}
                value={String(diagnostics?.overlay?.runtime?.lastScan?.nonHandoffable ?? t('general.none'))}
              />
              <Metric
                label={t('diagnostics.lastSend')}
                value={
                  diagnostics?.overlay?.runtime?.lastSend
                    ? `${diagnostics.overlay.runtime.lastSend.sent ?? 0}/${diagnostics.overlay.runtime.lastSend.requested ?? 0}`
                    : t('general.none')
                }
                tone={diagnostics?.overlay?.runtime?.lastSend?.failed ? 'danger' : undefined}
              />
              {/* Client state */}
              <Metric
                label={t('diagnostics.clientState')}
                value={diagnostics?.overlay?.runtime?.client?.state ?? t('general.none')}
              />
              {/* Client placement */}
              <Metric
                label={t('diagnostics.clientPlacement')}
                value={`${diagnostics?.overlay?.runtime?.client?.placement ?? t('general.none')} / ${diagnostics?.overlay?.runtime?.client?.alignment ?? t('general.none')}`}
              />
              {/* Picker client */}
              <Metric
                label={t('diagnostics.pickerClient')}
                value={
                  typeof diagnostics?.overlay?.runtime?.client?.pickerItems === 'number'
                    ? `${diagnostics.overlay.runtime.client.pickerSelected ?? 0}/${diagnostics.overlay.runtime.client.pickerItems}`
                    : t('general.none')
                }
              />
            </div>
            <p className="adm-help">
              {t('diagnostics.filters') + ': '}{diagnostics?.overlay?.mediaTypes?.join(', ') ?? t('general.unknown')} · {t('diagnostics.allowlist')}{' '}
              {diagnostics?.overlay?.extensionAllowlistCount ?? 0} · {t('diagnostics.blocklist')}{' '}
              {diagnostics?.overlay?.extensionBlocklistCount ?? 0}
            </p>
            <p className="adm-help">
              {t('diagnostics.lastScan') + ': '}{diagnostics?.overlay?.runtime?.lastScan?.lastScanAt ?? t('general.none')} · {t('diagnostics.reasons')}{' '}
              {JSON.stringify(diagnostics?.overlay?.runtime?.lastScan?.filterReasons ?? {})}
            </p>
            <p className="adm-help">
              {t('diagnostics.clientRuntime') + ': '}{/* Client runtime */}{diagnostics?.overlay?.runtime?.client?.updatedAt ?? t('general.none')} · {t('diagnostics.hiddenReason')}{' '}
              {diagnostics?.overlay?.runtime?.client?.hiddenReason ?? t('general.none')}
            </p>
          </section>
          <section className="adm-section">
            <h2>{t('diagnostics.auth')}</h2>
            <dl>
              <dt>{t('diagnostics.token')}</dt>{/* Token: */}
              <dd>{diagnostics?.auth?.present ? t('diagnostics.stored') : t('diagnostics.missing')}</dd>
              <dt>{t('diagnostics.expired')}</dt>
              <dd>{diagnostics?.auth?.expired ? t('diagnostics.yes') : t('diagnostics.no')}</dd>
              <dt>{t('diagnostics.format')}</dt>
              <dd>{diagnostics?.auth?.storageFormat ?? t('general.unknown')}</dd>
              <dt>{t('diagnostics.expires')}</dt>
              <dd>{diagnostics?.auth?.expiresAt ?? t('general.unknown')}</dd>
            </dl>
          </section>
          <section className="adm-section">
            <h2>{t('diagnostics.storage')}</h2>{/* <h2>Storage</h2> */}
            <p>
              {t('diagnostics.schema') + ': '}{diagnostics?.storageMigration?.schemaVersion ?? t('general.unknown')} · {t('diagnostics.lastMigration') + ': '}
              {diagnostics?.storageMigration?.migratedAt ?? t('general.unknown')}
            </p>
          </section>
          <section className="adm-section">
            <h2>{t('diagnostics.outbox')}</h2>
            <div className="adm-grid adm-grid-3">
              {Object.entries(outbox)
                .slice(0, 9)
                .map(([key, value]) => (
                  <Metric key={key} label={key} value={String(value)} />
                ))}
            </div>
          </section>
          <PermissionStatus permissions={diagnostics?.permissions} />
          <section className="adm-section adm-raw-block">
            <h2>{t('diagnostics.browser')}</h2>{/* Browser */}
            <pre>{JSON.stringify(diagnostics?.browser ?? {}, null, 2)}</pre>
          </section>
          <section className="adm-section adm-raw-block">
            <h2>{t('diagnostics.securityPolicy')}</h2>{/* <h2>Security policy</h2> */}
            <pre>{JSON.stringify(diagnostics?.securityPolicy ?? {}, null, 2)}</pre>
          </section>
          <section className="adm-section adm-raw-block">
            <h2>{t('diagnostics.raw')}</h2>{/* Raw diagnostics */}
            <pre>{JSON.stringify(diagnostics ?? {}, null, 2)}</pre>
          </section>
        </div>
      </div>
    </main>
  );
}

const Metric: React.FC<{
  label: string;
  value: string;
  tone?: 'success' | 'warning' | 'danger' | 'info';
}> = ({ label, value, tone }) => {
  return (
    <div className="adm-metric">
      <span className="adm-metric-value">{value}</span>
      <span className="adm-metric-label">
        {label}
        {tone ? ` · ${tone}` : ''}
      </span>
    </div>
  );
};
export default DiagnosticsPanel;
