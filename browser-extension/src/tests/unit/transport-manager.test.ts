import { afterEach, describe, expect, it, vi } from 'vitest';

const mockNativeAvailable = vi.fn();
const mockHttpAvailable = vi.fn();

vi.mock('../../transport/native-transport', () => ({
  NativeTransport: class {
    isAvailable = mockNativeAvailable;
  },
}));

vi.mock('../../transport/http-transport', () => ({
  HttpTransport: class {
    isAvailable = mockHttpAvailable;
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

  it('discovers mixed transport when both native and http are available', async () => {
    mockNativeAvailable.mockResolvedValue(true);
    mockHttpAvailable.mockResolvedValue(true);
    const tm = new TransportManager();
    const result = await tm.discover();
    expect(result.transport).toBe('mixed');
    expect(result.native).toBe(true);
    expect(result.http).toBe(true);
  });

  it('discovers native-only when http is unavailable', async () => {
    mockNativeAvailable.mockResolvedValue(true);
    mockHttpAvailable.mockResolvedValue(false);
    const tm = new TransportManager();
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
    const tm = new TransportManager();
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
