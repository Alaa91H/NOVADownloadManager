import React from 'react';

interface CardSkeletonProps {
  count?: number;
  label?: string;
}

export const CardSkeleton: React.FC<CardSkeletonProps> = ({ count = 4, label }) => {
  return (
    <div className="space-y-3">
      {label && (
        <p className="text-xs text-[var(--text-secondary)] mb-2 animate-pulse">{label}</p>
      )}
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="p-3 rounded-lg border border-[var(--border-color)]/40 bg-[var(--bg-card)] space-y-2.5"
        >
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-sm bg-[var(--text-muted)]/15 shrink-0" />
            <div
              className="h-2.5 rounded-full bg-[var(--text-muted)]/10 animate-pulse"
              style={{ width: `${String(50 + (idx % 3) * 15)}%`, animationDelay: `${String(idx * 80)}ms` }}
            />
          </div>
          <div className="flex gap-3">
            <div
              className="h-2 rounded-full bg-[var(--text-muted)]/10 animate-pulse"
              style={{ width: '25%', animationDelay: `${String(idx * 80 + 40)}ms` }}
            />
            <div
              className="h-2 rounded-full bg-[var(--text-muted)]/10 animate-pulse"
              style={{ width: '40%', animationDelay: `${String(idx * 80 + 80)}ms` }}
            />
          </div>
          <div className="h-1.5 rounded-full bg-[var(--text-muted)]/10 animate-pulse w-full" />
        </div>
      ))}
    </div>
  );
};
