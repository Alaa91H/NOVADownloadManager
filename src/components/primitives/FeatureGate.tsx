import React from 'react';
import { Lock } from 'lucide-react';
import { useToolCapability } from '../../hooks/useToolCapability';

interface FeatureGateProps {
  capabilityId: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  showTooltip?: boolean;
}

export const FeatureGate: React.FC<FeatureGateProps> = ({
  capabilityId,
  children,
  fallback,
  showTooltip = true,
}) => {
  const { available, requiresMessage, loading } = useToolCapability(capabilityId);

  if (loading) {
    return <>{children}</>;
  }

  if (available) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return (
    <div className="relative group">
      <div className="opacity-50 pointer-events-none">{children}</div>
      {showTooltip && requiresMessage && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-1 px-2 py-1 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg shadow-lg text-[10px] text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
            <Lock className="w-3 h-3 text-amber-400" />
            <span>{requiresMessage}</span>
          </div>
        </div>
      )}
      {showTooltip && !requiresMessage && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-1 px-2 py-1 bg-[var(--bg-card)] border border-[var(--border-color)] rounded-lg shadow-lg text-[10px] text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 transition-opacity">
            <Lock className="w-3 h-3 text-amber-400" />
            <span>Requires external tool</span>
          </div>
        </div>
      )}
    </div>
  );
};
