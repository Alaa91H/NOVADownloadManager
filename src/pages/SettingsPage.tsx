/* src/pages/SettingsPage.tsx */
import React from 'react';
import { Settings, WifiOff } from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { PageHeader } from './PageHeader';
import { SettingsDialog } from '../dialogs/settings/SettingsDialog';

/** Full-page Settings view (replaces the old floating settings dialog). */
export const SettingsPage: React.FC = () => {
  const { t, isDegradedMode } = useAppStore();

  return (
    <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]">
      <PageHeader
        icon={<Settings className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />}
        title={t('set_control_center_title')}
        subtitle={t('set_control_center_desc')}
      />
      {isDegradedMode && (
        <div className="mx-4 mb-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <WifiOff className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-amber-300">{t('settings_degraded_title')}</p>
            <p className="text-[10px] text-amber-400/70">{t('settings_degraded_desc')}</p>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden px-4 pt-3 pb-2">
        <SettingsDialog />
      </div>
    </div>
  );
};
