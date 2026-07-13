import React from 'react';
import { Sliders, FileText, Cpu, Film, Music, HelpCircle } from 'lucide-react';
import type { FileType } from '../types/desktop-ui.types';

export type SortColumn =
  | 'name'
  | 'sizeBytes'
  | 'dateAdded'
  | 'status'
  | 'progress'
  | 'speed'
  | 'timeLeft'
  | 'elapsed'
  | 'retries'
  | 'connections'
  | 'crc32'
  | 'priority'
  | 'completedDate'
  | 'sourceUrl'
  | 'smartCategory';

export const getSortField = (colKey: string): SortColumn => {
  switch (colKey) {
    case 'size':
      return 'sizeBytes';
    case 'date':
      return 'dateAdded';
    default:
      return colKey as SortColumn;
  }
};

export const getColAlign = (colKey: string) => {
  if (colKey === 'name' || colKey === 'sourceUrl') return 'text-left';
  return 'text-start';
};

export const getFileTypeIcon = (type: FileType, customSize?: string) => {
  const size = customSize || 'w-4 h-4';
  switch (type) {
    case 'compressed':
      return <Sliders className={`${size} text-[var(--warning)] shrink-0`} />;
    case 'program':
      return <Cpu className={`${size} text-[var(--success)] shrink-0`} />;
    case 'video':
      return <Film className={`${size} text-[var(--info)] shrink-0`} />;
    case 'audio':
      return <Music className={`${size} text-[var(--accent-primary)] shrink-0`} />;
    case 'document':
      return <FileText className={`${size} text-[var(--danger)] shrink-0`} />;
    default:
      return <HelpCircle className={`${size} text-[var(--text-secondary)] shrink-0`} />;
  }
};

export { formatSpeed, formatTimeLeft, formatElapsed } from './formatUtils';

export const renderSortIcon = (sortBy: SortColumn, sortOrder: 'asc' | 'desc', column: SortColumn) => {
  const isActive = sortBy === column;
  const isAsc = isActive && sortOrder === 'asc';
  const isDesc = isActive && sortOrder === 'desc';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-3 h-3 shrink-0 select-none ml-1 transition-all duration-150"
    >
      <g
        className={`transition-all duration-150 ${isAsc ? 'text-white opacity-100' : 'text-[var(--text-secondary)] opacity-35'}`}
        strokeWidth={isAsc ? 2.5 : 1.5}
      >
        <path d="m3 8 4-4 4 4" />
        <path d="M7 4v16" />
      </g>
      <g
        className={`transition-all duration-150 ${isDesc ? 'text-white opacity-100' : 'text-[var(--text-secondary)] opacity-35'}`}
        strokeWidth={isDesc ? 2.5 : 1.5}
      >
        <path d="m21 16-4 4-4-4" />
        <path d="M17 20V4" />
      </g>
    </svg>
  );
};
