import { describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {},
    storage: {},
  },
}));

import { PairingManager } from '../../bridge/pairing-manager';

const successfulPair = {
  ok: true as const,
  pairToken: '0123456789abcdef0123456789abcdef',
  autoApproved: true,
  method: 'native-host-secret-proof',
  protocolVersion: 4,
  minimumSupportedProtocolVersion: 4,
};

describe('PairingManager native-only policy', () => {
  it('pairs through Native Messaging when the trusted host is available', async () => {
    const transport = {
      requestNative: vi.fn().mockResolvedValue(successfulPair),
      requestHttp: vi.fn(),
    };
    const manager = new PairingManager(transport as never);

    await expect(
      manager.pair('chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej'),
    ).resolves.toEqual(successfulPair);

    expect(transport.requestNative).toHaveBeenCalledTimes(1);
    expect(transport.requestHttp).not.toHaveBeenCalled();
  });

  it('never falls back to direct HTTP pairing when Native Messaging is unavailable', async () => {
    const transport = {
      requestNative: vi.fn().mockRejectedValue(new Error('native host missing')),
      requestHttp: vi.fn(),
    };
    const manager = new PairingManager(transport as never);

    await expect(
      manager.pair('chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej'),
    ).rejects.toThrow('requires the registered native messaging host');

    expect(transport.requestNative).toHaveBeenCalledTimes(1);
    expect(transport.requestHttp).not.toHaveBeenCalled();
  });

  it('uses the same native-only policy for Firefox profile-local origins', async () => {
    const transport = {
      requestNative: vi.fn().mockRejectedValue(new Error('native host missing')),
      requestHttp: vi.fn(),
    };
    const manager = new PairingManager(transport as never);

    await expect(
      manager.pair('moz-extension://profile-local-uuid'),
    ).rejects.toThrow('requires the registered native messaging host');

    expect(transport.requestHttp).not.toHaveBeenCalled();
  });
});
