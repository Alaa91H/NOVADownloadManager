import { vi } from 'vitest';

export function mockTauriWindow() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {
      invoke: vi.fn(),
    },
    writable: true,
  });
}

export function mockFetch(response?: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(response ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}
