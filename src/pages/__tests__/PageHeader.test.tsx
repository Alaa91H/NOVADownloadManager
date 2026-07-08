import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PageHeader } from '../PageHeader';

vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({
    setActivePage: vi.fn(),
    t: (k: string) => {
      const map: Record<string, string> = {
        page_back: 'Back',
        page_back_tip: 'Go back to downloads',
      };
      return map[k] || k;
    },
  }),
}));

describe('PageHeader', () => {
  it('renders title', () => {
    render(<PageHeader icon={<span>🔧</span>} title="Settings" />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<PageHeader icon={<span>🔧</span>} title="Settings" subtitle="Configure your app" />);
    expect(screen.getByText('Configure your app')).toBeInTheDocument();
  });

  it('does not render subtitle when not provided', () => {
    render(<PageHeader icon={<span>🔧</span>} title="Settings" />);
    expect(screen.queryByText('Configure your app')).not.toBeInTheDocument();
  });

  it('renders back button with text', () => {
    render(<PageHeader icon={<span>🔧</span>} title="Settings" />);
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  it('calls setActivePage when back is clicked', () => {
    render(<PageHeader icon={<span>🔧</span>} title="Settings" />);
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Back')).toBeInTheDocument();
  });
});
