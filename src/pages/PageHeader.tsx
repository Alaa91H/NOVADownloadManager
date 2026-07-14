/* src/pages/PageHeader.tsx */
import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { useNavigationActions, useI18n } from '../store/selectors';

interface PageHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

/**
 * Shared chrome for full-page views (Settings, Download Lists).
 * Renders a back button styled exactly like the download toolbar buttons.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ icon, title, subtitle, actions }) => {
  const { setActivePage } = useNavigationActions();
  const t = useI18n();

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[var(--border-color)] bg-[var(--bg-sidebar)] shrink-0 select-none">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={() => {
            setActivePage('downloads');
          }}
          className="toolbar-btn shrink-0"
          title={t('page_back_tip')}
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t('page_back')}</span>
        </button>

        <div className="h-5 w-px bg-[var(--border-color)] shrink-0" />

        <div className="flex items-center gap-2.5 min-w-0">
          {icon}
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold text-[var(--text-primary)] truncate leading-tight">{title}</h1>
            {subtitle && <p className="text-[10px] text-[var(--text-secondary)] truncate">{subtitle}</p>}
          </div>
        </div>
      </div>

      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
};
