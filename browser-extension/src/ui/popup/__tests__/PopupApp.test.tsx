import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

// Mock i18n
vi.mock('../../i18n/react', () => ({
  useI18n: () => ({ t: (k: string) => (k === 'taskActions.scan' ? 'Scan' : k) }),
}));

// Mock runtime requests used by the popup
vi.mock('../../ui/runtime-request', () => ({
  runtimeRequest: (msg: Record<string, any>) => {
    if (msg.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: true });
    if (msg.type === 'GET_CANDIDATES') return Promise.resolve([]);
    if (msg.type === 'SCAN_PAGE') return Promise.resolve({ candidates: [] });
    return Promise.resolve({});
  },
  messageFromError: (e: unknown) => String(e),
}));

describe('PopupApp (collapsed behaviour)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('renders collapsed mini header when no candidates present', async () => {
    const { default: PopupApp } = await import('../PopupApp');
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan' })).toBeTruthy());
  });

  it('expands when candidates are returned', async () => {
    // Re-mock runtimeRequest to return a candidate list
    vi.doMock('../../ui/runtime-request', () => ({
      runtimeRequest: (msg: Record<string, any>) => {
        if (msg.type === 'GET_BRIDGE_STATE') return Promise.resolve({ canSend: true });
        if (msg.type === 'GET_CANDIDATES') return Promise.resolve([{ id: 'c1', url: 'https://x', mediaType: 'video' }]);
        return Promise.resolve({});
      },
      messageFromError: (e: unknown) => String(e),
    }));
    const { default: PopupApp } = await import('../PopupApp');
    const { container } = render(<PopupApp />);
    await waitFor(() => expect(container.querySelector('.nova-mini-count-badge')).toBeTruthy());
  });
});
