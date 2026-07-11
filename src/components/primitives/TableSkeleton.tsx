import React from 'react';

interface TableSkeletonProps {
  rows?: number;
  columns?: number;
  label?: string;
}

const barWidths = [60, 80, 45, 35, 55, 70, 40, 65];

export const TableSkeleton: React.FC<TableSkeletonProps> = ({ rows = 8, columns = 6, label }) => {
  return (
    <div className="flex flex-col items-center w-full gap-0">
      {label && (
        <p className="text-xs text-[var(--text-secondary)] mb-4 animate-pulse">{label}</p>
      )}
      <div className="w-full max-w-[800px]">
        {Array.from({ length: rows }).map((_, rowIdx) => (
          <div
            key={rowIdx}
            className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border-color)]/40"
          >
            <div className="w-3.5 h-3.5 rounded-sm bg-[var(--text-muted)]/15 shrink-0" />
            {Array.from({ length: columns }).map((_, colIdx) => (
              <div
                key={colIdx}
                className="h-2.5 rounded-full bg-[var(--text-muted)]/10 animate-pulse"
                style={{
                  width: `${String(barWidths[colIdx % barWidths.length])}%`,
                  animationDelay: `${String((rowIdx * columns + colIdx) * 40)}ms`,
                  maxWidth: `${String(colIdx === 0 ? 200 : 80)}px`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
