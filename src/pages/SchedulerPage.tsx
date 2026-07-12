/* src/pages/SchedulerPage.tsx */
import React from 'react';
import { Clock } from 'lucide-react';
import { useAppStore } from '../state/appStore';
import { PageHeader } from './PageHeader';
import { SchedulerPanel } from '../components/SchedulerPanel';

/** Full-page Download Lists / Scheduler view (replaces the old floating dialog). */
export const SchedulerPage: React.FC = () => {
  const { t } = useAppStore();

  return (
    <div className="app-page flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--bg-app)]">
      <PageHeader
        icon={<Clock className="w-5 h-5 text-[var(--warning)] shrink-0" />}
        title={t('sched_title')}
        subtitle={t('sched_desc')}
      />
      <div className="flex-1 min-h-0 overflow-hidden px-4 pt-3 pb-2">
        <SchedulerPanel />
      </div>
    </div>
  );
};
