/* src/dialogs/integration/BrowserIntegrationDialog.tsx */
import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Monitor,
  Copy,
  Download,
  FolderOpen,
  Globe2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { novaClient, type BrowserExtensionHealth } from '../../api/novaClient';
import { tauriClient } from '../../api/tauriClient';
import { useAppStore } from '../../state/appStore';
import { writeClipboardText } from '../../utils/clipboard';
import { DialogButton, Button } from '../../components/primitives';
import { DegradedBanner } from '../../components/primitives/DegradedBanner';

const EXTENSION_RELEASES_URL = 'https://github.com/Alaa91H/NovaDownloadManager/releases/latest';

export const BrowserIntegrationDialog: React.FC = () => {
  const { closeDialog, settings, updateSettings, addToast, t, isDegradedMode } = useAppStore();
  const [health, setHealth] = useState<BrowserExtensionHealth | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [extensionPaths, setExtensionPaths] = useState<{ devPath: string; resourcePath: string } | null>(null);

  const browsersEnabled = Object.values(settings.general.integrateWithBrowsers).some(Boolean);

  useEffect(() => {
    let cancelled = false;
    void tauriClient.getBrowserExtensionPaths().then((paths) => {
      if (!cancelled) setExtensionPaths(paths);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const configureBridge = async (nextEnabled = browsersEnabled) => {
    setIsChecking(true);
    try {
      const result = await novaClient.configureBrowserExtension({
        enabled: nextEnabled,
        token: settings.extra.browserPairingToken,
        minSizeMb: settings.fileTypes.autoDownloadMaxSizeMb,
        defaultFolder: settings.saveAndCategories.defaultFolder,
        categoryFolders: settings.saveAndCategories.categoryFolders,
        userAgent: settings.extra.userAgent,
      });
      setHealth(result);
      addToast('success', t('brw_bridge_title'), t('brw_toast_bridge_ready'));
    } catch (error) {
      addToast(
        'error',
        t('brw_bridge_title'),
        error instanceof Error ? error.message : t('brw_toast_bridge_unreachable'),
      );
    } finally {
      setIsChecking(false);
    }
  };

  const setAllBrowsers = (enabled: boolean) => {
    updateSettings({
      ...settings,
      general: {
        ...settings.general,
        integrateWithBrowsers: {
          chrome: enabled,
          edge: enabled,
          firefox: enabled,
          safari: false,
        },
      },
    });
    void configureBridge(enabled);
  };

  const copyToken = async () => {
    try {
      await writeClipboardText(settings.extra.browserPairingToken);
      addToast('success', t('brw_pairing_token'), t('brw_toast_token_copied'));
    } catch {
      addToast('warning', t('brw_pairing_token'), t('brw_toast_token_manual'));
    }
  };

  const copyPath = async (path: string) => {
    try {
      await writeClipboardText(path);
      addToast('success', t('brw_extension_downloads'), t('brw_toast_path_copied'));
    } catch {
      addToast('warning', t('brw_extension_downloads'), t('brw_toast_path_manual'));
    }
  };

  const openFolder = async () => {
    if (!extensionPaths) return;
    const opened = await tauriClient.openInExplorer(extensionPaths.devPath);
    if (!opened) {
      addToast('error', t('brw_bridge_title'), t('brw_toast_folder_failed'));
      return;
    }
    addToast('success', t('brw_bridge_title'), t('brw_toast_folder_opened'));
  };

  const openReleasesPage = async () => {
    try {
      await tauriClient.openExternalUrl(EXTENSION_RELEASES_URL);
      addToast('info', t('brw_extension_downloads'), t('brw_toast_releases_opened'));
    } catch (e) {
      addToast('error', t('brw_extension_downloads'), e instanceof Error ? e.message : t('brw_toast_releases_opened'));
    }
  };

  const openBrowserPage = async (browser: 'chrome' | 'edge' | 'firefox') => {
    try {
      await tauriClient.openBrowserExtensions(browser);
      addToast(
        'info',
        t('brw_extension_downloads'),
        t('brw_toast_browser_opened').replace('{browser}', browser === 'edge' ? 'Edge' : browser === 'firefox' ? 'Firefox' : 'Chrome'),
      );
    } catch (e) {
      addToast(
        'error',
        t('brw_extension_downloads'),
        e instanceof Error ? e.message : t('brw_toast_browser_failed').replace('{browser}', browser),
      );
    }
  };

  const statusText = health
    ? `${health.enabled ? t('brw_status_enabled') : t('brw_status_disabled')} / ${health.paired ? t('brw_status_paired') : t('brw_status_token_required')}`
    : browsersEnabled
      ? t('brw_status_enabled_settings')
      : t('brw_status_disabled_settings');
  const devChromiumPath = extensionPaths ? `${extensionPaths.devPath}\\dist\\chromium` : '';
  const devEdgePath = extensionPaths ? `${extensionPaths.devPath}\\dist\\edge` : '';
  const devFirefoxPath = extensionPaths ? `${extensionPaths.devPath}\\dist\\firefox` : '';

  return (
    <div className="space-y-4 text-left text-ui" dir="ltr">
      {isDegradedMode && (
        <DegradedBanner title={t('dialog_degraded_title')} description={t('dialog_degraded_desc')} />
      )}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start border border-[var(--border-color)] rounded-lg bg-[var(--bg-hover)]/40 p-3">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-5 h-5 text-[var(--accent-primary)] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h4 className="text-xs font-extrabold text-[var(--text-primary)]">{t('brw_bridge_title')}</h4>
            <p className="text-[11px] text-[var(--text-secondary)] mt-1">{statusText}</p>
          </div>
        </div>
        <Button
          onClick={() => void configureBridge()}
          disabled={isChecking}
          variant="primary"
          size="sm"
          icon={isChecking ? RefreshCw : CheckCircle2}
        >
          {t('brw_btn_test')}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-surface)]/70 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
              <Monitor className="w-4 h-4 text-blue-400" />
              {t('brw_chrome_edge')}
            </div>
            <div className="flex gap-1.5">
              <Button onClick={() => void openBrowserPage('chrome')} variant="secondary" size="sm">
                {t('brw_chrome')}
              </Button>
              <Button onClick={() => void openBrowserPage('edge')} variant="secondary" size="sm">
                {t('brw_edge')}
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            {t('brw_chrome_desc')}
          </p>
        </div>

        <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-surface)]/70 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
              <Globe2 className="w-4 h-4 text-orange-400" />
              {t('brw_firefox')}
            </div>
            <Button onClick={() => void openBrowserPage('firefox')} variant="secondary" size="sm">
              {t('brw_btn_open')}
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            {t('brw_firefox_desc')}
          </p>
        </div>
      </div>

      <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-hover)]/25 space-y-2">
        <div className="text-xs font-extrabold text-[var(--text-primary)]">{t('brw_extension_downloads')}</div>
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {t('brw_extension_desc')}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => void openReleasesPage()} variant="primary" size="sm" icon={Download}>
            {t('brw_download_gh')}
          </Button>
          <Button onClick={() => void copyPath(EXTENSION_RELEASES_URL)} variant="secondary" size="sm" icon={Copy}>
            {t('brw_copy_link')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => void openFolder()} variant="secondary" size="sm" icon={FolderOpen}>
            {t('brw_open_dev_folder')}
          </Button>
          <Button onClick={() => void copyPath(devChromiumPath)} variant="secondary" size="sm" icon={Copy}>
            {t('brw_copy_dev_chromium')}
          </Button>
          <Button onClick={() => void copyPath(devEdgePath)} variant="secondary" size="sm" icon={Copy}>
            {t('brw_copy_dev_edge')}
          </Button>
          <Button onClick={() => void copyPath(devFirefoxPath)} variant="secondary" size="sm" icon={Copy}>
            {t('brw_copy_dev_firefox')}
          </Button>
        </div>
      </div>

      <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-hover)]/25 space-y-2">
        <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
          <KeyRound className="w-4 h-4 text-amber-400" />
          {t('brw_pairing_token')}
        </div>
        <div className="flex gap-2">
          <input
            value={settings.extra.browserPairingToken}
            readOnly
            className="min-w-0 flex-1 rounded bg-[var(--bg-input)] border border-[var(--border-color)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)]"
            style={{ direction: 'ltr' }}
          />
          <Button
            onClick={() => {
              void copyToken();
            }}
            variant="secondary"
            size="sm"
            icon={Copy}
          >
            {t('brw_copy')}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--border-color)]">
        <Button
          onClick={() => {
            setAllBrowsers(!browsersEnabled);
          }}
          variant={browsersEnabled ? 'danger' : 'primary'}
          size="sm"
        >
          {browsersEnabled ? t('brw_disable_capture') : t('brw_enable_capture')}
        </Button>
        <DialogButton onClick={closeDialog} variant="primary">
          {t('brw_done')}
        </DialogButton>
      </div>
    </div>
  );
};
