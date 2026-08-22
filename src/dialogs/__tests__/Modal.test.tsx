import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../store/selectors', () => ({
  useI18n: () => (key: string) => (key === 'btn_close' ? 'Close dialog' : key),
}));

import { Modal } from '../Modal';

describe('Modal accessibility', () => {
  it('places dialog semantics on the focusable dialog and exposes its title and close action', () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Download details" id="download-details">
        <p>Transfer details</p>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Download details' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'download-details-title');
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
    expect(screen.getByText('Download details')).toHaveAttribute('dir', 'auto');
  });

  it('keeps keyboard focus inside the dialog from the initial dialog container', () => {
    render(
      <Modal isOpen onClose={vi.fn()} title="Keyboard controls">
        <button type="button">Continue</button>
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Keyboard controls' });
    const closeButton = screen.getByRole('button', { name: 'Close dialog' });
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(continueButton).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Tab' });
    expect(closeButton).toHaveFocus();
  });
});
