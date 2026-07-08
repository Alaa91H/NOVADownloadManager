import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenericConfirmDialog } from '../common/GenericConfirmDialog';

const { mockCloseDialog, storeRef } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { mockCloseDialog, storeRef };
});

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

describe('GenericConfirmDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      dialog: { active: 'genericConfirm', payload: { message: 'Are you sure?', onConfirm: vi.fn() } },
      closeDialog: mockCloseDialog,
      t: (k: string) => {
        const map: Record<string, string> = {
          btn_confirm: 'Confirm',
          btn_cancel: 'Cancel',
        };
        return map[k] || k;
      },
    };
  });

  it('renders the message', () => {
    render(<GenericConfirmDialog />);
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('renders confirm button', () => {
    render(<GenericConfirmDialog />);
    expect(screen.getByText('Confirm')).toBeInTheDocument();
  });

  it('renders cancel button', () => {
    render(<GenericConfirmDialog />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onConfirm and closeDialog when confirm clicked', () => {
    const onConfirm = vi.fn();
    storeRef.current = {
      dialog: { active: 'genericConfirm', payload: { message: 'Test', onConfirm } },
      closeDialog: mockCloseDialog,
      t: (k: string) => {
        const map: Record<string, string> = { btn_confirm: 'Confirm', btn_cancel: 'Cancel' };
        return map[k] || k;
      },
    };
    render(<GenericConfirmDialog />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalled();
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('closes dialog when cancel clicked', () => {
    render(<GenericConfirmDialog />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('handles missing onConfirm gracefully', () => {
    storeRef.current = {
      dialog: { active: 'genericConfirm', payload: { message: 'Test' } },
      closeDialog: mockCloseDialog,
      t: (k: string) => {
        const map: Record<string, string> = { btn_confirm: 'Confirm', btn_cancel: 'Cancel' };
        return map[k] || k;
      },
    };
    render(<GenericConfirmDialog />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows danger styling when isDanger is true', () => {
    storeRef.current = {
      dialog: {
        active: 'genericConfirm',
        payload: { message: 'Delete everything?', isDanger: true, onConfirm: vi.fn() },
      },
      closeDialog: mockCloseDialog,
      t: (k: string) => {
        const map: Record<string, string> = { btn_confirm: 'Confirm', btn_cancel: 'Cancel' };
        return map[k] || k;
      },
    };
    const { container } = render(<GenericConfirmDialog />);
    const iconContainer = container.querySelector('.bg-red-500\\/10');
    expect(iconContainer).toBeInTheDocument();
  });

  it('shows info styling when isDanger is false', () => {
    storeRef.current = {
      dialog: { active: 'genericConfirm', payload: { message: 'Info message', isDanger: false, onConfirm: vi.fn() } },
      closeDialog: mockCloseDialog,
      t: (k: string) => {
        const map: Record<string, string> = { btn_confirm: 'Confirm', btn_cancel: 'Cancel' };
        return map[k] || k;
      },
    };
    const { container } = render(<GenericConfirmDialog />);
    const iconContainer = container.querySelector('.bg-blue-500\\/10');
    expect(iconContainer).toBeInTheDocument();
  });
});
