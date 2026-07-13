/* src/pages/SettingsPage.tsx */
import React from 'react';
import { Settings } from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { PageHeader } from './PageHeader';
import { SettingsDialog } from '../dialogs/settings/SettingsDialog';
import { DegradedBanner } from '../components/primitives/DegradedBanner';
import { LoadingSpinner } from '../components/primitives/LoadingSpinner';

/** Full-page Settings view (replaces the old floating settings dialog). */
export const SettingsPage: React.FC = () => {
  const { t, isDegradedMode, isLoading } = useAppStore();

  if (isLoading) {
    return (
      <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]">
        <PageHeader
          icon={<Settings className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />}
          title={t('set_control_center_title')}
          subtitle={t('set_control_center_desc')}
        />
        <div className="flex-1 flex items-center justify-center">
          <LoadingSpinner size="lg" label={t('settings_loading')} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]">
      <PageHeader
        icon={<Settings className="w-5 h-5 text-[var(--accent-primary)] shrink-0" />}
        title={t('set_control_center_title')}
        subtitle={t('set_control_center_desc')}
      />
      {isDegradedMode && (
        <div className="mx-4 mb-2">
          <DegradedBanner title={t('settings_degraded_title')} description={t('settings_degraded_desc')} />
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden px-4 pt-3 pb-2">
        <SettingsDialog />
      </div>
    </div>
  );
};
