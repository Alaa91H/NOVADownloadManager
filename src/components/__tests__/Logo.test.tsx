import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../assets/logo.png', () => ({ default: 'mocked-logo-path' }));
vi.mock('../../state/appStore', () => ({
  useAppStore: () => ({ t: (k: string) => ({ logo_alt: 'NOVA Logo' }[k] || k) }),
}));

import { Logo } from '../Logo';

describe('Logo', () => {
  it('renders image with alt text', () => {
    render(<Logo />);
    const img = screen.getByAltText('NOVA Logo');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'mocked-logo-path');
  });

  it('applies custom className', () => {
    render(<Logo className="custom-class" />);
    const img = screen.getByAltText('NOVA Logo');
    expect(img.className).toContain('custom-class');
  });

  it('uses custom size', () => {
    render(<Logo size={48} />);
    const img = screen.getByAltText('NOVA Logo');
    expect(img).toHaveAttribute('width', '48');
    expect(img).toHaveAttribute('height', '48');
  });
});
