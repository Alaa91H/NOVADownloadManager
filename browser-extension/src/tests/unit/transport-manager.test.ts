import { afterEach, describe, expect, it, vi } from 'vitest';

const mockNativeAvailable = vi.fn();
const mockHttpAvailable = vi.fn();
const mockHttpPingDefault = vi.fn();

vi.mock('../../transport/native-transport', () => ({
  NativeTransport: class {
    isAvailable = mockNativeAvailable;
  },
}));

vi.mock('../../transport/http-transport', () => ({
  HttpTransport: class {
    isAvailable = mockHttpAvailable;
    pingDefault = mockHttpPingDefault;
    url = (path: string) => `http://127.0.0.1:3199${path}`;
    request = vi.fn();
  },
}));

vi.mock('../../transport/sse-transport', () => ({
  SseTransport: class {
    close = vi.fn();
    connectFirst = vi.fn();
  },
}));

vi.mock('../../transport/websocket-transport', () => ({
  WebSocketTransport: class {
    close = vi.fn();
  },
}));

import { TransportManager } from '../../transport/transport-manager';

describe('TransportManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the http fast path without probing native when the daemon answers', async () => {
    mockNativeAvailable.mockResolvedValue(true);
    mockHttpAvailable.mockResolvedValue(true);
    const tm = new TransportManager();
    const result = await tm.discover();
    expect(result.transport).toBe('http');
    expect(result.http).toBe(true);
    // The whole point of the fast path: never pay the native-host spawn
    // cost when the daemon is already reachable over loopback HTTP.
    expect(mockNativeAvailable).not.toHaveBeenCalled();
  });

  it('discovers mixed transport when native wakes the desktop daemon', async () => {
    mockNativeAvailable.mockResolvedValue(true);
    // Daemon down for the initial probe, then up after the native wake.
    mockHttpAvailable.mockResolvedValueOnce(false).mockResolvedValue(true);
    mockHttpPingDefault.mockResolvedValue(true);
    const tm = new TransportManager();
    tm.nativeWakeProbeMs = 1_000;
    const result = await tm.discover();
    expect(result.transport).toBe('mixed');
    expect(result.native).toBe(true);
    expect(result.http).toBe(true);
  });

  it('discovers native-only when http stays unavailable after the wake window', async () => {
    mockNativeAvailable.mockResolvedValue(true);
    mockHttpAvailable.mockResolvedValue(false);
    mockHttpPingDefault.mockResolvedValue(false);
    const tm = new TransportManager();
    tm.nativeWakeProbeMs = 0;
    const result = await tm.discover();
    expect(result.transport).toBe('native');
  });

  it('discovers http-only when native is unavailable', async () => {
    mockNativeAvailable.mockResolvedValue(false);
    mockHttpAvailable.mockResolvedValue(true);
    const tm = new TransportManager();
    const result = await tm.discover();
    expect(result.transport).toBe('http');
  });

  it('discovers null when nothing is available', async () => {
    mockNativeAvailable.mockResolvedValue(false);
    mockHttpAvailable.mockResolvedValue(false);
    mockHttpPingDefault.mockResolvedValue(false);
    const tm = new TransportManager();
    tm.nativeWakeProbeMs = 0;
    const result = await tm.discover();
    expect(result.transport).toBeNull();
  });

  it('closeEvents closes both SSE and WebSocket', () => {
    const tm = new TransportManager();
    const sseClose = vi.spyOn(tm.sse, 'close');
    const wsClose = vi.spyOn(tm.websocket, 'close');
    tm.closeEvents();
    expect(sseClose).toHaveBeenCalled();
    expect(wsClose).toHaveBeenCalled();
  });
});
