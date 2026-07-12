import React from 'react';
import { WifiOff } from 'lucide-react';

interface DegradedBannerProps {
  title: string;
  description?: string;
}

export const DegradedBanner: React.FC<DegradedBannerProps> = ({ title, description }) => {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-[11px] text-amber-500">
      <WifiOff className="w-4 h-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold">{title}</span>
        {description && (
          <span className="ml-1.5 text-[var(--text-muted)]">{description}</span>
        )}
      </div>
    </div>
  );
};
