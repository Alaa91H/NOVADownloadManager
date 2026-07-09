import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AboutDialog } from '../system/AboutDialog';

const { mockCloseDialog, storeRef } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  return { mockCloseDialog, storeRef };
});

vi.mock('../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

describe('AboutDialog', () => {
  const aboutT = (k: string) => {
    const map: Record<string, string> = {
      app_name: 'NOVA Download Manager',
      about_local_service: 'Local download service',
      about_description: 'NOVA is a desktop download manager for direct files, media, queues, scheduling, browser capture, and local automation.',
      about_service_label: 'Service',
      about_open_source_license: 'Open Source License',
      about_copyright: 'Copyright (c) 2026 NOVA.',
      btn_ok: 'OK',
    };
    return map[k] || k;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      closeDialog: mockCloseDialog,
      bridge: { version: 'v0.1.0' },
      t: aboutT,
    };
  });

  it('renders app name', () => {
    render(<AboutDialog />);
    expect(screen.getByText('NOVA Download Manager')).toBeInTheDocument();
  });

  it('renders description', () => {
    render(<AboutDialog />);
    expect(screen.getByText(/NOVA is a desktop download manager/)).toBeInTheDocument();
  });

  it('renders service version', () => {
    render(<AboutDialog />);
    expect(screen.getByText(/Service v0.1.0/)).toBeInTheDocument();
  });

  it('renders open source license text', () => {
    render(<AboutDialog />);
    expect(screen.getByText('Open Source License')).toBeInTheDocument();
  });

  it('renders OK button', () => {
    render(<AboutDialog />);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('closes dialog when OK clicked', () => {
    render(<AboutDialog />);
    fireEvent.click(screen.getByText('OK'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('renders fallback version when bridge version is missing', () => {
    storeRef.current = {
      closeDialog: mockCloseDialog,
      bridge: {},
      t: aboutT,
    };
    render(<AboutDialog />);
    expect(screen.getByText(/Service v0.1.0/)).toBeInTheDocument();
  });

  it('renders copyright notice', () => {
    render(<AboutDialog />);
    expect(screen.getByText(/Copyright/)).toBeInTheDocument();
  });
});
