import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

vi.mock('../../store/selectors', () => ({
  useSidebarCounts: () => ({}),
  useNavigationData: () => ({ activePage: 'downloads', workspaceView: 'all' }),
  useNavigationActions: () => ({ setActivePage: vi.fn(), setWorkspaceView: vi.fn() }),
  useBridgeData: () => ({ status: 'disconnected', version: '', pid: 0, speedLimit: null }),
  useThemeData: () => ({ theme: 'dark', density: 'compact', accent: 'blue', progress: 'bar', contrast: 'normal' }),
  useSettingsActions: () => ({ updateSettings: vi.fn(), updateThemeSettings: vi.fn() }),
  useDialogActions: () => ({ openDialog: vi.fn() }),
  useDialogData: () => ({ active: null, payload: null }),
  useI18n: () => (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
}));

import { Sidebar } from '../Sidebar';

describe('Sidebar', () => {
  it('renders all_downloads button', () => {
    render(<Sidebar />);
    expect(screen.getByText('All Downloads')).toBeInTheDocument();
  });

  it('renders download categories section', () => {
    render(<Sidebar />);
    expect(screen.getByText(/Categories/i)).toBeInTheDocument();
  });

  it('renders theme customization controls', () => {
    render(<Sidebar />);
    expect(screen.getAllByText('Theme').length).toBeGreaterThan(0);
  });
});
