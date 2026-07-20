import { NOVA_PROTOCOL_VERSION, PairRequestSchema, PairResponseSchema, type PairResponse } from '../contracts/nova.protocol.v4';
import { TransportManager } from '../transport/transport-manager';

/**
 * Handles the zero-click trusted-local pairing handshake between the browser
 * extension and the NOVA desktop daemon.
 *
 * The daemon (src-tauri/src/daemon/routes/extension.rs :: handle_v1_pair_auto)
 * verifies that the request originates from a trusted local source and issues
 * a bearer token that subsequent API calls use for authentication. This class
 * builds the pairing request, validates the response, and surfaces clear
 * diagnostic errors when pairing fails.
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
      return await this.tm.requestHttp('/v1/pair/auto', request, PairResponseSchema);
    } catch (error) {
      // Wrap transport failures with enough context to surface actionable
      // guidance ("is the desktop app running?") instead of a bare network
      // error. The bridge manager treats pairing failure as recoverable and
      // retries on the next connect attempt.
      const message = error instanceof Error ? error.message : 'Pairing failed.';
      throw new Error(
        `NOVA pairing failed: ${message}. Ensure the desktop app is running and ` +
          'the native messaging host is installed.',
        { cause: error },
      );
    }
  }
}
