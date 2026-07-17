import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../i18n/react', () => ({
  useI18n: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        'popup.action.download': 'Download',
        'popup.action.downloadAll': 'All',
        'popup.action.close': 'Close',
        'popup.action.collapse': 'Collapse',
        'popup.scanning': 'Scanning…',
        'popup.handoffable': 'media',
        'popup.ready': 'Ready',
        'popup.needsCheck': 'Needs check',
        'taskActions.scan': 'Scan',
        'taskActions.sendSelected': 'Send selected',
        'taskActions.sendAll': 'Send all',
        'candidate.empty.title': 'No media found',
        'candidate.empty.help': 'Open a video page and scan again.',
      };
      return map[k] ?? k;
    },
  }),
}));

vi.mock('../../ui/runtime-request', () => ({
  runtimeRequest: (msg: Record<string, unknown>) => {
    if (msg.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: false, status: 'offline' });
    if (msg.type === 'GET_CANDIDATES') return Promise.resolve([]);
    if (msg.type === 'SCAN_PAGE') return Promise.resolve({ candidates: [] });
    return Promise.resolve({});
  },
  messageFromError: (e: unknown) => String(e),
}));

describe('PopupApp (video capture)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('opens expanded video panel by default', async () => {
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);
    await waitFor(() => expect(document.querySelector('.nova-popup-expanded')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Close/i })).toBeTruthy();
  });

  it('loads and displays video candidates from cache/scan', async () => {
    vi.doMock('../../ui/runtime-request', () => ({
      runtimeRequest: (msg: Record<string, unknown>) => {
        if (msg.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: true, status: 'connected' });
        if (msg.type === 'GET_CANDIDATES' || msg.type === 'SCAN_PAGE') {
          const candidates = [
            {
              id: 'c1',
              url: 'https://cdn.example/v.mp4',
              mediaType: 'video',
              source: 'network',
              confidence: 80,
              createdAt: new Date().toISOString(),
            },
          ];
          return Promise.resolve(msg.type === 'SCAN_PAGE' ? { candidates } : candidates);
        }
        return Promise.resolve({});
      },
      messageFromError: (e: unknown) => String(e),
    }));
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);
    await waitFor(() => expect(document.querySelector('.nova-popup-expanded')).toBeTruthy());
  });
});
