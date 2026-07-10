import React from 'react';
import { AppStoreProvider } from './state/appStore';
import { AppShell } from './components/AppShell';
import { EngineCapabilityProvider } from './capabilities/EngineCapabilityContext';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
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
