import { vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// localStorage mock — Node 26 without --localstorage-file leaves
// globalThis.localStorage undefined; jsdom should provide it but the
// shim sometimes leaks.  Always install a working in-memory polyfill.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    get length() { return storage.size; },
    key: (index: number) => [...storage.keys()][index] ?? null,
  },
  writable: true,
  configurable: true,
});

// Match media
Object.defineProperty(window, 'matchMedia', {
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ResizeObserver
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
window.ResizeObserver = ResizeObserverMock;

// IntersectionObserver
class IntersectionObserverMock {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn();
}
window.IntersectionObserver = IntersectionObserverMock;

// scrollTo
window.scrollTo = vi.fn();

// Notification
Object.defineProperty(window, 'Notification', {
  value: vi.fn().mockImplementation(() => ({})),
  writable: true,
});

// __TAURI__
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: vi.fn(),
};
