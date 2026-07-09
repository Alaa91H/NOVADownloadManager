import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeRef, mockCloseDialog, mockUpdateSettings, mockAddToast, mockConfigureBrowserExtension, mockGetBrowserExtensionPaths, mockOpenInExplorer, mockOpenExternalUrl, mockOpenBrowserExtensions } = vi.hoisted(() => {
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
  return { storeRef, mockCloseDialog, mockUpdateSettings, mockAddToast, mockConfigureBrowserExtension, mockGetBrowserExtensionPaths, mockOpenInExplorer, mockOpenExternalUrl, mockOpenBrowserExtensions };
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

import { BrowserIntegrationDialog } from '../BrowserIntegrationDialog';

describe('BrowserIntegrationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigureBrowserExtension.mockResolvedValue({
      enabled: true,
      paired: true,
      lastChecked: '2024-01-01T00:00:00Z',
      token: 'test-token',
    });
    mockGetBrowserExtensionPaths.mockResolvedValue({
      devPath: '/home/user/nova/extension',
      resourcePath: '/usr/share/nova/extension',
    });
    mockOpenInExplorer.mockResolvedValue(true);
    mockOpenExternalUrl.mockResolvedValue(undefined);
    mockOpenBrowserExtensions.mockResolvedValue(undefined);
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
      t: (k: string) => {
        const map: Record<string, string> = {
          brw_bridge_title: 'Local Browser Bridge',
          brw_chrome_edge: 'Chrome / Edge',
          brw_firefox: 'Firefox',
          brw_btn_open: 'Open',
          brw_chrome: 'Chrome',
          brw_edge: 'Edge',
          brw_extension_downloads: 'Extension Downloads',
          brw_download_gh: 'Download from GitHub Releases',
          brw_copy_link: 'Copy Link',
          brw_open_dev_folder: 'Open Dev Folder',
          brw_copy_dev_chromium: 'Copy Dev Chromium',
          brw_copy_dev_edge: 'Copy Dev Edge',
          brw_copy_dev_firefox: 'Copy Dev Firefox',
          brw_pairing_token: 'Pairing Token',
          brw_btn_test: 'Test',
          brw_done: 'Done',
          brw_disable_capture: 'Disable Browser Capture',
          brw_enable_capture: 'Enable Browser Capture',
          brw_status_disabled_settings: 'Disabled in settings',
          brw_status_enabled_settings: 'Enabled in settings',
          brw_firefox_desc: 'Open debugging extensions, load a temporary add-on, then select the manifest from the NOVA Firefox folder.',
          brw_chrome_desc: 'Open the extensions page, enable developer mode, then load the unpacked NOVA Chromium or Edge folder.',
          brw_extension_desc: 'The browser extension packages are published as standalone files with every NOVA release: a Chrome/Chromium .zip, an Edge .zip, and a Firefox .xpi. Download the package for your browser, then load it from the extensions page.',
          brw_toast_bridge_ready: 'The local browser bridge is ready.',
          brw_toast_bridge_unreachable: 'The local browser bridge is not reachable.',
          brw_toast_token_copied: 'The browser pairing token was copied.',
          brw_toast_path_copied: 'The extension folder path was copied.',
          brw_toast_folder_opened: 'The browser extension folder was opened.',
          brw_toast_folder_failed: 'NOVA could not open the browser extension folder.',
          brw_toast_releases_opened: 'Opened the NOVA releases page for extension downloads.',
          brw_toast_browser_opened: 'Opened {browser} extension management.',
          brw_toast_browser_failed: 'Could not open {browser} extension page.',
          brw_toast_token_manual: 'Select the token manually if clipboard write is blocked.',
          brw_toast_path_manual: 'Select the path manually if clipboard write is blocked.',
        };
        return map[k] || k;
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
    await waitFor(() => {
      expect(mockGetBrowserExtensionPaths).toHaveBeenCalled();
    });
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
