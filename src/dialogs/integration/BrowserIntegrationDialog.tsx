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

const EXTENSION_RELEASES_URL = 'https://github.com/Alaa91H/NovaDownloadManager/releases/latest';

export const BrowserIntegrationDialog: React.FC = () => {
  const { closeDialog, settings, updateSettings, addToast } = useAppStore();
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
      addToast('success', 'Browser Bridge', 'The local browser bridge is ready.');
    } catch (error) {
      addToast(
        'error',
        'Browser Bridge',
        error instanceof Error ? error.message : 'The local browser bridge is not reachable.',
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
      addToast('success', 'Pairing Token', 'The browser pairing token was copied.');
    } catch {
      addToast('warning', 'Pairing Token', 'Select the token manually if clipboard write is blocked.');
    }
  };

  const copyPath = async (path: string) => {
    try {
      await writeClipboardText(path);
      addToast('success', 'Extension Path', 'The extension folder path was copied.');
    } catch {
      addToast('warning', 'Extension Path', 'Select the path manually if clipboard write is blocked.');
    }
  };

  const openFolder = async () => {
    if (!extensionPaths) return;
    const opened = await tauriClient.openInExplorer(extensionPaths.devPath);
    if (!opened) {
      addToast('error', 'Extension Folder', 'NOVA could not open the browser extension folder.');
      return;
    }
    addToast('success', 'Extension Folder', 'The browser extension folder was opened.');
  };

  const openReleasesPage = async () => {
    try {
      await tauriClient.openExternalUrl(EXTENSION_RELEASES_URL);
      addToast('info', 'Browser Extension', 'Opened the NOVA releases page for extension downloads.');
    } catch (e) {
      addToast('error', 'Browser Extension', e instanceof Error ? e.message : 'Could not open the releases page.');
    }
  };

  const openBrowserPage = async (browser: 'chrome' | 'edge' | 'firefox') => {
    try {
      await tauriClient.openBrowserExtensions(browser);
      addToast(
        'info',
        'Browser Extension',
        `Opened ${browser === 'edge' ? 'Edge' : browser === 'firefox' ? 'Firefox' : 'Chrome'} extension management.`,
      );
    } catch (e) {
      addToast(
        'error',
        'Browser Extension',
        e instanceof Error ? e.message : `Could not open ${browser} extension page.`,
      );
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
            <h4 className="text-xs font-extrabold text-[var(--text-primary)]">Local Browser Bridge</h4>
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
          Test
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-surface)]/70 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
              <Monitor className="w-4 h-4 text-blue-400" />
              Chrome / Edge
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
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            Open the extensions page, enable developer mode, then load the unpacked NOVA Chromium or Edge folder.
          </p>
        </div>

        <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-surface)]/70 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
              <Globe2 className="w-4 h-4 text-orange-400" />
              Firefox
            </div>
            <Button onClick={() => void openBrowserPage('firefox')} variant="secondary" size="sm">
              Open
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            Open debugging extensions, load a temporary add-on, then select the manifest from the NOVA Firefox folder.
          </p>
        </div>
      </div>

      <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-hover)]/25 space-y-2">
        <div className="text-xs font-extrabold text-[var(--text-primary)]">Extension Downloads</div>
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          The browser extension packages are published as standalone files with every NOVA release: a Chrome/Chromium{' '}
          <code>.zip</code>, an Edge <code>.zip</code>, and a Firefox <code>.xpi</code>. Download the package for your
          browser, then load it from the extensions page.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => void openReleasesPage()} variant="primary" size="sm" icon={Download}>
            Download from GitHub Releases
          </Button>
          <Button onClick={() => void copyPath(EXTENSION_RELEASES_URL)} variant="secondary" size="sm" icon={Copy}>
            Copy Link
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button onClick={() => void openFolder()} variant="secondary" size="sm" icon={FolderOpen}>
            Open Dev Folder
          </Button>
          <Button onClick={() => void copyPath(devChromiumPath)} variant="secondary" size="sm" icon={Copy}>
            Copy Dev Chromium
          </Button>
          <Button onClick={() => void copyPath(devEdgePath)} variant="secondary" size="sm" icon={Copy}>
            Copy Dev Edge
          </Button>
          <Button onClick={() => void copyPath(devFirefoxPath)} variant="secondary" size="sm" icon={Copy}>
            Copy Dev Firefox
          </Button>
        </div>
      </div>

      <div className="border border-[var(--border-color)] rounded-lg p-3 bg-[var(--bg-hover)]/25 space-y-2">
        <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--text-primary)]">
          <KeyRound className="w-4 h-4 text-amber-400" />
          Pairing Token
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
            Copy
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
          {browsersEnabled ? 'Disable Browser Capture' : 'Enable Browser Capture'}
        </Button>
        <DialogButton onClick={closeDialog} variant="primary">
          Done
        </DialogButton>
      </div>
    </div>
  );
};
