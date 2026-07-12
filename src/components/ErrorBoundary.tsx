import React from 'react';
import { AlertCircle } from 'lucide-react';
import { getTranslation } from '../lib/i18n/translations';
import { ErrorState } from './primitives/ErrorState';

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
        <div className="flex items-center justify-center h-full w-full bg-[var(--bg-app)] p-4">
          <ErrorState
            icon={AlertCircle}
            title={this.tr('shell_error_section_title')}
            description={this.state.error?.message || this.tr('shell_error_occurred')}
            action={{
              label: this.tr('shell_error_section_retry'),
              onClick: this.handleRetry,
            }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
