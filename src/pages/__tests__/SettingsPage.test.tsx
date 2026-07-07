import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SettingsPage } from '../SettingsPage';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    t: (k: string) => {
      const map: Record<string, string> = {
        set_control_center_title: 'Control Center',
        set_control_center_desc: 'Manage all settings',
      };
      return map[k] || k;
    },
  }),
}));

vi.mock('../../dialogs/settings/SettingsDialog', () => ({
  SettingsDialog: () => <div data-testid="settings-dialog">Settings Dialog</div>,
}));

describe('SettingsPage', () => {
  it('renders the settings title', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Control Center')).toBeInTheDocument();
  });

  it('renders the settings description', () => {
    render(<SettingsPage />);
    expect(screen.getByText('Manage all settings')).toBeInTheDocument();
  });

  it('renders the SettingsDialog component', () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
  });

  it('renders the settings icon', () => {
    const { container } = render(<SettingsPage />);
    expect(container.querySelector('.lucide-settings')).toBeInTheDocument();
  });
});
