import { listen } from '@tauri-apps/api/event';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { tauriClient, type TorrentOpenRequest } from './api/tauriClient';
import { restoreSettingsFromDisk } from './store/settingsStore';
import { uiStore } from './store/uiStore';

function openSystemTorrent(request: TorrentOpenRequest) {
  if (request.kind === 'magnet') {
    uiStore.getState().openDialog('torrentDownload', request.value);
    return;
  }

  uiStore.getState().openDialog('torrentDownload', {
    kind: 'file',
    path: request.value,
  });
}

async function bootstrapApplication() {
  if (window.__TAURI_INTERNALS__) {
    const { warnings, error } = await restoreSettingsFromDisk();
    if (error) {
      uiStore.getState().addToast('warning', 'Settings Recovery', error);
    }
    for (const warning of warnings) {
      uiStore.getState().addToast('warning', 'Settings Recovery', warning);
    }

    try {
      await listen<TorrentOpenRequest>('nova-torrent-open', (event) => {
        openSystemTorrent(event.payload);
      });

      const pending = await tauriClient.takePendingTorrentOpens();
      if (pending.length > 0) {
        openSystemTorrent(pending[0]);
        if (pending.length > 1) {
          uiStore
            .getState()
            .addToast(
              'info',
              'Torrent system open',
              `NOVA received ${String(pending.length)} torrent sources. The first source was opened; open the others again after finishing this dialog.`,
            );
        }
      }
    } catch (reason) {
      uiStore
        .getState()
        .addToast(
          'warning',
          'Torrent system integration',
          reason instanceof Error ? reason.message : 'NOVA could not initialize torrent system-open handling.',
        );
    }
  }

  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrapApplication();
