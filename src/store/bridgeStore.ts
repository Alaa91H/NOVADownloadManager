import { create } from 'zustand';

interface BridgeState {
  status: 'connected' | 'connecting' | 'disconnected' | 'degraded';
  version: string;
  pid: number;
  speedLimit: number | null;
  isDegradedMode: boolean;
  setBridge: (b: {
    status: 'connected' | 'connecting' | 'disconnected' | 'degraded';
    version: string;
    pid: number;
    speedLimit: number | null;
  }) => void;
  setIsDegradedMode: (d: boolean) => void;
}

export const bridgeStore = create<BridgeState>()((set) => ({
  status: 'connecting',
  version: '',
  pid: 0,
  speedLimit: null,
  isDegradedMode: false,
  setBridge: (b) => {
    set(b);
  },
  setIsDegradedMode: (d) => {
    set({ isDegradedMode: d });
  },
}));
