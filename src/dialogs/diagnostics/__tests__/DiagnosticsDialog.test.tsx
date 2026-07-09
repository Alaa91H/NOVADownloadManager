import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeRef, mockCloseDialog, mockGetDiagnostics, mockDiagnosticData } = vi.hoisted(() => {
  const mockCloseDialog = vi.fn();
  const storeRef: { current: Record<string, unknown> } = { current: {} };
  const mockDiagnosticData = {
    cpuUsage: 23,
    memoryUsageMb: 512,
    diskFreeGb: 128,
    osName: 'Linux 6.8',
    daemonVersion: '0.2.0',
    rustTarget: 'x86_64-unknown-linux-gnu',
    sqliteVersion: '3.43.0',
    activeThreads: 8,
    networkInterfaces: [
      'eth0=192.168.1.100',
      { name: 'wlan0', ip: '10.0.0.5', speedMbps: 300 },
    ],
    engineCapabilities: { curl: true, ytDlp: false },
  };
  const mockGetDiagnostics = vi.fn().mockResolvedValue(mockDiagnosticData);
  return { storeRef, mockCloseDialog, mockGetDiagnostics, mockDiagnosticData };
});

vi.mock('../../../state/appStore', () => ({
  useAppStore: () => storeRef.current,
}));

vi.mock('../../../api/tauriClient', () => ({
  tauriClient: {
    getDiagnostics: mockGetDiagnostics,
  },
}));

import { DiagnosticsDialog } from '../DiagnosticsDialog';

describe('DiagnosticsDialog', () => {
  const diagT = (k: string) => {
    const map: Record<string, string> = {
      diag_loading: 'Generating live diagnostics...',
      diag_cpu: 'Service CPU Usage',
      diag_memory: 'Memory Usage',
      diag_memory_desc: 'Allocated runtime memory',
      diag_disk: 'Free Disk Space',
      diag_disk_desc: 'Default system drive',
      diag_system_details: 'System Details',
      diag_os: 'Operating System',
      diag_service_version: 'Service Version',
      diag_runtime_target: 'Runtime Target',
      diag_sqlite: 'SQLite',
      diag_active_connections: 'Active Connections',
      diag_active: 'active',
      diag_network_interfaces: 'Network Interfaces',
      diag_engine_capabilities: 'Runtime Engine Capabilities',
      diag_engine_caps_desc: 'Live data reported by curl, yt-dlp, and FFmpeg at runtime. Unsupported options are excluded from execution.',
      diag_success: 'Diagnostics were collected successfully.',
      diag_refresh_desc: 'Report refreshed through the local service diagnostics API.',
      diag_refresh_btn: 'Refresh Report',
      diag_close_report: 'Close Report',
    };
    return map[k] || k;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storeRef.current = {
      closeDialog: mockCloseDialog,
      t: diagT,
    };
  });

  it('shows loading state initially', () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    expect(screen.getByText(/Generating live diagnostics/)).toBeInTheDocument();
  });

  it('renders diagnostic data after loading', async () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('23%')).toBeInTheDocument();
    });
    expect(screen.getByText('512 MB')).toBeInTheDocument();
    expect(screen.getByText('128 GB')).toBeInTheDocument();
    expect(screen.getByText('Linux 6.8')).toBeInTheDocument();
    expect(screen.getByText('0.2.0')).toBeInTheDocument();
    expect(screen.getByText('8 active')).toBeInTheDocument();
  });

  it('renders network interfaces', async () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('eth0')).toBeInTheDocument();
    });
    expect(screen.getByText('192.168.1.100')).toBeInTheDocument();
    expect(screen.getByText('wlan0')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
    expect(screen.getByText('300 Mbps')).toBeInTheDocument();
  });

  it('renders engine capabilities when present', async () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('Runtime Engine Capabilities')).toBeInTheDocument();
    });
  });

  it('renders success indicator after loading', async () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText(/Diagnostics were collected successfully/)).toBeInTheDocument();
    });
  });

  it('closes report when close button clicked', async () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('Close Report')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Close Report'));
  });

  it('refreshes diagnostic data when Refresh Report clicked', async () => {
    mockGetDiagnostics.mockResolvedValueOnce(mockDiagnosticData);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('23%')).toBeInTheDocument();
    });
    mockGetDiagnostics.mockResolvedValueOnce({ ...mockDiagnosticData, cpuUsage: 45 });
    fireEvent.click(screen.getByText('Refresh Report'));
    await waitFor(() => {
      expect(screen.getByText('45%')).toBeInTheDocument();
    });
  });

  it('renders without engine capabilities section when not present', async () => {
    const dataWithoutCaps = { ...mockDiagnosticData, engineCapabilities: undefined };
    mockGetDiagnostics.mockResolvedValueOnce(dataWithoutCaps);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.queryByText('Runtime Engine Capabilities')).not.toBeInTheDocument();
    });
  });

  it('handles empty network interfaces gracefully', async () => {
    const dataNoNet = { ...mockDiagnosticData, networkInterfaces: [] };
    mockGetDiagnostics.mockResolvedValueOnce(dataNoNet);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('Network Interfaces')).toBeInTheDocument();
    });
  });

  it('handles structured network interface objects', async () => {
    const dataStructured = {
      ...mockDiagnosticData,
      networkInterfaces: [
        { name: 'eth0', ip: '10.0.0.1', speedMbps: 1000 },
      ],
    };
    mockGetDiagnostics.mockResolvedValueOnce(dataStructured);
    render(<DiagnosticsDialog />);
    await waitFor(() => {
      expect(screen.getByText('eth0')).toBeInTheDocument();
    });
    expect(screen.getByText('1000 Mbps')).toBeInTheDocument();
  });
});
