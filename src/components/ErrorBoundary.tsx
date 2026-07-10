import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { getTranslation } from '../lib/i18n/translations';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
  lang?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, info);
    this.props.onError?.(error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  tr = (key: string): string => {
    return getTranslation(this.props.lang || 'en', key);
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="flex flex-col items-center justify-center h-full w-full bg-[var(--bg-app)] text-[var(--text-primary)] gap-4 p-8">
          <AlertCircle className="w-12 h-12 text-red-500" />
          <h2 className="text-lg font-bold">{this.tr('shell_error_section_title')}</h2>
          <p className="text-sm text-[var(--text-secondary)] text-center max-w-md">
            {this.state.error?.message || this.tr('shell_error_occurred')}
          </p>
          <button
            onClick={this.handleRetry}
            className="mt-2 px-4 py-1.5 text-[11px] font-bold bg-[var(--accent-primary)] text-white rounded transition-all cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {this.tr('shell_error_section_retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
