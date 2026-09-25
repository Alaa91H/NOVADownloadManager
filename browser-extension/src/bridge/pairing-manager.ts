import { NOVA_PROTOCOL_VERSION, PairRequestSchema, PairResponseSchema, type PairResponse } from '../contracts/nova.protocol.v4';
import { TransportManager } from '../transport/transport-manager';

/**
 * Handles the zero-click trusted-local pairing handshake between the browser
 * extension and NOVA.
 *
 * Pairing is intentionally Native-Messaging-only. Loopback HTTP can still be
 * used after authentication, but it is never allowed to mint a bearer token
 * directly from browser-controlled headers.
 */
export class PairingManager {
  constructor(private readonly tm: TransportManager) {}

  async pair(extensionOrigin: string): Promise<PairResponse> {
    const request = PairRequestSchema.parse({
      clientId: crypto.randomUUID(),
      protocolVersion: NOVA_PROTOCOL_VERSION,
      extensionOrigin,
      trustedLocalOnly: true,
      mode: 'trusted-local-native-host',
      requireLocalhost: true,
      allowUserPrompt: false,
      silent: true,
      zeroClick: true,
    });

    try {
      return await this.tm.requestNative('auth.pair', request, PairResponseSchema);
    } catch (nativeError) {
      throw new Error(
        'NOVA pairing requires the registered native messaging host. ' +
          'Ensure the desktop app and native host are installed and repair browser integration if needed.',
        { cause: nativeError },
      );
    }
  }
}
