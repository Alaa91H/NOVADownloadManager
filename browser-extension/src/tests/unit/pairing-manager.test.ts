import { describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {},
    storage: {},
  },
}));

import { canUseHttpAutoPairFallback, PairingManager } from '../../bridge/pairing-manager';

const successfulPair = {
  ok: true as const,
  pairToken: '0123456789abcdef0123456789abcdef',
  autoApproved: true,
  method: 'origin-or-native-host-verified',
  protocolVersion: 4,
  minimumSupportedProtocolVersion: 4,
};

describe('PairingManager HTTP fallback policy', () => {
  it('allows the compatibility fallback only for Chromium extension origins', () => {
    expect(canUseHttpAutoPairFallback('chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej')).toBe(true);
    expect(canUseHttpAutoPairFallback('moz-extension://profile-local-uuid')).toBe(false);
    expect(canUseHttpAutoPairFallback('https://example.test')).toBe(false);
    expect(canUseHttpAutoPairFallback('not a URL')).toBe(false);
  });

  it('does not send Firefox pairing through HTTP when native messaging is unavailable', async () => {
    const transport = {
      requestNative: vi.fn().mockRejectedValue(new Error('native host missing')),
      requestHttp: vi.fn(),
    };
    const manager = new PairingManager(transport as never);

    await expect(manager.pair('moz-extension://profile-local-uuid')).rejects.toThrow(
      'requires the registered native messaging host',
    );

    expect(transport.requestNative).toHaveBeenCalledTimes(1);
    expect(transport.requestHttp).not.toHaveBeenCalled();
  });

  it('keeps the pinned Chromium fallback available after native messaging fails', async () => {
    const transport = {
      requestNative: vi.fn().mockRejectedValue(new Error('native host missing')),
      requestHttp: vi.fn().mockResolvedValue(successfulPair),
    };
    const manager = new PairingManager(transport as never);

    await expect(manager.pair('chrome-extension://jplpcjabfbfnmdoofcjchikfcmfbdiej')).resolves.toEqual(successfulPair);
    expect(transport.requestHttp).toHaveBeenCalledWith('/v1/pair/auto', expect.any(Object), expect.any(Object));
  });
});
