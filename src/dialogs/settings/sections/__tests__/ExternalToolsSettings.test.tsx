import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listExternalTools: vi.fn(),
  discoverExternalTool: vi.fn(),
  checkExternalToolHealth: vi.fn(),
  checkExternalToolUpdates: vi.fn(),
  installExternalTool: vi.fn(),
  updateExternalTool: vi.fn(),
  setExternalToolPath: vi.fn(),
  uninstallExternalTool: vi.fn(),
}));

vi.mock('../../../../api/novaClient', () => ({ novaClient: api }));

import { ExternalToolsSettings } from '../ExternalToolsSettings';

const tool = {
  id: 'yt-dlp',
  name: 'yt-dlp',
  status: 'Not Installed',
  capabilities: [],
  healthOk: false,
  installedByApp: false,
  customPath: false,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('ExternalToolsSettings', () => {
  const onAddToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    api.listExternalTools.mockResolvedValue({ tools: [tool] });
    api.discoverExternalTool.mockResolvedValue({ ok: false });
    api.checkExternalToolHealth.mockResolvedValue({ ok: false, status: 'Not Installed' });
    api.checkExternalToolUpdates.mockResolvedValue({ available: false });
    api.installExternalTool.mockResolvedValue({ ok: true, path: '/tools/yt-dlp' });
    api.updateExternalTool.mockResolvedValue({ ok: true });
    api.setExternalToolPath.mockResolvedValue({ ok: true });
    api.uninstallExternalTool.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('marks an install as busy and blocks competing actions until activation completes', async () => {
    const install = deferred<{ ok: boolean; path: string }>();
    api.installExternalTool.mockReturnValueOnce(install.promise);

    render(<ExternalToolsSettings onAddToast={onAddToast} />);
    await screen.findByText('yt-dlp');

    fireEvent.click(screen.getByRole('button', { name: 'Install for Current User' }));

    expect(api.installExternalTool).toHaveBeenCalledWith('yt-dlp', 'user');
    expect(screen.getByRole('button', { name: 'Discover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check Updates' })).toBeDisabled();
    expect(screen.getByText('yt-dlp').closest('[aria-busy="true"]')).not.toBeNull();

    install.resolve({ ok: true, path: '/tools/yt-dlp' });

    await waitFor(() => {
      expect(onAddToast).toHaveBeenCalledWith(
        'success',
        'Install verified',
        'yt-dlp was downloaded, verified, and activated at /tools/yt-dlp.',
      );
    });
  });

  it('reports a provider update-check failure instead of incorrectly claiming the tool is up to date', async () => {
    api.checkExternalToolUpdates.mockResolvedValue({
      available: false,
      error: 'GitHub API returned HTTP 403. GitHub API rate limit is exhausted.',
    });

    render(<ExternalToolsSettings onAddToast={onAddToast} />);
    await screen.findByText('yt-dlp');

    fireEvent.click(screen.getByRole('button', { name: 'Check Updates' }));

    await waitFor(() => {
      expect(onAddToast).toHaveBeenCalledWith(
        'error',
        'Updates',
        'GitHub API returned HTTP 403. GitHub API rate limit is exhausted.',
      );
    });
    expect(onAddToast).not.toHaveBeenCalledWith('success', 'Updates', 'yt-dlp is up to date.');
  });
});
