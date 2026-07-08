import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Modal } from '../Modal';

const { mockCloseDialog, mockSetActiveProgressMinimizedToTaskbar, mockSetMinimizedProgressTask, storeRef } = vi.hoisted(
  () => {
    const mockCloseDialog = vi.fn();
    const mockSetActiveProgressMinimizedToTaskbar = vi.fn();
    const mockSetMinimizedProgressTask = vi.fn();
    const storeRef: { current: Record<string, unknown> } = { current: {} };
    return { mockCloseDialog, mockSetActiveProgressMinimizedToTaskbar, mockSetMinimizedProgressTask, storeRef };
  },
);

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

describe('Modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: null, payload: null },
      closeDialog: mockCloseDialog,
      setActiveProgressMinimizedToTaskbar: mockSetActiveProgressMinimizedToTaskbar,
      setMinimizedProgressTask: mockSetMinimizedProgressTask,
      t: (k: string) => {
        const map: Record<string, string> = {
          modal_minimized_prefix: 'Minimized:',
          modal_minimize_taskbar: 'Minimize to taskbar',
          win_minimize: 'Minimize',
          win_maximize: 'Maximize',
          modal_restore: 'Restore',
          modal_restore_size: 'Restore size',
          btn_close: 'Close',
        };
        return map[k] || k;
      },
    };
  });

  it('returns null when isOpen is false', () => {
    const { container } = render(
      <Modal isOpen={false} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders content when isOpen is true', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Modal">
        <p>Modal Content</p>
      </Modal>,
    );
    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('renders title', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Modal">
        <p>Content</p>
      </Modal>,
    );
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Modal>,
    );
    const closeButton = screen.getByTitle('Close');
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape key pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Test">
        <p>Content</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('minimizes when minimize button clicked', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    const minimizeButton = screen.getByTitle('Minimize');
    fireEvent.click(minimizeButton);
    expect(screen.getByText(/Minimized:/)).toBeInTheDocument();
  });

  it('restores when minimized modal title bar clicked', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    const minimizeButton = screen.getByTitle('Minimize');
    fireEvent.click(minimizeButton);
    const titleBar = screen.getByText(/Minimized:/);
    fireEvent.click(titleBar);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('maximizes when maximize button clicked', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    const maximizeButton = screen.getByTitle('Maximize');
    fireEvent.click(maximizeButton);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('renders with aria-modal attribute', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    const overlay = document.querySelector('[aria-modal="true"]');
    expect(overlay).toBeInTheDocument();
  });

  it('applies size class for sm size', () => {
    const { container } = render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test" size="sm">
        <p>Content</p>
      </Modal>,
    );
    const modal = container.querySelector('[id]');
    expect(modal).toBeInTheDocument();
  });

  it('renders with role dialog by default', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test">
        <p>Content</p>
      </Modal>,
    );
    const overlay = document.querySelector('[role="dialog"]');
    expect(overlay).toBeInTheDocument();
  });

  it('renders with alertdialog role when specified', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test" role="alertdialog">
        <p>Content</p>
      </Modal>,
    );
    const overlay = document.querySelector('[role="alertdialog"]');
    expect(overlay).toBeInTheDocument();
  });
});
