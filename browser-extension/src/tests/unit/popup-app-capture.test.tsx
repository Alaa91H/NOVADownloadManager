import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMock = vi.hoisted(() => {
  const state = {
    canSend: false as boolean,
    status: 'offline' as string,
    scanCandidates: [] as Array<{
      id: string;
      url: string;
      mediaType: string;
      source?: string;
      confidence?: number;
      createdAt?: string;
    }>,
    cacheCandidates: [] as Array<{
      id: string;
      url: string;
      mediaType: string;
      source?: string;
      confidence?: number;
      createdAt?: string;
    }>,
    scanCalls: 0,
  };
  return {
    state,
    runtimeRequest: vi.fn(async (msg: Record<string, unknown>) => {
      if (msg.type === 'GET_BRIDGE_STATE') {
        return { canSend: state.canSend, status: state.status };
      }
      if (msg.type === 'GET_CANDIDATES') return state.cacheCandidates;
      if (msg.type === 'SCAN_PAGE') {
        state.scanCalls += 1;
        return { candidates: state.scanCandidates };
      }
      return {};
    }),
    messageFromError: (e: unknown) => String(e),
  };
});

vi.mock('../../i18n/react', () => ({
  useI18n: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        'popup.action.download': 'Download',
        'popup.action.downloadAll': 'All',
        'popup.action.close': 'Close',
        'popup.action.collapse': 'Collapse',
        'popup.scanning': 'Scanning…',
        'candidate.empty.title': 'No media found',
        'candidate.empty.help': 'Open a video page and scan again.',
        'taskActions.scan': 'Scan',
        'taskActions.sendSelected': 'Send selected',
        'taskActions.sendAll': 'Send all',
        'popup.handoffable': 'media',
        'popup.ready': 'Ready',
        'popup.needsCheck': 'Needs check',
        'popup.scanFound': 'Found items',
        'popup.scanNone': 'None found',
        'popup.sentResult': 'Sent',
        'popup.sending': 'Sending',
        'popup.noCandidates': 'No candidates',
        'popup.noSelected': 'None selected',
        'popup.action.linkNova': 'Link NOVA',
      };
      return map[k] ?? k;
    },
  }),
}));

vi.mock('../../ui/runtime-request', () => ({
  runtimeRequest: runtimeMock.runtimeRequest,
  messageFromError: runtimeMock.messageFromError,
}));

describe('PopupApp video capture popup', () => {
  beforeEach(() => {
    cleanup();
    runtimeMock.state.canSend = false;
    runtimeMock.state.status = 'offline';
    runtimeMock.state.scanCandidates = [];
    runtimeMock.state.cacheCandidates = [];
    runtimeMock.state.scanCalls = 0;
    runtimeMock.runtimeRequest.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens expanded video panel by default', async () => {
    const { default: PopupApp } = await import('../../ui/popup/PopupApp');
    render(<PopupApp />);
    await waitFor(() => expect(document.querySelector('.nova-popup-expanded')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Close/i })).toBeTruthy();
  });

  it('auto-scans and shows captured videos on open', async () => {
    runtimeMock.state.canSend = true;
    runtimeMock.state.status = 'connected';
    runtimeMock.state.scanCandidates = [
      {
        id: 'c1',
        url: 'https://cdn.example/v.mp4',
        mediaType: 'video',
        source: 'network',
        confidence: 80,
        createdAt: new Date().toISOString(),
      },
    ];

    const { default: PopupApp } = await import('../../ui/popup/PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(runtimeMock.state.scanCalls).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelector('.nova-popup-expanded')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('.nova-mini-count-badge')?.textContent).toBe('1'));
  });

  it('loads candidates from cache before scan completes', async () => {
    runtimeMock.state.cacheCandidates = [
      {
        id: 'cached',
        url: 'https://cdn.example/cached.mp4',
        mediaType: 'video',
        source: 'network',
        confidence: 70,
        createdAt: new Date().toISOString(),
      },
    ];
    runtimeMock.state.scanCandidates = runtimeMock.state.cacheCandidates;

    const { default: PopupApp } = await import('../../ui/popup/PopupApp');
    render(<PopupApp />);

    await waitFor(() => expect(document.querySelector('.nova-popup-expanded')).toBeTruthy());
    await waitFor(() => expect(runtimeMock.state.scanCalls).toBeGreaterThan(0));
  });
});
