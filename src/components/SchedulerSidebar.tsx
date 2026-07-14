import React from 'react';
import { Folder, Calendar, Sliders, Bell, RefreshCw } from 'lucide-react';
import { useI18n } from '../store/selectors';

type TabId = 'files' | 'basic' | 'speed' | 'actions' | 'retries';

interface SchedulerSidebarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  fileCount: number;
}

const tabs: { id: TabId; icon: React.ElementType; labelKey: string }[] = [
  { id: 'files', icon: Folder, labelKey: 'sched_tab_files' },
  { id: 'basic', icon: Calendar, labelKey: 'sched_tab_schedule' },
  { id: 'speed', icon: Sliders, labelKey: 'sched_tab_speed' },
  { id: 'actions', icon: Bell, labelKey: 'sched_tab_actions' },
  { id: 'retries', icon: RefreshCw, labelKey: 'sched_tab_retries' },
];

export const SchedulerSidebar: React.FC<SchedulerSidebarProps> = ({ activeTab, onChange, fileCount }) => {
  const t = useI18n();

  return (
    <div className="w-52 shrink-0 border-r border-[var(--border-color)] pr-2 overflow-y-auto scrollbar-none select-none flex flex-col gap-1.5">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const label = tab.id === 'files' ? `${t(tab.labelKey)} (${String(fileCount)})` : t(tab.labelKey);
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              onChange(tab.id);
            }}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start transition-all duration-150 hover:scale-[1.02] active:scale-[0.98] ${
              activeTab === tab.id
                ? 'text-[var(--accent-primary)] bg-[var(--accent-primary)]/10 font-extrabold border-[var(--accent-border)] shadow-sm'
                : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-color-hover)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Icon className="w-4 h-4 shrink-0 text-[var(--accent-primary)]" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
};
