import React, { Component, type ReactNode, type ErrorInfo } from 'react';
import { AppStoreProvider } from './state/appStore';
import { AppShell } from './components/AppShell';
import { EngineCapabilityProvider } from './capabilities/EngineCapabilityContext';
import { DetachedProgressWindow } from './dialogs/download/DetachedProgressWindow';
import { detachedMode, detachedTaskId } from './utils/windowMode';

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
  // Detached companion windows (e.g. a popped-out progress panel) reuse the
  // same providers so they stay wired to the live daemon connection.
  if (detachedMode() === 'progress') {
    return (
      <ErrorBoundary>
        <AppStoreProvider>
          <EngineCapabilityProvider>
            <DetachedProgressWindow taskId={detachedTaskId() ?? ''} />
          </EngineCapabilityProvider>
        </AppStoreProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppStoreProvider>
        <EngineCapabilityProvider>
          <AppShell />
        </EngineCapabilityProvider>
      </AppStoreProvider>
    </ErrorBoundary>
  );
}
