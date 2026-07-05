import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { createMockStore } from '../../test/mockStore';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    close: vi.fn(),
    show: vi.fn(),
    setFocus: vi.fn(),
    hide: vi.fn(),
  }),
}));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn().mockResolvedValue('') }));

vi.mock('../../state/appStore', () => ({
  useAppStore: () => createMockStore(),
}));

import { AppShell } from '../AppShell';

describe('AppShell', () => {
  it('renders the app title', () => {
    render(<AppShell />);
    expect(screen.getByText('NOVA Download Manager')).toBeInTheDocument();
  });
});
