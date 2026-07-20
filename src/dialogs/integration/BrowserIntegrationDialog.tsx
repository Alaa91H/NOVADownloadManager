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
import { useDialogActions, useSettingsData, useSettingsActions, useToastActions, useI18n } from '../../store/selectors';
import { writeClipboardText } from '../../utils/clipboard';
import { DialogButton, Button } from '../../components/primitives';

const EXTENSION_RELEASES_URL = 'https://github.com/Alaa91H/NovaDownloadManager/releases/latest';

export const BrowserIntegrationDialog: React.FC = () => {
  const { closeDialog } = useDialogActions();
  const settings = useSettingsData();
  const { updateSettings } = useSettingsActions();
  const { addToast } = useToastActions();
  const t = useI18n();
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
      addToast('success', t('browser_bridge_title'), t('browser_bridge_ready'));
    } catch (error) {
      addToast('error', t('browser_bridge_title'), error instanceof Error ? error.message : t('browser_bridge_error'));
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
      addToast('success', t('toast_success_title'), t('browser_pairing_copied'));
    } catch {
      addToast('warning', t('toast_warning_title'), t('browser_pairing_warning'));
    }
  };

  const copyPath = async (path: string) => {
    try {
      await writeClipboardText(path);
      addToast('success', t('toast_success_title'), t('browser_ext_path_copied'));
    } catch {
      addToast('warning', t('toast_warning_title'), t('browser_ext_path_warning'));
    }
  };

  const openFolder = async () => {
    if (!extensionPaths) return;
    const opened = await tauriClient.openInExplorer(extensionPaths.devPath);
    if (!opened) {
      addToast('error', t('toast_error_title'), t('browser_ext_folder_error'));
      return;
    }
    addToast('success', t('toast_success_title'), t('browser_ext_folder_opened'));
  };

  const openReleasesPage = async () => {
    try {
      await tauriClient.openExternalUrl(EXTENSION_RELEASES_URL);
      addToast('info', t('toast_info_title'), t('browser_releases_opened'));
    } catch (e) {
      addToast('error', t('toast_error_title'), e instanceof Error ? e.message : t('browser_releases_error'));
    }
  };

  const openBrowserPage = async (browser: 'chrome' | 'edge' | 'firefox') => {
    try {
      await tauriClient.openBrowserExtensions(browser);
      addToast('info', t('toast_info_title'), t('browser_ext_page_opened'));
    } catch (e) {
      addToast('error', t('toast_error_title'), e instanceof Error ? e.message : t('browser_ext_page_error'));
    }
  };

  const statusText = health
    ? `${health.enabled ? 'Enabled' : 'Disabled'} / ${health.paired ? 'Paired' : 'Token required'}`
    : browsersEnabled
      ? 'Enabled in settings'
      : 'Disabled in settings';
  const devChromiumPath = extensionPaths ? `${extensionPaths.devPath}\\dist\\chromium` : '';
  const devEdgePath = extensionPaths ? `${extensionPaths.devPath}\\dist\\edge` : '';
  const devFirefoxPath = extensionPaths ? `${extensionPaths.devPath}\\dist\\firefox` : '';

  return (
    <div className="space-y-4 text-left text-ui" dir="ltr">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start border border-[var(--border-color)] rounded-lg bg-[var(--bg-hover)]/40 p-3">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="w-5 h-5 text-[var(--accent-primary)] shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h4 className="text-xs font-extrabold text-[var(--text-primary)]">{t('browser_bridge_title')}</h4>
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
          {t('browser_test')}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-surface)]/70 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
              <Monitor className="w-4 h-4 text-[var(--info)]" />
              {t('browser_chrome_edge')}
            </div>
            <div className="flex gap-1.5">
              <Button onClick={() => void openBrowserPage('chrome')} variant="secondary" size="sm">
                Chrome
              </Button>
              <Button onClick={() => void openBrowserPage('edge')} variant="secondary" size="sm">
                Edge
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{t('browser_chrome_edge_desc')}</p>
        </div>

        <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-surface)]/70 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
              <Globe2 className="w-4 h-4 text-[var(--warning)]" />
              {t('browser_firefox')}
            </div>
            <Button onClick={() => void openBrowserPage('firefox')} variant="secondary" size="sm">
              {t('browser_open')}
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{t('browser_firefox_desc')}</p>
        </div>
      </div>

      <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-hover)]/25 space-y-2">
        <div className="text-xs font-extrabold text-[var(--text-primary)]">{t('browser_extension_downloads')}</div>
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{t('browser_extension_desc')}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => void openReleasesPage()} variant="primary" size="sm" icon={Download}>
            {t('browser_download_github')}
          </Button>
          <Button onClick={() => void copyPath(EXTENSION_RELEASES_URL)} variant="secondary" size="sm" icon={Copy}>
            {t('browser_copy_link')}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => void openFolder()} variant="secondary" size="sm" icon={FolderOpen}>
            {t('browser_open_dev_folder')}
          </Button>
          <Button onClick={() => void copyPath(devChromiumPath)} variant="secondary" size="sm" icon={Copy}>
            {t('browser_copy_dev_chromium')}
          </Button>
          <Button onClick={() => void copyPath(devEdgePath)} variant="secondary" size="sm" icon={Copy}>
            {t('browser_copy_dev_edge')}
          </Button>
          <Button onClick={() => void copyPath(devFirefoxPath)} variant="secondary" size="sm" icon={Copy}>
            {t('browser_copy_dev_firefox')}
          </Button>
        </div>
      </div>

      <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-hover)]/25 space-y-2">
        <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
          <KeyRound className="w-4 h-4 text-[var(--warning)]" />
          {t('browser_pairing_token')}
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
            {t('browser_copy')}
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
          {browsersEnabled ? t('browser_disable_capture') : t('browser_enable_capture')}
        </Button>
        <DialogButton onClick={closeDialog} variant="primary">
          {t('browser_done')}
        </DialogButton>
      </div>
    </div>
  );
};
