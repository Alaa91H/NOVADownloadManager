import { BridgeState, BridgeStateSchema, initialBridgeState } from '../core/app-state';
import { StorageRepository } from './storage-repository';

export class StateStore {
  private readonly repo = new StorageRepository('nova.bridgeState', BridgeStateSchema, { fallback: initialBridgeState });

  async getBridgeState(): Promise<BridgeState> {
    return this.repo.get();
  }

  async setBridgeState(s: BridgeState): Promise<void> {
    await this.repo.set(s);
  }
}
