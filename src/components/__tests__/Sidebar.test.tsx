import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { createMockStore } from '../../test/mockStore';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));

vi.mock('../../state/appStore', () => ({
  useAppStore: () => createMockStore(),
}));

import { Sidebar } from '../Sidebar';

describe('Sidebar', () => {
  it('renders all_downloads button', () => {
    render(<Sidebar />);
    expect(screen.getByText('all_downloads')).toBeInTheDocument();
  });

  it('renders download categories section', () => {
    render(<Sidebar />);
    expect(screen.getByText('categories')).toBeInTheDocument();
  });

  it('renders theme customization controls', () => {
    render(<Sidebar />);
    expect(screen.getByText('theme')).toBeInTheDocument();
  });
});
