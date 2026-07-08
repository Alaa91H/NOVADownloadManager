import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ContextMenu } from '../primitives/ContextMenu';
import type { ContextMenuOption } from '../primitives/ContextMenu';

const defaultOptions: ContextMenuOption[] = [
  { id: 'resume', label: 'Resume', onClick: vi.fn() },
  { id: 'pause', label: 'Pause', onClick: vi.fn() },
  { id: 'delete', label: 'Delete', danger: true, onClick: vi.fn() },
];

function renderMenu(options = defaultOptions, onClose = vi.fn()) {
  return render(<ContextMenu x={100} y={200} options={options} onClose={onClose} />);
}

describe('ContextMenu', () => {
  it('renders all options', () => {
    renderMenu();
    expect(screen.getByText('Resume')).toBeInTheDocument();
    expect(screen.getByText('Pause')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls onClick and onClose when option clicked', () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    renderMenu([{ id: 'test', label: 'Test', onClick }], onClose);
    fireEvent.click(screen.getByText('Test'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    renderMenu(defaultOptions, onClose);
    const backdrop = document.querySelector('.fixed.inset-0');
    expect(backdrop).toBeInTheDocument();
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledOnce();
    }
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    renderMenu(defaultOptions, onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not call onClick for disabled options', () => {
    const onClick = vi.fn();
    renderMenu([{ id: 'disabled', label: 'Disabled Option', disabled: true, onClick }]);
    const btn = screen.getByText('Disabled Option').closest('button');
    expect(btn).toBeDefined();
    if (btn) {
      expect(btn.className).toContain('opacity-40');
      fireEvent.click(btn);
    }
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows disabled reason as tooltip', () => {
    renderMenu([
      {
        id: 'disabled',
        label: 'Disabled Option',
        disabled: true,
        disabledReason: 'Engine not ready',
        onClick: vi.fn(),
      },
    ]);
    const btn = screen.getByText('Disabled Option').closest('button');
    expect(btn).toHaveAttribute('title', 'Engine not ready');
  });

  it('renders icon when provided', () => {
    const icon = <span data-testid="test-icon">I</span>;
    renderMenu([{ id: 'with-icon', label: 'With Icon', icon, onClick: vi.fn() }]);
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('applies danger styling for danger options', () => {
    renderMenu([{ id: 'danger', label: 'Danger Item', danger: true, onClick: vi.fn() }]);
    const btn = screen.getByText('Danger Item').closest('button');
    expect(btn?.className).toContain('text-red-400');
  });

  it('renders non-danger options with default color', () => {
    renderMenu([{ id: 'normal', label: 'Normal Item', onClick: vi.fn() }]);
    const btn = screen.getByText('Normal Item').closest('button');
    expect(btn?.className).toContain('text-[var(--text-primary)]');
  });

  it('positions menu at given coordinates', () => {
    render(<ContextMenu x={50} y={100} options={[{ id: 'a', label: 'A', onClick: vi.fn() }]} onClose={vi.fn()} />);
    const menu = screen.getByText('A').closest('div[style]');
    expect(menu).toBeInTheDocument();
  });

  it('cleans up event listeners on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = renderMenu(defaultOptions, onClose);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when clicking inside the menu', () => {
    const onClose = vi.fn();
    renderMenu(defaultOptions, onClose);
    const menuItem = screen.getByText('Resume');
    fireEvent.mouseDown(menuItem);
    expect(onClose).not.toHaveBeenCalled();
  });
});
