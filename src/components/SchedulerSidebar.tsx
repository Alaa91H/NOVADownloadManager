import React from 'react';
import { Folder, Calendar, Sliders, Bell, RefreshCw } from 'lucide-react';

type TabId = 'files' | 'basic' | 'speed' | 'actions' | 'retries';

interface SchedulerSidebarProps {
  activeTab: TabId;
  onChange: (tab: TabId) => void;
  fileCount: number;
}

const tabs: { id: TabId; icon: React.ElementType; label: string; count?: number }[] = [
  { id: 'files', icon: Folder, label: 'List Files', count: 0 },
  { id: 'basic', icon: Calendar, label: 'Schedule' },
  { id: 'speed', icon: Sliders, label: 'Speed Limiter' },
  { id: 'actions', icon: Bell, label: 'Post Actions' },
  { id: 'retries', icon: RefreshCw, label: 'Retries & Connection' },
];

export const SchedulerSidebar: React.FC<SchedulerSidebarProps> = ({ activeTab, onChange, fileCount }) => {
  return (
    <div className="w-52 shrink-0 border-r border-[var(--border-color)] pr-2 overflow-y-auto scrollbar-none select-none flex flex-col gap-1">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const label = tab.id === 'files' ? `List Files (${String(fileCount)})` : tab.label;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              onChange(tab.id);
            }}
            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer border shrink-0 text-xs font-bold w-full text-left justify-start ${
              activeTab === tab.id
                ? 'border-transparent text-white bg-[var(--accent-primary)]/10 font-extrabold shadow-sm'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-[var(--bg-hover)]/40 bg-transparent'
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
