import React from 'react';
import { LucideIcon, AlertTriangle } from 'lucide-react';

interface ErrorStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  errorMessage?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  icon: Icon = AlertTriangle,
  title,
  description,
  errorMessage,
  action,
}) => {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-3">
      <div className="p-3 rounded-full bg-red-500/10">
        <Icon className="w-8 h-8 text-red-400 opacity-80" />
      </div>
      <h3 className="text-sm font-bold text-[var(--text-secondary)]">{title}</h3>
      {description && (
        <p className="text-[11px] text-[var(--text-muted)] max-w-xs leading-relaxed">{description}</p>
      )}
      {errorMessage && (
        <p className="text-[10px] text-red-400/70 max-w-xs leading-relaxed font-mono">{errorMessage}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-1 px-4 py-1.5 text-[11px] font-bold bg-red-500/80 text-white rounded transition-all duration-150 hover:bg-red-500 hover:scale-[1.03] active:scale-[0.97] cursor-pointer"
        >
          {action.label}
        </button>
      )}
    </div>
  );
};
