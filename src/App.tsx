import React from 'react';
import { AppStoreProvider } from './state/appStore';
import { AppShell } from './components/AppShell';

export default function App() {
  return (
    <AppStoreProvider>
      <AppShell />
    </AppStoreProvider>
  );
}
