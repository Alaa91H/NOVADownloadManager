import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  title: string;
  description?: string;
  error?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title,
  description,
  error,
  onRetry,
  retryLabel,
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center py-12 px-6 text-center gap-3 ${className}`}>
      <div className="p-3 rounded-full bg-red-500/10">
        <AlertTriangle className="w-7 h-7 text-red-500 opacity-80" />
      </div>
      <h3 className="text-sm font-bold text-[var(--text-secondary)]">{title}</h3>
      {description && (
        <p className="text-[11px] text-[var(--text-muted)] max-w-xs leading-relaxed">{description}</p>
      )}
      {error && (
        <p className="text-[10px] text-red-400/80 max-w-sm font-mono break-all">{error}</p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] text-white rounded transition-all duration-150 hover:scale-[1.03] active:scale-[0.97] cursor-pointer flex items-center gap-1.5"
        >
          <RefreshCw className="w-3 h-3" />
          {retryLabel}
        </button>
      )}
    </div>
  );
};
