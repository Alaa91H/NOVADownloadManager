import React from 'react';
import { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon: Icon, title, description, action }) => {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-3">
      {Icon && (
        <div className="p-3 rounded-full bg-[var(--accent-primary)]/5">
          <Icon className="w-8 h-8 text-[var(--accent-primary)] opacity-60" />
        </div>
      )}
      <h3 className="text-sm font-bold text-[var(--text-secondary)]">{title}</h3>
      {description && (
        <p className="text-[11px] text-[var(--text-muted)] max-w-xs leading-relaxed">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-1 px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] text-white rounded transition-all duration-150 hover:scale-[1.03] active:scale-[0.97] cursor-pointer"
        >
          {action.label}
        </button>
      )}
    </div>
  );
};
