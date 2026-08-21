import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { restoreSettingsFromDisk } from './store/settingsStore';
import { uiStore } from './store/uiStore';

async function bootstrapApplication() {
  if (window.__TAURI_INTERNALS__) {
    const { warnings, error } = await restoreSettingsFromDisk();
    if (error) {
      uiStore.getState().addToast('warning', 'Settings Recovery', error);
    }
    for (const warning of warnings) {
      uiStore.getState().addToast('warning', 'Settings Recovery', warning);
    }
  }

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrapApplication();
