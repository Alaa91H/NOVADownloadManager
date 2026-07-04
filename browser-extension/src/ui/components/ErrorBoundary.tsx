import React, { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode; fallback?: ReactNode; onError?: (error: Error, info: ErrorInfo) => void };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ADM:ErrorBoundary]', error.message, info.componentStack);
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div role="alert" style={{ padding: '16px', color: '#e74c3c', fontFamily: 'system-ui, sans-serif' }}>
          <strong>Something went wrong</strong>
          <p style={{ fontSize: '13px', marginTop: '8px', opacity: 0.8 }}>
            {this.state.error?.message ?? 'An unexpected error occurred.'}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
