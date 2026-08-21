import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriClient } from '../tauriClient';

describe('tauriClient updater configuration', () => {
  const invoke = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    (window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = { invoke };
  });

  it('reports a clear unavailable state instead of invoking an unconfigured signed updater', async () => {
    invoke.mockImplementation((command: string) => {
      if (command === 'get_version') return Promise.resolve('2.4.8-alpha');
      if (command === 'get_updater_configuration_status') {
        return Promise.resolve({
          configured: false,
          message: 'Signed in-app updates are not configured for this build. Use the official release page instead.',
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await tauriClient.checkTauriUpdate();

    expect(result).toEqual({
      hasUpdate: false,
      currentVersion: '2.4.8-alpha',
      latestVersion: '2.4.8-alpha',
      unavailableMessage:
        'Signed in-app updates are not configured for this build. Use the official release page instead.',
    });
    expect(invoke).toHaveBeenCalledWith('get_version', undefined);
    expect(invoke).toHaveBeenCalledWith('get_updater_configuration_status', undefined);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
