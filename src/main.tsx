import { listen } from '@tauri-apps/api/event';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { tauriClient, type TorrentOpenRequest } from './api/tauriClient';
import { restoreSettingsFromDisk } from './store/settingsStore';
import { uiStore } from './store/uiStore';
import { createTorrentSystemOpenQueue } from './utils/torrentSystemOpen';

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

const torrentSystemOpenQueue = createTorrentSystemOpenQueue(
  () => uiStore.getState().dialog.active !== null,
  openSystemTorrent,
);

uiStore.subscribe((state, previous) => {
  if (previous.dialog.active === 'torrentDownload' && state.dialog.active !== 'torrentDownload') {
    torrentSystemOpenQueue.releaseActive();
  }
  if (state.dialog.active === null) {
    torrentSystemOpenQueue.flush();
  }
});

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
        torrentSystemOpenQueue.enqueue(event.payload);
      });

      const pending = await tauriClient.takePendingTorrentOpens();
      torrentSystemOpenQueue.enqueueMany(pending);
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
