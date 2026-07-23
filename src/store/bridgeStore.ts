import { create } from 'zustand';

export type BridgeStatus = 'connected' | 'connecting' | 'disconnected' | 'degraded';

interface BridgeState {
  status: BridgeStatus;
  version: string;
  pid: number;
  speedLimit: number | null;
  setBridge: (b: { status: BridgeStatus; version: string; pid: number; speedLimit: number | null }) => void;
  /** Derived: true when status === 'degraded'. Kept as a property for selector
   *  ergonomics, but always set atomically with status to prevent drift. */
  isDegradedMode: boolean;
  setIsDegradedMode: (d: boolean) => void;
}

export const bridgeStore = create<BridgeState>()((set) => ({
  status: 'connecting',
  version: '',
  pid: 0,
  speedLimit: null,
  isDegradedMode: false,
  setBridge: (b) => {
    // Set status and derived isDegradedMode atomically so they can never drift.
    set({ ...b, isDegradedMode: b.status === 'degraded' });
  },
  setIsDegradedMode: (d) => {
    set({ isDegradedMode: d });
  },
}));
