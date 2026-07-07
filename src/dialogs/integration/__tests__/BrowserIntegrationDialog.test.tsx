import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { BrowserIntegrationDialog } from '../BrowserIntegrationDialog';

const {
  mockConfigureBrowserExtension,
  mockGetBrowserExtensionPaths,
  mockOpenInExplorer,
  mockOpenExternalUrl,
  mockOpenBrowserExtensions,
  storeRef,
  mockCloseDialog,
  mockUpdateSettings,
  mockAddToast,
} = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const mockUpdateSettings = vi.fn();
  const mockAddToast = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  const mockConfigureBrowserExtension = vi.fn().mockResolvedValue({
    enabled: true,
    paired: true,
    lastChecked: '2024-01-01T00:00:00Z',
    token: 'test-token',
  });
  const mockGetBrowserExtensionPaths = vi.fn().mockResolvedValue({
    devPath: '/home/user/nova/extension',
    resourcePath: '/usr/share/nova/extension',
  });
  const mockOpenInExplorer = vi.fn().mockResolvedValue(true);
  const mockOpenExternalUrl = vi.fn().mockResolvedValue(undefined);
  const mockOpenBrowserExtensions = vi.fn().mockResolvedValue(undefined);
  return {
    mockConfigureBrowserExtension,
    mockGetBrowserExtensionPaths,
    mockOpenInExplorer,
    mockOpenExternalUrl,
    mockOpenBrowserExtensions,
    storeRef,
    mockCloseDialog,
    mockUpdateSettings,
    mockAddToast,
  };
});

vi.mock('../../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

vi.mock('../../../api/tauriClient', () => ({
  tauriClient: {
    getBrowserExtensionPaths: mockGetBrowserExtensionPaths,
    openInExplorer: mockOpenInExplorer,
    openExternalUrl: mockOpenExternalUrl,
    openBrowserExtensions: mockOpenBrowserExtensions,
  },
}));

vi.mock('../../../api/novaClient', () => ({
  novaClient: {
    configureBrowserExtension: mockConfigureBrowserExtension,
  },
}));

describe('BrowserIntegrationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      closeDialog: mockCloseDialog,
      updateSettings: mockUpdateSettings,
      addToast: mockAddToast,
      settings: {
        general: {
          integrateWithBrowsers: { chrome: true, edge: true, firefox: true, safari: false },
        },
        extra: {
          browserPairingToken: 'pair-token-123',
          userAgent: 'NOVA/1.0',
        },
        saveAndCategories: {
          defaultFolder: '/downloads',
          categoryFolders: {},
        },
        fileTypes: {
          autoDownloadMaxSizeMb: 100,
        },
      },
    };
  });

  it('renders browser bridge status section', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Local Browser Bridge')).toBeInTheDocument();
  });

  it('renders Chrome/Edge section', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText(/Chrome \/ Edge/)).toBeInTheDocument();
  });

  it('renders Firefox section', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Firefox')).toBeInTheDocument();
  });

  it('renders extension downloads section', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Extension Downloads')).toBeInTheDocument();
  });

  it('renders pairing token section', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Pairing Token')).toBeInTheDocument();
  });

  it('renders pairing token value', () => {
    render(<BrowserIntegrationDialog />);
    const tokenInput = document.querySelector('[value="pair-token-123"]');
    expect(tokenInput).toBeInTheDocument();
  });

  it('renders Test button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('renders Done button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('renders Enable/Disable Browser Capture button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Disable Browser Capture')).toBeInTheDocument();
  });

  it('calls closeDialog when Done clicked', () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Done'));
    expect(mockCloseDialog).toHaveBeenCalled();
  });

  it('shows disabled text when no browsers are enabled', () => {
    storeRef.current = {
      ...storeRef.current,
      settings: {
        ...storeRef.current.settings as Record<string, unknown>,
        general: {
          integrateWithBrowsers: { chrome: false, edge: false, firefox: false, safari: false },
        },
      },
    };
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText(/Disabled in settings/)).toBeInTheDocument();
  });

  it('renders Copy Dev Chromium button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Copy Dev Chromium')).toBeInTheDocument();
  });

  it('renders Copy Dev Edge button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Copy Dev Edge')).toBeInTheDocument();
  });

  it('renders Copy Dev Firefox button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Copy Dev Firefox')).toBeInTheDocument();
  });

  it('renders Open Dev Folder button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Open Dev Folder')).toBeInTheDocument();
  });

  it('opens dev folder when button clicked', async () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Open Dev Folder'));
    await waitFor(() => {
      expect(mockOpenInExplorer).toHaveBeenCalledWith('/home/user/nova/extension');
    });
    expect(mockAddToast).toHaveBeenCalledWith('success', 'Extension Folder', expect.any(String));
  });

  it('renders Download from GitHub Releases button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Download from GitHub Releases')).toBeInTheDocument();
  });

  it('renders Copy Link button', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Copy Link')).toBeInTheDocument();
  });

  it('renders Chrome and Edge browser buttons', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Chrome')).toBeInTheDocument();
    expect(screen.getByText('Edge')).toBeInTheDocument();
  });

  it('renders Open button for Firefox', () => {
    render(<BrowserIntegrationDialog />);
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('opens Chrome extensions page when Chrome button clicked', async () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Chrome'));
    await waitFor(() => {
      expect(mockOpenBrowserExtensions).toHaveBeenCalledWith('chrome');
    });
  });

  it('opens Edge extensions page when Edge button clicked', async () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Edge'));
    await waitFor(() => {
      expect(mockOpenBrowserExtensions).toHaveBeenCalledWith('edge');
    });
  });

  it('opens Firefox extensions page when Open button clicked', async () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(mockOpenBrowserExtensions).toHaveBeenCalledWith('firefox');
    });
  });

  it('opens releases page when Download button clicked', async () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Download from GitHub Releases'));
    await waitFor(() => {
      expect(mockOpenExternalUrl).toHaveBeenCalledWith('https://github.com/Alaa91H/NovaDownloadManager/releases/latest');
    });
  });

  it('disables Test button while checking', async () => {
    mockConfigureBrowserExtension.mockImplementationOnce(() => new Promise(() => {}));
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Test'));
    await waitFor(() => {
      expect(screen.getByText('Test').closest('button')).toBeDisabled();
    });
  });

  it('shows ready toast on successful bridge configure', async () => {
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Test'));
    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith('success', 'Browser Bridge', expect.any(String));
    });
  });

  it('shows error toast when configure bridge fails', async () => {
    mockConfigureBrowserExtension.mockRejectedValueOnce(new Error('Connection refused'));
    render(<BrowserIntegrationDialog />);
    fireEvent.click(screen.getByText('Test'));
    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith('error', 'Browser Bridge', 'Connection refused');
    });
  });
});
