import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import { AppStoreProvider } from './state/appStore';
import { AppShell } from './components/AppShell';

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return <div>Something went wrong. Please restart the application.</div>;
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppStoreProvider>
        <AppShell />
      </AppStoreProvider>
    </ErrorBoundary>
  );
}
