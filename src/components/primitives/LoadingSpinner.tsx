import React from 'react';
import { RefreshCw } from 'lucide-react';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}

const sizeMap = {
  sm: 'w-3.5 h-3.5',
  md: 'w-5 h-5',
  lg: 'w-8 h-8',
};

const containerClassMap = {
  sm: 'gap-1.5',
  md: 'gap-2',
  lg: 'gap-3',
};

const labelClassMap = {
  sm: 'text-[10px]',
  md: 'text-xs',
  lg: 'text-sm',
};

export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({ size = 'md', label, className = '' }) => {
  return (
    <div className={`flex flex-col items-center justify-center ${containerClassMap[size]} ${className}`}>
      <RefreshCw className={`${sizeMap[size]} animate-spin text-[var(--accent-primary)]`} />
      {label && (
        <p className={`${labelClassMap[size]} text-[var(--text-secondary)]`}>{label}</p>
      )}
    </div>
  );
};
