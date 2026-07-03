/* src/dialogs/settings/sections/BrowserAndIntegration.tsx */
import React, { useState } from 'react';
import { AppSettings } from '../../../types/desktop-ui.types';
import { FormRow, Switch, TextField } from '../../../components/primitives';
import { Puzzle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../../state/appStore';
import { novaClient } from '../../../api/novaClient';

interface Props {
  settings: AppSettings;
  updateSetting: (section: keyof AppSettings, key: string, value: any) => void;
  onAddToast: (type: 'success' | 'error' | 'info' | 'warning', title: string, msg: string) => void;
}

const generatePairingToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `nova_token_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const BrowserAndIntegration: React.FC<Props> = ({
  settings,
  updateSetting,
  onAddToast,
}) => {
  const { openDialog } = useAppStore();
  const [showPairingToken, setShowPairingToken] = useState(false);
  const [isPairing, setIsPairing] = useState(false);

  const handleRegenerateToken = () => {
    openDialog('genericConfirm', {
      message: 'Generate a new pairing token? Installed browser extensions will need to be paired again.',
      isDanger: true,
      onConfirm: () => {
        updateSetting('extra', 'browserPairingToken', generatePairingToken());
        onAddToast('success', 'New Pairing Token', 'The token was regenerated and previous extension pairings were revoked.');
      },
    });
  };

  const handleTestExtensionConnection = async () => {
    setIsPairing(true);
    try {
      const enabled = Object.values(settings.general.integrateWithBrowsers).some(Boolean);
      const health = await novaClient.configureBrowserExtension({
        enabled,
        token: settings.extra.browserPairingToken,
        minSizeMb: settings.fileTypes.autoDownloadMaxSizeMb,
        defaultFolder: settings.saveAndCategories.defaultFolder,
        categoryFolders: settings.saveAndCategories.categoryFolders,
        userAgent: settings.extra.userAgent,
      });
      onAddToast('success', 'Extension Bridge Ready', `Browser capture is ${health.enabled ? 'enabled' : 'disabled'} and the local bridge is reachable.`);
    } catch (error) {
      onAddToast('error', 'Extension Bridge Offline', error instanceof Error ? error.message : 'NOVA could not reach the local browser extension bridge.');
    } finally {
      setIsPairing(false);
    }
  };

  return (
    <div className="space-y-6 text-left animate-in fade-in duration-200">
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-[var(--border-color)] pb-2">
          <Puzzle className="w-4 h-4 text-indigo-500" />
          <h3 className="text-sm font-extrabold text-indigo-400">Browser Integration</h3>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">Extension Pairing</span>

          <FormRow label="Capture download links from browsers">
            <Switch
              checked={settings.general.integrateWithBrowsers.chrome}
              onChange={(v) => {
                const b = { ...settings.general.integrateWithBrowsers, chrome: v, edge: v, firefox: v };
                updateSetting('general', 'integrateWithBrowsers', b);
              }}
            />
          </FormRow>

          <div className="flex flex-col gap-1.5 pt-1.5">
            <label className="text-[11px] text-slate-400 font-bold">Secure Pairing Token</label>
            <div className="flex gap-2">
              <input
                type={showPairingToken ? 'text' : 'password'}
                value={settings.extra.browserPairingToken}
                readOnly
                className="flex-1 bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-3 py-1.5 text-xs font-mono text-left"
                style={{ direction: 'ltr' }}
              />
              <button type="button" onClick={() => setShowPairingToken(!showPairingToken)} className="px-2.5 bg-[var(--bg-hover)] hover:bg-[var(--border-color-hover)] text-slate-300 rounded border border-[var(--border-color)] cursor-pointer flex items-center justify-center" title="Show or hide token">
                {showPairingToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
              <button type="button" onClick={handleRegenerateToken} className="px-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded text-xs font-bold cursor-pointer">
                Generate New Token
              </button>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              This token protects local communication between browser extensions and the NOVA service. Do not share it.
            </p>
          </div>

          <div className="flex justify-end pt-2 border-t border-[var(--border-color)]/30">
            <button type="button" onClick={handleTestExtensionConnection} disabled={isPairing} className="px-3 py-1.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded text-xs font-bold hover:bg-indigo-500/20 transition-all cursor-pointer flex items-center gap-1.5">
              {isPairing && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Test Extension Connection
            </button>
          </div>
        </div>

        <div className="bg-[var(--bg-hover)]/30 p-3.5 rounded-lg border border-[var(--border-color)] space-y-3">
          <span className="text-[11px] font-extrabold text-[var(--text-secondary)] block border-b border-[var(--border-color)] pb-1">Capture Filters</span>

          <TextField
            label="Minimum size for automatic capture (MB)"
            type="number"
            value={settings.fileTypes.autoDownloadMaxSizeMb}
            onChange={(e) => updateSetting('fileTypes', 'autoDownloadMaxSizeMb', Number(e.target.value))}
            placeholder="128"
          />

          <div className="space-y-1">
            <label className="text-[11px] text-slate-400 font-bold block">Always Ignore Sites</label>
            <input
              type="text"
              defaultValue="google.com, github.com, microsoft.com"
              className="w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded p-2 text-xs font-mono text-left"
              style={{ direction: 'ltr' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
